"""译文解读（design D11，契约 §1.6 / §1.7）。

- get_insights：一次 JSON 调用，返回 alternatives[2..3]、expressions[≤5]、summary、usage；非法 JSON 重试一次
- ask_events：针对译文的中文追问，流式产出 delta，最后 done（含 usage）；问答不落库、不改动译文
"""

import contextlib
import logging
from collections.abc import AsyncIterator
from typing import Any

from pydantic import Field, field_validator

from app.agent.state import add_usage
from app.core.errors import BizException, ErrorCode
from app.core.schema import CamelModel
from app.insights import prompts
from app.lang import languages
from app.lang.languages import AUTO
from app.llm.base import ChatRequest, LLMClient, Usage
from app.llm.json_mode import json_mode_extra, parse_json_object

log = logging.getLogger("app.insights")

MAX_ALTERNATIVES = 3
MIN_ALTERNATIVES = 2
MAX_EXPRESSIONS = 5
MAX_HISTORY = 6
MAX_QUESTION_CHARS = 500
INSIGHTS_ATTEMPTS = 2

# 模型偶尔给出列表之外的语体描述，按常见说法归并；无法归并的记为"中性"
_REGISTER_ALIASES = {
    "formal": "正式",
    "neutral": "中性",
    "informal": "口语",
    "colloquial": "口语",
    "casual": "口语",
    "written": "书面",
    "literary": "文学",
    "非正式": "口语",
    "日常": "口语",
    "通俗": "口语",
    "书面语": "书面",
    "文艺": "文学",
    "诗意": "文学",
    "口语化": "口语",
}


class InsightsRequest(CamelModel):
    source: str
    translation: str
    source_lang: str = AUTO
    target_lang: str
    model_config_id: int | None = Field(default=None, ge=1)

    def check(self, max_chars: int) -> None:
        if not self.source.strip():
            raise BizException(ErrorCode.PARAM_INVALID, "原文不能为空")
        if not self.translation.strip():
            raise BizException(ErrorCode.PARAM_INVALID, "译文不能为空")
        if len(self.source) > max_chars:
            raise BizException(ErrorCode.PARAM_INVALID, f"原文超过 {max_chars} 字符，无法解读")
        if self.source_lang != AUTO and not languages.is_supported(self.source_lang):
            raise BizException(ErrorCode.UNSUPPORTED_LANGUAGE, f"不支持的源语言: {self.source_lang}")
        if not languages.is_supported(self.target_lang):
            raise BizException(ErrorCode.UNSUPPORTED_LANGUAGE, f"不支持的目标语言: {self.target_lang}")


class AskTurn(CamelModel):
    q: str = Field(max_length=MAX_QUESTION_CHARS * 4)
    a: str = Field(max_length=8000)


class AskRequest(InsightsRequest):
    question: str = Field(max_length=MAX_QUESTION_CHARS)
    history: list[AskTurn] = Field(default_factory=list, max_length=MAX_HISTORY)

    @field_validator("history", mode="before")
    @classmethod
    def _none_to_empty(cls, v: Any) -> Any:
        return [] if v is None else v

    def check(self, max_chars: int) -> None:
        super().check(max_chars)
        if not self.question.strip():
            raise BizException(ErrorCode.PARAM_INVALID, "问题不能为空")


def usage_vo(usage: Usage) -> dict[str, int]:
    return {"promptTokens": usage.prompt_tokens, "completionTokens": usage.completion_tokens}


def normalize_register(raw: Any) -> str:
    s = str(raw or "").strip()
    if s in prompts.REGISTERS:
        return s
    alias = _REGISTER_ALIASES.get(s.lower()) or _REGISTER_ALIASES.get(s)
    if alias:
        return alias
    for r in prompts.REGISTERS:  # 如"偏正式"、"中性偏口语"：取首个出现的标准语体
        if r in s:
            return r
    return "中性"


def _s(v: Any) -> str:
    return str(v).strip() if v is not None else ""


def parse_insights(content: str | None, translation: str) -> dict[str, Any] | None:
    """解析并规整解读 JSON；结构不合法或有效备选不足 2 个时返回 None（调用方重试）。"""
    obj = parse_json_object(content)
    if obj is None or not isinstance(obj.get("alternatives"), list):
        return None
    current = translation.strip()
    seen = {current}
    alternatives = []
    for item in obj["alternatives"]:
        if not isinstance(item, dict):
            continue
        text = _s(item.get("text"))
        if not text or text in seen:  # 去掉与当前译文相同或重复的备选
            continue
        seen.add(text)
        register = normalize_register(item.get("register"))
        alternatives.append({"text": text, "register": register, "note": _s(item.get("note"))})
    if len(alternatives) < MIN_ALTERNATIVES:
        return None
    expressions = []
    for item in obj.get("expressions") or []:
        if not isinstance(item, dict) or not _s(item.get("source")):
            continue
        expressions.append(
            {
                "source": _s(item.get("source")),
                "target": _s(item.get("target")),
                "meaning": _s(item.get("meaning")),
                "note": _s(item.get("note")),
            }
        )
    return {
        "alternatives": alternatives[:MAX_ALTERNATIVES],
        "expressions": expressions[:MAX_EXPRESSIONS],
        "summary": _s(obj.get("summary")),
    }


async def get_insights(llm: LLMClient, req: InsightsRequest, max_tokens: int) -> dict[str, Any]:
    usage = Usage()
    messages = prompts.insights_messages(req.source, req.translation, req.source_lang, req.target_lang)
    for attempt in range(1, INSIGHTS_ATTEMPTS + 1):
        res = await llm.chat(ChatRequest(messages=messages, max_tokens=max_tokens, extra=json_mode_extra(llm)))
        usage = add_usage(usage, res.usage)
        data = parse_insights(res.content, req.translation)
        if data is not None:
            return {**data, "usage": usage_vo(usage)}
        log.warning("解读结果不合法（第 %d 次）：%s", attempt, (res.content or "")[:200])
    raise BizException(ErrorCode.AGENT_FAILED, "解读结果解析失败")


async def ask_events(llm: LLMClient, req: AskRequest, max_tokens: int) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    """流式答疑：每个增量一个 delta 事件，最后 done（含 usage）。异常原样抛出，由 SSE 层转为 error。"""
    messages = prompts.ask_messages(
        req.source,
        req.translation,
        req.source_lang,
        req.target_lang,
        req.question.strip(),
        [(t.q, t.a) for t in req.history],
    )
    usage = Usage()
    async with contextlib.aclosing(llm.stream(ChatRequest(messages=messages, max_tokens=max_tokens))) as stream:
        async for chunk in stream:
            if chunk.delta:
                yield "delta", {"text": chunk.delta}
            if chunk.done and chunk.usage is not None:
                usage = chunk.usage
    yield "done", {"usage": usage_vo(usage)}
