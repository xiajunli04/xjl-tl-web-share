"""图片翻译管线（design D10，契约 docs/contracts/speech-image-api.md §1.5）。

vision 引擎：ocr（视觉模型一次调用，像素 bbox，JSON 模式）→ terms（术语匹配，命中为硬约束）
→ translate（一次调用批量翻译编号 JSON，整图文字为上下文）→ render（bbox 还原到原图并归一化 0–1）。
qwen-mt-image 引擎：translate（百炼一次调用返回译图）→ render。

两个管线都是异步生成器，逐个产出 (event, data)：node、blocks、translation、done；
异常原样抛出，由 SSE 层转为 error 事件（OCR 两次都解析失败为 C0171）。
"""

import asyncio
import base64
import logging
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import Field, field_validator

from app.agent.state import add_usage
from app.core.config import Settings
from app.core.errors import BizException, ErrorCode
from app.core.schema import CamelModel
from app.glossary.matcher import GlossaryMatcher, TermHit, select_glossaries, term_present
from app.glossary.repository import Glossary, GlossaryRepository
from app.image import prompts
from app.image.preprocess import PreparedImage, restore_bbox
from app.image.qwen_mt_image import translate_image
from app.lang import languages
from app.lang.detector import LanguageDetector
from app.lang.languages import AUTO, CODES, display_name
from app.llm.base import ChatRequest, LLMClient, Usage
from app.llm.json_mode import json_mode_extra, parse_json_object
from app.llm.registry import ResolvedModel
from app.repositories.model_config import ModelConfig

log = logging.getLogger("app.image.pipeline")

VISION = "vision"
QWEN_MT_IMAGE = "qwen-mt-image"
OCR_ATTEMPTS = 2  # 非法 JSON 重试一次
TRANSLATE_ATTEMPTS = 2
MAX_BLOCKS = 200
MAX_TERMS_FOR_QWEN = 50

Event = tuple[str, dict[str, Any]]


class ImageTranslateRequest(CamelModel):
    """POST /internal/image/translate 的请求体（契约 §1.5）。"""

    request_id: str | None = Field(default=None, max_length=64)
    user_id: int | None = None
    image_base64: str
    mime: str | None = Field(default=None, max_length=32)
    source_lang: str = AUTO
    target_lang: str
    engine: Literal["vision", "qwen-mt-image"] = VISION
    model_config_id: int | None = Field(default=None, ge=1)
    glossary_ids: list[int] = Field(default_factory=list)

    @field_validator("glossary_ids", mode="before")
    @classmethod
    def _none_to_empty(cls, v: Any) -> Any:
        return [] if v is None else v

    def check(self) -> None:
        if self.source_lang != AUTO and not languages.is_supported(self.source_lang):
            raise BizException(ErrorCode.UNSUPPORTED_LANGUAGE, f"不支持的源语言: {self.source_lang}")
        if not languages.is_supported(self.target_lang):
            raise BizException(ErrorCode.UNSUPPORTED_LANGUAGE, f"不支持的目标语言: {self.target_lang}")
        if self.source_lang == self.target_lang:
            raise BizException(ErrorCode.PARAM_INVALID, "源语言与目标语言不能相同")


@dataclass
class ImageDeps:
    settings: Settings
    glossary_repo: GlossaryRepository
    detector: LanguageDetector | None = None
    matcher: GlossaryMatcher = field(default_factory=GlossaryMatcher)


@dataclass
class Block:
    id: int
    text: str
    bbox: list[float]  # 原图归一化坐标
    translation: str | None = None

    def to_vo(self, with_translation: bool = False) -> dict[str, Any]:
        vo: dict[str, Any] = {"id": self.id, "text": self.text}
        if with_translation:
            vo["translation"] = self.translation or ""
        vo["bbox"] = self.bbox
        return vo


@dataclass
class OcrResult:
    lang: str | None
    blocks: list[Block]
    usage: Usage
    dropped: int = 0  # bbox 非法或文本为空而丢弃的块数


class _Run:
    """node 事件编号、轨迹与 usage 累计（node 事件格式与文本翻译流相同）。"""

    def __init__(self) -> None:
        self.seq = 0
        self.trace: list[dict[str, Any]] = []
        self.usage = Usage()
        self.start = time.perf_counter()

    def _node(self, data: dict[str, Any]) -> Event:
        self.seq += 1
        return "node", {"seq": self.seq, **data}

    def started(self, node: str) -> Event:
        return self._node({"node": node, "status": "started"})

    def completed(self, node: str, summary: str, latency_ms: int) -> Event:
        data = {"node": node, "status": "completed", "summary": summary, "latencyMs": latency_ms}
        self.trace.append(dict(data))
        return self._node(data)

    def skipped(self, node: str, summary: str) -> Event:
        data = {"node": node, "status": "skipped", "summary": summary}
        self.trace.append(dict(data))
        return self._node(data)

    def add_usage(self, usage: Usage | None) -> None:
        if usage is not None:
            self.usage = Usage(
                self.usage.prompt_tokens + usage.prompt_tokens,
                self.usage.completion_tokens + usage.completion_tokens,
            )

    @property
    def usage_vo(self) -> dict[str, int]:
        return {"promptTokens": self.usage.prompt_tokens, "completionTokens": self.usage.completion_tokens}

    @property
    def latency_ms(self) -> int:
        return int((time.perf_counter() - self.start) * 1000)


def _ms(start: float) -> int:
    return int((time.perf_counter() - start) * 1000)


def normalize_lang(raw: Any) -> str | None:
    """模型返回的语种代码规范化：zh-CN / zh-Hans → zh，粤语 yue → zh（契约 §0）；不在 15 语种内时为 None。"""
    if not isinstance(raw, str) or not raw.strip():
        return None
    code = raw.strip().lower().replace("_", "-").split("-")[0]
    if code == "yue":
        code = "zh"
    return code if code in CODES else None


# ---------------- ocr ----------------


def parse_ocr(content: str | None, image: PreparedImage) -> OcrResult | None:
    """解析 OCR JSON；结构不合法（非对象、blocks 不是数组）时返回 None，单个块不合法时丢弃该块。"""
    obj = parse_json_object(content)
    if obj is None or not isinstance(obj.get("blocks"), list):
        return None
    blocks: list[Block] = []
    dropped = 0
    for item in obj["blocks"]:
        if not isinstance(item, dict):
            dropped += 1
            continue
        text = str(item.get("text") or "").strip()
        bbox = restore_bbox(item.get("bbox"), image)
        if not text or bbox is None:
            dropped += 1
            continue
        if len(blocks) >= MAX_BLOCKS:
            dropped += 1
            continue
        blocks.append(Block(id=len(blocks) + 1, text=text, bbox=bbox))
    return OcrResult(lang=normalize_lang(obj.get("lang")), blocks=blocks, usage=Usage(), dropped=dropped)


async def run_ocr(llm: LLMClient, image: PreparedImage, settings: Settings) -> OcrResult:
    """视觉模型一次调用识别文字与像素 bbox；非法 JSON 时重试一次，仍失败抛出 C0171。"""
    usage = Usage()
    for attempt in range(1, OCR_ATTEMPTS + 1):
        res = await llm.chat(
            ChatRequest(
                messages=prompts.ocr_messages(image.data_url, image.width, image.height),
                max_tokens=settings.image_ocr_max_tokens,
                timeout=settings.image_llm_timeout_seconds,
                extra=json_mode_extra(llm),
            )
        )
        usage = add_usage(usage, res.usage)
        result = parse_ocr(res.content, image)
        if result is not None:
            result.usage = usage
            if result.dropped:
                log.info("OCR 丢弃 %d 个无效文本块", result.dropped)
            return result
        log.warning("OCR 结果不是合法 JSON（第 %d 次）：%s", attempt, (res.content or "")[:200])
    raise BizException(ErrorCode.OCR_PARSE_FAILED)


async def detect_lang(ocr: OcrResult, deps: ImageDeps) -> str | None:
    """图片文字语种：优先采用视觉模型的判断（它能看到字形），否则用 lingua 识别拼接后的文本。"""
    if ocr.lang:
        return ocr.lang
    if not ocr.blocks or deps.detector is None:
        return None
    text = "\n".join(b.text for b in ocr.blocks)
    try:
        candidates = await asyncio.to_thread(deps.detector.lingua_candidates, text)
    except Exception:  # noqa: BLE001 - 语种识别失败不影响翻译
        log.warning("图片文字语种识别失败", exc_info=True)
        return None
    return candidates[0][0] if candidates else None


# ---------------- terms ----------------


@dataclass
class TermMatch:
    hits: list[TermHit]  # 去重后的命中术语（翻译提示词中的硬约束）
    block_ids: dict[tuple[str, str], list[int]]  # (source, target) → 命中的块 id
    summary: str


async def match_terms(
    blocks: list[Block], glossary_ids: list[int], source_lang: str | None, target_lang: str, deps: ImageDeps
) -> TermMatch:
    """逐块做术语匹配（便于记录命中块），汇总为整图的命中列表。"""
    if not glossary_ids:
        return TermMatch([], {}, "未选择术语库")
    loaded = await deps.glossary_repo.load(glossary_ids)
    selection = select_glossaries(glossary_ids, loaded, source_lang or "", target_lang)
    hits: dict[tuple[str, str], TermHit] = {}
    block_ids: dict[tuple[str, str], list[int]] = {}
    for block in blocks:
        for hit in deps.matcher.match(block.text, selection.usable):
            key = (hit.source, hit.target)
            hits.setdefault(key, hit)
            block_ids.setdefault(key, []).append(block.id)
    parts = [f"命中 {len(hits)} 条术语" if hits else "未命中术语"]
    if selection.mismatched:
        parts.append(f"跳过 {len(selection.mismatched)} 个语言对不符的术语库")
    if selection.unavailable:
        parts.append(f"{len(selection.unavailable)} 个术语库不存在或已删除")
    return TermMatch(list(hits.values()), block_ids, "，".join(parts))


def term_hits_vo(match: TermMatch, blocks: list[Block]) -> list[dict[str, Any]]:
    """契约 done.termHits：每条术语在所有命中块的译文中都出现才算 followed。"""
    by_id = {b.id: b for b in blocks}
    result = []
    for hit in match.hits:
        ids = match.block_ids.get((hit.source, hit.target), [])
        followed = all(term_present(hit.target, by_id[i].translation or "", hit.case_sensitive) for i in ids)
        result.append({"source": hit.source, "target": hit.target, "followed": followed, "blockIds": ids})
    return result


# ---------------- translate ----------------


def parse_translations(content: str | None) -> dict[int, str] | None:
    obj = parse_json_object(content)
    items = obj.get("translations") if obj is not None else None
    if not isinstance(items, list):
        return None
    result: dict[int, str] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        try:
            bid = int(item.get("id"))
        except (TypeError, ValueError):
            continue
        text = item.get("text")
        if isinstance(text, str):
            result[bid] = text.strip()
    return result


async def run_translate(
    llm: LLMClient,
    blocks: list[Block],
    source_lang: str | None,
    target_lang: str,
    terms: list[TermHit],
    settings: Settings,
    temperature: float | None,
) -> tuple[int, Usage]:
    """一次调用批量翻译全部块，结果写入 block.translation；返回未返回译文（以原文兜底）的块数与 usage。"""
    usage = Usage()
    ids = {b.id for b in blocks}
    parsed: dict[int, str] | None = None
    for attempt in range(1, TRANSLATE_ATTEMPTS + 1):
        res = await llm.chat(
            ChatRequest(
                messages=prompts.translate_messages([(b.id, b.text) for b in blocks], source_lang, target_lang, terms),
                temperature=temperature,
                max_tokens=settings.image_translate_max_tokens,
                timeout=settings.image_llm_timeout_seconds,
                extra=json_mode_extra(llm),
            )
        )
        usage = add_usage(usage, res.usage)
        parsed = parse_translations(res.content)
        if parsed is not None and ids & parsed.keys():
            break
        log.warning("批量译文不是合法 JSON（第 %d 次）：%s", attempt, (res.content or "")[:200])
        parsed = None
    if parsed is None:
        raise BizException(ErrorCode.AGENT_FAILED, "译文结果解析失败")
    missing = 0
    for b in blocks:
        text = parsed.get(b.id)
        if not text:
            missing += 1
            text = b.text
        b.translation = text
    return missing, usage


# ---------------- vision 管线 ----------------


async def run_vision(
    req: ImageTranslateRequest, image: PreparedImage, resolved: ResolvedModel, deps: ImageDeps
) -> AsyncIterator[Event]:
    run = _Run()
    llm = resolved.client
    settings = deps.settings

    yield run.started("ocr")
    t = time.perf_counter()
    ocr = await run_ocr(llm, image, settings)
    run.add_usage(ocr.usage)
    detected = await detect_lang(ocr, deps)
    blocks = ocr.blocks
    if blocks:
        lang_note = f"（{display_name(detected)}）" if detected else ""
        summary = f"识别到 {len(blocks)} 个文本块{lang_note}"
    else:
        summary = "未识别到文字"
    yield run.completed("ocr", summary, _ms(t))
    yield (
        "blocks",
        {
            "width": image.orig_width,
            "height": image.orig_height,
            "detectedLang": detected,
            "blocks": [b.to_vo() for b in blocks],
        },
    )

    match = TermMatch([], {}, "未识别到文字")
    if not blocks:
        # 无文字：后续节点跳过，以 blocks 为空正常完成
        for node in ("terms", "translate", "render"):
            yield run.skipped(node, "未识别到文字")
    else:
        source_lang = req.source_lang if req.source_lang != AUTO else detected
        t = time.perf_counter()
        match = await match_terms(blocks, req.glossary_ids, source_lang, req.target_lang, deps)
        yield run.completed("terms", match.summary, _ms(t))

        yield run.started("translate")
        t = time.perf_counter()
        temperature = resolved.params.get("temperature")
        missing, usage = await run_translate(
            llm,
            blocks,
            source_lang,
            req.target_lang,
            match.hits,
            settings,
            float(temperature) if temperature is not None else None,
        )
        run.add_usage(usage)
        summary = f"已翻译 {len(blocks) - missing} 块"
        if missing:
            summary += f"，{missing} 块未返回译文（保留原文）"
        yield run.completed("translate", summary, _ms(t))
        yield "translation", {"blocks": [b.to_vo(with_translation=True) for b in blocks]}

        t = time.perf_counter()
        yield run.completed("render", "坐标已归一化", _ms(t))

    yield (
        "done",
        {
            "detectedLang": detected,
            "blocks": [b.to_vo(with_translation=True) for b in blocks],
            "termHits": term_hits_vo(match, blocks),
            "trace": run.trace,
            "usage": run.usage_vo,
            "latencyMs": run.latency_ms,
            "modelConfigId": resolved.config.id,
            "resultImageBase64": None,
        },
    )


# ---------------- qwen-mt-image 管线 ----------------


async def glossary_pairs(req: ImageTranslateRequest, deps: ImageDeps) -> list[tuple[str, str]]:
    """qwen-mt-image 的术语干预（ext.terminologies）：只在指定源语言时传入语言对一致的术语库术语。"""
    if not req.glossary_ids or req.source_lang == AUTO:
        return []
    loaded: dict[int, Glossary] = await deps.glossary_repo.load(req.glossary_ids)
    selection = select_glossaries(req.glossary_ids, loaded, req.source_lang, req.target_lang)
    pairs = [(t.source_term, t.target_term) for g in selection.usable for t in g.terms if t.source_term.strip()]
    return pairs[:MAX_TERMS_FOR_QWEN]


async def run_qwen_mt_image(
    req: ImageTranslateRequest, image: PreparedImage, cfg: ModelConfig, api_key: str, deps: ImageDeps
) -> AsyncIterator[Event]:
    run = _Run()
    yield run.started("translate")
    t = time.perf_counter()
    terms = await glossary_pairs(req, deps)
    result = await translate_image(
        cfg,
        api_key,
        image.data,
        image.mime,
        req.source_lang,
        req.target_lang,
        terms=terms,
        timeout=deps.settings.image_llm_timeout_seconds,
    )
    summary = "已生成译图" + (f"（术语 {len(terms)} 条）" if terms else "")
    yield run.completed("translate", summary, _ms(t))
    t = time.perf_counter()
    encoded = base64.b64encode(result.image).decode("ascii")
    yield run.completed("render", f"译图 {result.width}×{result.height}", _ms(t))
    yield (
        "done",
        {
            "detectedLang": None,
            "blocks": [],
            "termHits": [],
            "trace": run.trace,
            "usage": run.usage_vo,
            "latencyMs": run.latency_ms,
            "modelConfigId": cfg.id,
            "resultImageBase64": encoded,
        },
    )
