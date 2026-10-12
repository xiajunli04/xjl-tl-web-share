"""Anthropic Messages API 客户端。"""

import re
import time
from collections.abc import AsyncIterator
from typing import Any

import anthropic
from anthropic import AsyncAnthropic

from app.llm.base import (
    ChatChunk,
    ChatRequest,
    ChatResult,
    ContentPart,
    LLMError,
    LLMErrorKind,
    Usage,
    build_error,
    classify_status,
    content_text,
)

DEFAULT_MAX_TOKENS = 1024  # Anthropic 要求必须提供 max_tokens
_DATA_URL = re.compile(r"^data:(?P<mime>[\w/+.-]+);base64,(?P<data>.+)$", re.DOTALL)


def _to_anthropic_content(content: str | list[ContentPart]) -> str | list[dict[str, Any]]:
    """OpenAI 兼容格式的多模态片段转为 Anthropic 内容块：image_url（data URL 或公网 URL）→ image。"""
    if isinstance(content, str):
        return content
    blocks: list[dict[str, Any]] = []
    for part in content:
        if part.get("type") == "image_url":
            url = str((part.get("image_url") or {}).get("url", ""))
            m = _DATA_URL.match(url)
            if m:
                source = {"type": "base64", "media_type": m["mime"], "data": m["data"]}
            else:
                source = {"type": "url", "url": url}
            blocks.append({"type": "image", "source": source})
        elif part.get("type") == "text":
            blocks.append({"type": "text", "text": part.get("text", "")})
    return blocks


def _map_error(e: Exception) -> LLMError:
    if isinstance(e, anthropic.APITimeoutError):
        return build_error(LLMErrorKind.TIMEOUT)
    if isinstance(e, anthropic.APIStatusError):
        return build_error(classify_status(e.status_code), e.status_code)
    return build_error(LLMErrorKind.UNAVAILABLE)


class AnthropicClient:
    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        base_url: str | None = None,
        timeout: float = 60.0,
        max_retries: int = 0,
        http_client: Any = None,
    ):
        self.model = model
        self._client = AsyncAnthropic(
            api_key=api_key,
            base_url=base_url or None,
            timeout=timeout,
            max_retries=max_retries,
            http_client=http_client,
        )

    def _kwargs(self, req: ChatRequest) -> dict[str, Any]:
        system = "\n\n".join(content_text(m.content) for m in req.messages if m.role == "system")
        kw: dict[str, Any] = {
            "model": self.model,
            "max_tokens": req.max_tokens or DEFAULT_MAX_TOKENS,
            "messages": [
                {"role": m.role, "content": _to_anthropic_content(m.content)}
                for m in req.messages
                if m.role != "system"
            ],
        }
        if system:
            kw["system"] = system
        # anthropic SDK 1.x 的 messages.create 已不再接受 temperature 等采样参数（传入会抛 TypeError），
        # 因此忽略 req.temperature；确定性依赖提示词约束
        if req.timeout is not None:
            kw["timeout"] = req.timeout
        if req.extra:
            kw["extra_body"] = dict(req.extra)
        return kw

    async def chat(self, req: ChatRequest) -> ChatResult:
        start = time.perf_counter()
        try:
            resp = await self._client.messages.create(**self._kwargs(req))
        except Exception as e:
            raise _map_error(e) from None
        latency = int((time.perf_counter() - start) * 1000)
        content = "".join(getattr(b, "text", "") for b in resp.content if b.type == "text")
        return ChatResult(
            content=content,
            model=resp.model or self.model,
            usage=Usage(resp.usage.input_tokens, resp.usage.output_tokens),
            latency_ms=latency,
        )

    async def stream(self, req: ChatRequest) -> AsyncIterator[ChatChunk]:
        start = time.perf_counter()
        usage = Usage()
        model = self.model
        try:
            stream = await self._client.messages.create(**self._kwargs(req), stream=True)
            async for event in stream:
                if event.type == "message_start":
                    model = event.message.model or model
                    usage.prompt_tokens = event.message.usage.input_tokens or 0
                    usage.completion_tokens = event.message.usage.output_tokens or 0
                elif event.type == "content_block_delta" and event.delta.type == "text_delta":
                    if event.delta.text:
                        yield ChatChunk(delta=event.delta.text, model=model)
                elif event.type == "message_delta" and event.usage:
                    usage.completion_tokens = event.usage.output_tokens or usage.completion_tokens
                    if getattr(event.usage, "input_tokens", None):
                        usage.prompt_tokens = event.usage.input_tokens
        except LLMError:
            raise
        except Exception as e:
            raise _map_error(e) from None
        yield ChatChunk(model=model, usage=usage, latency_ms=int((time.perf_counter() - start) * 1000), done=True)

    async def close(self) -> None:
        await self._client.close()
