"""评审模型解析（design D4 的 Python 端）。

评审调用使用 ``reviewModelConfigId`` 指向的模型；未指定时使用译者模型。
执行时评审模型取不到（配置不存在、已停用或其他异常）时退回译者模型，不让翻译失败。
解析是懒的：只有真正发生评审时才查询，每个请求 / 每次任务执行最多解析一次。
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from app.core.errors import BizException
from app.llm.base import LLMClient
from app.llm.registry import ResolvedModel

log = logging.getLogger("app.llm.reviewer")

Resolve = Callable[[int], Awaitable[ResolvedModel]]


@dataclass
class ReviewModel:
    client: LLMClient
    name: str | None  # 模型显示名（model_config.name）
    fallback: bool = False  # 指定的评审模型不可用，已退回译者模型
    config_id: int | None = None  # 指定的评审模型配置 id（未指定时为 None）
    error: str | None = None  # 退回原因


class ReviewerSource:
    """按需解析评审模型，结果缓存在实例上（每个请求或每次任务执行一个实例）。"""

    def __init__(
        self,
        translator: LLMClient,
        translator_name: str | None,
        review_model_config_id: int | None,
        resolve: Resolve | None,
    ):
        self._translator = translator
        self._translator_name = translator_name
        self._config_id = review_model_config_id
        self._resolve = resolve
        self._cached: ReviewModel | None = None
        self._lock = asyncio.Lock()

    @classmethod
    def of(cls, translator: ResolvedModel, review_model_config_id: int | None, resolve: Resolve | None):
        return cls(translator.client, translator.config.name, review_model_config_id, resolve)

    async def get(self) -> ReviewModel:
        if self._cached is not None:
            return self._cached
        async with self._lock:
            if self._cached is None:
                self._cached = await self._load()
        return self._cached

    async def _load(self) -> ReviewModel:
        if self._config_id is None or self._resolve is None:
            return ReviewModel(self._translator, self._translator_name)
        try:
            resolved = await self._resolve(self._config_id)
        except Exception as e:  # noqa: BLE001 - 任何原因取不到评审模型都退回译者模型
            reason = e.message if isinstance(e, BizException) else f"{type(e).__name__}: {e}"
            log.warning("评审模型（id=%s）不可用，退回译者模型：%s", self._config_id, reason)
            return ReviewModel(self._translator, self._translator_name, True, self._config_id, reason)
        return ReviewModel(resolved.client, resolved.config.name, False, self._config_id)


async def review_model_of(source: ReviewerSource | None, translator: LLMClient) -> ReviewModel:
    """依赖中没有评审模型来源（如单元测试直接构造依赖）时使用译者模型。"""
    if source is None:
        return ReviewModel(translator, None)
    return await source.get()
