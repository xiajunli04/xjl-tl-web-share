"""评测用 LLM 客户端：OpenAI 兼容协议，凭据取自仓库根目录 .env 的 TEST_LLM_*。

测试中转偶发 TLS 握手失败、单次延迟 3–60 s，因此超时设为 90 s，并在 SDK 重试之外再做应用层重试。
"""

import asyncio
import logging
import tomllib
from collections.abc import Sequence
from typing import Any

from dotenv import dotenv_values
from openai import AsyncOpenAI

from app.llm.base import ChatMessage

from . import REPO_ROOT

log = logging.getLogger("prompt_eval")

TIMEOUT_SECONDS = 90.0
ATTEMPTS = 4


def _env() -> dict[str, str]:
    env = {k: v for k, v in dotenv_values(REPO_ROOT / ".env").items() if v}
    missing = [k for k in ("TEST_LLM_BASE_URL", "TEST_LLM_API_KEY") if k not in env]
    if missing:
        raise SystemExit(f"仓库根目录 .env 缺少 {', '.join(missing)}")
    return env


def judge_model() -> str:
    """评审模型：evaluation/config.toml 的 [judge] model。"""
    with open(REPO_ROOT / "evaluation" / "config.toml", "rb") as f:
        return tomllib.load(f)["judge"]["model"]


class EvalLLM:
    def __init__(self, model: str | None = None):
        env = _env()
        self.model = model or env.get("TEST_LLM_MODEL") or "gpt-5.6-luna"
        self._client = AsyncOpenAI(
            base_url=env["TEST_LLM_BASE_URL"], api_key=env["TEST_LLM_API_KEY"], timeout=TIMEOUT_SECONDS, max_retries=2
        )

    async def chat(
        self,
        messages: Sequence[ChatMessage],
        *,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> str:
        kw: dict[str, Any] = {
            "model": self.model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
        }
        if temperature is not None:
            kw["temperature"] = temperature
        if max_tokens:
            kw["max_tokens"] = max_tokens
        for attempt in range(1, ATTEMPTS + 1):
            try:
                resp = await self._client.chat.completions.create(**kw)
                return (resp.choices[0].message.content or "").strip()
            except Exception as e:  # noqa: BLE001 - 中转抖动，退避后重试
                if attempt == ATTEMPTS:
                    raise
                log.warning("调用失败（第 %s 次），稍后重试: %r", attempt, e)
                await asyncio.sleep(3 * attempt)
        raise AssertionError("unreachable")
