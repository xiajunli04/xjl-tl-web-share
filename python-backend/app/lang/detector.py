"""语种识别（design D3）：限定 15 种语种的 lingua 检测器 + LLM 兜底。"""

import asyncio
import logging
import re
import threading
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from lingua import LanguageDetector as LinguaDetector
from lingua import LanguageDetectorBuilder

from app.core.config import Settings
from app.core.errors import BizException, ErrorCode
from app.lang.languages import BY_LINGUA, CODES, LANGUAGES
from app.llm.base import ChatMessage, ChatRequest, LLMClient, LLMError, Usage
from app.llm.json_mode import json_mode_extra, parse_json_object

log = logging.getLogger("app.lang.detector")

MAX_DETECT_CHARS = 2000  # 只取前 2000 个字符识别，足够判断语种
CANDIDATE_COUNT = 3
LLM_DETECT_MAX_TOKENS = 64

LlmProvider = Callable[[], Awaitable[LLMClient]]

_DETECT_SYSTEM = (
    "你是语种识别器。判断用户消息中文本所属的语种，只能从以下 ISO 639-1 代码中选择："
    + ", ".join(CODES)
    + '。只输出 JSON，格式为 {"lang": "代码", "confidence": 0 到 1 之间的小数}，不要输出其他内容。'
)
_CODE_RE = re.compile(r"\b(" + "|".join(CODES) + r")\b")


@dataclass
class DetectResult:
    lang: str
    confidence: float
    method: str  # "lingua" | "llm"
    candidates: list[tuple[str, float]] = field(default_factory=list)
    usage: Usage | None = None  # 仅 LLM 兜底时有

    def to_vo(self) -> dict[str, Any]:
        return {
            "lang": self.lang,
            "confidence": self.confidence,
            "method": self.method,
            "candidates": [{"lang": c, "confidence": v} for c, v in self.candidates],
        }


_lingua: LinguaDetector | None = None
_lingua_lock = threading.Lock()


def _get_lingua(low_accuracy: bool) -> LinguaDetector:
    """进程内单例。"""
    global _lingua
    if _lingua is None:
        with _lingua_lock:
            if _lingua is None:
                builder = LanguageDetectorBuilder.from_languages(*(lang.lingua for lang in LANGUAGES))
                builder = builder.with_preloaded_language_models()
                if low_accuracy:
                    builder = builder.with_low_accuracy_mode()
                _lingua = builder.build()
    return _lingua


class LanguageDetector:
    def __init__(self, settings: Settings):
        self._settings = settings

    def warmup(self) -> None:
        _get_lingua(self._settings.lang_detect_low_accuracy).compute_language_confidence_values("warm up")

    def lingua_candidates(self, text: str) -> list[tuple[str, float]]:
        """返回按置信度降序的前 3 个候选（置信度为 0 的不返回）。"""
        values = _get_lingua(self._settings.lang_detect_low_accuracy).compute_language_confidence_values(
            text[:MAX_DETECT_CHARS]
        )
        result = []
        for v in values[:CANDIDATE_COUNT]:
            if v.value > 0 and v.language in BY_LINGUA:
                result.append((BY_LINGUA[v.language].code, round(v.value, 4)))
        return result

    async def detect(self, text: str, llm_provider: LlmProvider | None = None) -> DetectResult:
        stripped = (text or "").strip()
        if not stripped:
            raise BizException(ErrorCode.PARAM_INVALID, "文本不能为空")
        candidates = await asyncio.to_thread(self.lingua_candidates, stripped)
        top = candidates[0] if candidates else None
        need_llm = (
            top is None
            or top[1] < self._settings.lang_detect_min_confidence
            or len(stripped) < self._settings.lang_detect_min_chars
        )
        if need_llm and llm_provider is not None:
            try:
                return await self._detect_by_llm(stripped, candidates, llm_provider)
            except (LLMError, BizException) as e:
                log.warning("语种识别 LLM 兜底失败，回退到 lingua 结果: %s", getattr(e, "message", e))
        if top is None:
            raise BizException(ErrorCode.PARAM_INVALID, "无法识别文本语种，请手动指定源语言")
        return DetectResult(lang=top[0], confidence=top[1], method="lingua", candidates=candidates)

    async def _detect_by_llm(
        self, text: str, candidates: list[tuple[str, float]], llm_provider: LlmProvider
    ) -> DetectResult:
        client = await llm_provider()
        res = await client.chat(
            ChatRequest(
                messages=[
                    ChatMessage(role="system", content=_DETECT_SYSTEM),
                    ChatMessage(role="user", content=text[:MAX_DETECT_CHARS]),
                ],
                temperature=0,
                max_tokens=LLM_DETECT_MAX_TOKENS,
                extra=json_mode_extra(client),
            )
        )
        lang, confidence = _parse_llm_detect(res.content)
        if lang is None:
            raise BizException(ErrorCode.PARAM_INVALID, "LLM 未返回可识别的语种代码")
        if confidence is None:
            confidence = dict(candidates).get(lang, 0.5)
        return DetectResult(
            lang=lang, confidence=round(confidence, 4), method="llm", candidates=candidates, usage=res.usage
        )


def _parse_llm_detect(content: str) -> tuple[str | None, float | None]:
    obj = parse_json_object(content)
    lang: str | None = None
    confidence: float | None = None
    if obj is not None:
        raw = str(obj.get("lang", "")).strip().lower()
        lang = raw if raw in CODES else None
        try:
            c = float(obj.get("confidence"))
            confidence = c if 0 <= c <= 1 else None
        except (TypeError, ValueError):
            confidence = None
    if lang is None:
        m = _CODE_RE.search((content or "").lower())
        lang = m.group(1) if m else None
    return lang, confidence
