"""文档翻译的 LLM 调用辅助：JSON 模式调用、按段落 id 解析输出、执行错误。"""

import logging
from typing import Any

from pydantic import ValidationError

from app.core.errors import BizException, ErrorCode
from app.doc.state import DocDeps
from app.llm.base import ChatMessage, ChatRequest, LLMClient, LLMError, Usage
from app.llm.json_mode import json_mode_extra, parse_json_object

log = logging.getLogger("app.doc")


class DocTaskError(Exception):
    """文档任务自身的执行错误（如补译后仍缺段），映射为 C0150，可重试。"""

    def __init__(self, message: str, retryable: bool = True):
        super().__init__(message)
        self.error_code = ErrorCode.DOC_TASK_FAILED
        self.message = message
        self.retryable = retryable


def failure_payload(exc: BaseException) -> dict[str, Any]:
    """failed 事件的 data：{code, message, retryable}。"""
    if isinstance(exc, LLMError):
        return {"code": exc.error_code.code, "message": exc.message, "retryable": True}
    if isinstance(exc, DocTaskError):
        return {"code": exc.error_code.code, "message": exc.message, "retryable": exc.retryable}
    if isinstance(exc, ValidationError):
        return {"code": ErrorCode.PARAM_INVALID.code, "message": "任务参数校验失败", "retryable": False}
    if isinstance(exc, BizException):
        # 参数类错误（A04xx）重试也不会成功；模型配置停用等（C01xx）修复后可以重试
        return {"code": exc.error.code, "message": exc.message, "retryable": not exc.error.code.startswith("A")}
    log.error("文档任务执行异常: %s", type(exc).__name__, exc_info=exc)
    return {"code": ErrorCode.DOC_TASK_FAILED.code, "message": ErrorCode.DOC_TASK_FAILED.message, "retryable": True}


async def call_json(
    deps: DocDeps,
    messages: list[ChatMessage],
    *,
    max_tokens: int | None = None,
    temperature: float | None = None,
    client: LLMClient | None = None,
) -> tuple[dict[str, Any] | None, Usage]:
    """client 为空时使用译者模型（deps.llm）；评审调用传入评审模型的客户端。"""
    llm = client or deps.llm
    res = await llm.chat(
        ChatRequest(
            messages=messages,
            temperature=deps.temperature if temperature is None else temperature,
            max_tokens=max_tokens or deps.settings.doc_translate_max_tokens,
            timeout=deps.settings.doc_llm_timeout_seconds,
            extra=json_mode_extra(llm),
        )
    )
    obj = parse_json_object(res.content)
    if obj is None:
        log.warning("LLM 输出无法解析为 JSON: %.200r", res.content)
    return obj, res.usage


def parse_segments(obj: dict[str, Any] | None) -> dict[int, str]:
    """解析 {"segments":[{"id":seq,"text":...}]}；容忍 id 为字符串、segments 为 {id: text} 映射。空译文视为缺失。"""
    out: dict[int, str] = {}
    if not obj:
        return out
    items = obj.get("segments")
    if isinstance(items, dict):
        items = [{"id": k, "text": v} for k, v in items.items()]
    if not isinstance(items, list):
        return out
    for item in items:
        if not isinstance(item, dict):
            continue
        text = item.get("text", item.get("translation"))
        try:
            seq = int(item.get("id"))
        except (TypeError, ValueError):
            continue
        if isinstance(text, str) and text.strip() and seq not in out:
            out[seq] = text
    return out


def parse_pairs(raw: Any, keys: tuple[str, str] = ("source", "target")) -> list[tuple[str, str]]:
    pairs = []
    if not isinstance(raw, list):
        return pairs
    for item in raw:
        if not isinstance(item, dict):
            continue
        a, b = str(item.get(keys[0]) or "").strip(), str(item.get(keys[1]) or "").strip()
        if a and b:
            pairs.append((a, b))
    return pairs
