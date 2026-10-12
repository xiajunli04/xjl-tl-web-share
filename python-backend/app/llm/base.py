"""LLM 适配层统一抽象（design D8）。"""

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Literal, Protocol

from app.core.errors import ErrorCode

# 多模态内容片段，采用 OpenAI 兼容格式：{"type":"text","text":...} / {"type":"image_url","image_url":{"url":...}}
ContentPart = dict[str, Any]


@dataclass
class ChatMessage:
    role: Literal["system", "user", "assistant"]
    content: str | list[ContentPart]  # 纯文本，或文本与图片片段的列表（视觉模型，图片翻译 OCR 使用）


def text_part(text: str) -> ContentPart:
    return {"type": "text", "text": text}


def image_part(data_url: str) -> ContentPart:
    """图片片段：data URL（data:image/jpeg;base64,...）或公网 URL。"""
    return {"type": "image_url", "image_url": {"url": data_url}}


def content_text(content: str | list[ContentPart]) -> str:
    """消息中的文本部分（多模态消息只拼接文本片段）。"""
    if isinstance(content, str):
        return content
    return "\n".join(p.get("text", "") for p in content if p.get("type") == "text")


@dataclass
class Usage:
    prompt_tokens: int = 0
    completion_tokens: int = 0


@dataclass
class ChatRequest:
    messages: list[ChatMessage]
    temperature: float | None = None
    max_tokens: int | None = None
    timeout: float | None = None  # 秒；None 表示使用客户端默认值
    extra: dict[str, Any] = field(default_factory=dict)  # 透传厂商参数，如 Qwen-MT 的 translation_options


@dataclass
class ChatResult:
    content: str
    model: str
    usage: Usage
    latency_ms: int


@dataclass
class ChatChunk:
    delta: str = ""
    model: str | None = None
    usage: Usage | None = None  # 仅最后一个 chunk 带
    latency_ms: int | None = None  # 仅最后一个 chunk 带
    done: bool = False


class LLMErrorKind(StrEnum):
    AUTH = "AUTH"
    TIMEOUT = "TIMEOUT"
    RATE_LIMIT = "RATE_LIMIT"
    BAD_REQUEST = "BAD_REQUEST"
    UNAVAILABLE = "UNAVAILABLE"


_KIND_TO_ERROR = {
    LLMErrorKind.AUTH: ErrorCode.LLM_AUTH_FAILED,
    LLMErrorKind.TIMEOUT: ErrorCode.LLM_TIMEOUT,
    LLMErrorKind.RATE_LIMIT: ErrorCode.LLM_RATE_LIMITED,
    LLMErrorKind.BAD_REQUEST: ErrorCode.LLM_CALL_FAILED,
    LLMErrorKind.UNAVAILABLE: ErrorCode.LLM_CALL_FAILED,
}


class LLMError(Exception):
    """统一 LLM 异常。message 由适配层自行拼装，不包含上游原文，避免泄露 API Key。"""

    def __init__(self, kind: LLMErrorKind, message: str | None = None, status_code: int | None = None):
        self.kind = kind
        self.status_code = status_code
        self.error_code = _KIND_TO_ERROR[kind]
        self.message = message or self.error_code.message
        super().__init__(self.message)


class LLMClient(Protocol):
    model: str

    async def chat(self, req: ChatRequest) -> ChatResult: ...

    def stream(self, req: ChatRequest) -> AsyncIterator[ChatChunk]: ...

    async def close(self) -> None: ...


def classify_status(status: int) -> LLMErrorKind:
    if status in (401, 403):
        return LLMErrorKind.AUTH
    if status == 429:
        return LLMErrorKind.RATE_LIMIT
    if status == 408:
        return LLMErrorKind.TIMEOUT
    if 400 <= status < 500:
        return LLMErrorKind.BAD_REQUEST
    return LLMErrorKind.UNAVAILABLE


def build_error(kind: LLMErrorKind, status: int | None = None) -> LLMError:
    base = _KIND_TO_ERROR[kind].message
    return LLMError(kind, f"{base}（HTTP {status}）" if status else base, status)
