"""LLMRegistry：按模型配置获取客户端，按 (id, updated_at) 缓存。"""

import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from app.core.crypto import decrypt
from app.core.errors import BizException, ErrorCode
from app.core.tls import ssl_context
from app.llm.anthropic_client import AnthropicClient
from app.llm.base import LLMClient
from app.llm.openai_compat import OpenAICompatibleClient
from app.repositories.model_config import CHAT, ModelConfig, ModelConfigRepository

log = logging.getLogger("app.llm.registry")

DEFAULT_TIMEOUT_SECONDS = 60.0
# SDK 对连接错误、408/429/5xx 的自动重试次数；上游网络不稳定时避免偶发失败，可用 params.maxRetries 覆盖
DEFAULT_MAX_RETRIES = 2


@dataclass
class ResolvedModel:
    config: ModelConfig
    client: LLMClient

    @property
    def params(self) -> dict[str, Any]:
        return self.config.params


class LLMRegistry:
    def __init__(
        self,
        repo: ModelConfigRepository,
        secret_b64: str,
        http_client_factory: Callable[[], Any] | None = None,
    ):
        self._repo = repo
        self._secret = secret_b64
        self._http_client_factory = http_client_factory  # 测试中注入（httpx2 客户端工厂）
        self._cache: dict[int, tuple[datetime, LLMClient]] = {}
        self._lock = asyncio.Lock()

    @property
    def repo(self) -> ModelConfigRepository:
        """模型配置仓储（引擎清单、连通性测试按能力分支时读取配置）。"""
        return self._repo

    async def get(self, model_config_id: int | None = None) -> ResolvedModel:
        if model_config_id is None:
            cfg = await self._repo.find_default()
        else:
            cfg = await self._repo.find_active_by_id(model_config_id)
        if cfg is None:
            raise BizException(ErrorCode.MODEL_CONFIG_UNAVAILABLE)
        if cfg.capability != CHAT:
            raise BizException(ErrorCode.MODEL_CONFIG_UNAVAILABLE, f"配置 {cfg.id} 不是对话模型（{cfg.capability}）")

        async with self._lock:
            cached = self._cache.get(cfg.id)
            if cached and cached[0] == cfg.updated_at:
                return ResolvedModel(cfg, cached[1])
            client = self._build(cfg)
            self._cache[cfg.id] = (cfg.updated_at, client)
        if cached:
            await self._safe_close(cached[1])
        return ResolvedModel(cfg, client)

    async def config_with_key(self, capability: str, model_config_id: int | None = None) -> tuple[ModelConfig, str]:
        """语音、同传、图片翻译等非对话能力：返回配置与解密后的密钥（未指定 id 时取该能力的默认配置）。

        配置不存在、已停用或能力不符时抛出 C0130。
        """
        if model_config_id is None:
            cfg = await self._repo.find_default(capability)
        else:
            cfg = await self._repo.find_active_by_id(model_config_id)
        if cfg is None or cfg.capability != capability:
            raise BizException(ErrorCode.MODEL_CONFIG_UNAVAILABLE)
        return cfg, decrypt(cfg.api_key_cipher, self._secret)

    def _build(self, cfg: ModelConfig) -> LLMClient:
        api_key = decrypt(cfg.api_key_cipher, self._secret)
        timeout = float(cfg.params.get("timeoutSeconds") or DEFAULT_TIMEOUT_SECONDS)
        max_retries = int(cfg.params.get("maxRetries", DEFAULT_MAX_RETRIES))
        if cfg.provider == "ANTHROPIC":
            return AnthropicClient(
                api_key=api_key,
                model=cfg.model_name,
                base_url=cfg.base_url,
                timeout=timeout,
                max_retries=max_retries,
                http_client=self._new_http_client(cfg.provider),
            )
        if cfg.provider == "OPENAI_COMPATIBLE":
            return OpenAICompatibleClient(
                base_url=cfg.base_url,
                api_key=api_key,
                model=cfg.model_name,
                timeout=timeout,
                max_retries=max_retries,
                http_client=self._new_http_client(cfg.provider),
            )
        raise BizException(ErrorCode.MODEL_CONFIG_UNAVAILABLE, f"不支持的提供方: {cfg.provider}")

    def _new_http_client(self, provider: str) -> Any:
        """测试注入的工厂优先；否则用 SDK 的缺省客户端（保留其超时与连接池设置），但证书校验改用标准库上下文，
        避免 httpx2 缺省的 truststore 在 Windows 上阻塞事件循环（见 app.core.tls）。"""
        if self._http_client_factory:
            return self._http_client_factory()
        if provider == "ANTHROPIC":
            import anthropic

            return anthropic.DefaultAsyncHttpxClient(verify=ssl_context())
        import openai

        return openai.DefaultAsyncHttpxClient(verify=ssl_context())

    @staticmethod
    async def _safe_close(client: LLMClient) -> None:
        try:
            await client.close()
        except Exception:  # noqa: BLE001
            log.debug("关闭旧客户端失败", exc_info=True)

    async def close(self) -> None:
        for _, client in self._cache.values():
            await self._safe_close(client)
        self._cache.clear()
