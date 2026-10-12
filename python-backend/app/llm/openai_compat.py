"""OpenAI 兼容协议客户端（DeepSeek、Qwen、豆包、OpenAI 等）。"""

import time
from collections.abc import AsyncIterator
from typing import Any

import openai
from openai import AsyncOpenAI

from app.llm.base import (
    ChatChunk,
    ChatRequest,
    ChatResult,
    LLMError,
    LLMErrorKind,
    Usage,
    build_error,
    classify_status,
)


def _map_error(e: Exception) -> LLMError:
    if isinstance(e, openai.APITimeoutError):
        return build_error(LLMErrorKind.TIMEOUT)
    if isinstance(e, openai.APIStatusError):
        return build_error(classify_status(e.status_code), e.status_code)
    if isinstance(e, openai.APIConnectionError):
        return build_error(LLMErrorKind.UNAVAILABLE)
    return build_error(LLMErrorKind.UNAVAILABLE)


class OpenAICompatibleClient:
    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        timeout: float = 60.0,
        max_retries: int = 0,
        http_client: Any = None,
    ):
        self.model = model
        self._client = AsyncOpenAI(
            base_url=base_url,
            api_key=api_key,
            timeout=timeout,
            max_retries=max_retries,
            http_client=http_client,
        )

    def _kwargs(self, req: ChatRequest) -> dict[str, Any]:
        kw: dict[str, Any] = {
            "model": self.model,
            # content 为字符串或多模态片段列表（OpenAI 兼容格式，原样透传）
            "messages": [{"role": m.role, "content": m.content} for m in req.messages],
        }
        if req.temperature is not None:
            kw["temperature"] = req.temperature
        if req.max_tokens is not None:
            kw["max_tokens"] = req.max_tokens
        if req.timeout is not None:
            kw["timeout"] = req.timeout
        if req.extra:
            kw["extra_body"] = dict(req.extra)
        return kw

    async def chat(self, req: ChatRequest) -> ChatResult:
        start = time.perf_counter()
        try:
            resp = await self._client.chat.completions.create(**self._kwargs(req))
        except Exception as e:
            raise _map_error(e) from None
        latency = int((time.perf_counter() - start) * 1000)
        content = resp.choices[0].message.content if resp.choices else ""
        usage = Usage(
            prompt_tokens=resp.usage.prompt_tokens if resp.usage else 0,
            completion_tokens=resp.usage.completion_tokens if resp.usage else 0,
        )
        return ChatResult(content=content or "", model=resp.model or self.model, usage=usage, latency_ms=latency)

    async def stream(self, req: ChatRequest) -> AsyncIterator[ChatChunk]:
        start = time.perf_counter()
        usage = Usage()
        model = self.model
        try:
            stream = await self._client.chat.completions.create(
                **self._kwargs(req), stream=True, stream_options={"include_usage": True}
            )
            async for chunk in stream:
                model = chunk.model or model
                if chunk.usage:
                    usage = Usage(chunk.usage.prompt_tokens, chunk.usage.completion_tokens)
                if chunk.choices:
                    delta = chunk.choices[0].delta.content
                    if delta:
                        yield ChatChunk(delta=delta, model=model)
        except LLMError:
            raise
        except Exception as e:
            raise _map_error(e) from None
        yield ChatChunk(model=model, usage=usage, latency_ms=int((time.perf_counter() - start) * 1000), done=True)

    async def close(self) -> None:
        await self._client.close()
