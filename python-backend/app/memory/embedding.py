"""Embedding 提供方（design D6）。

- ``EmbeddingProvider``：只要求 ``dim``、``available``、``embed()`` 与 ``warmup()``；目前只实现本地 ``LocalEmbedding``，
  将来接入 OpenAI 兼容接口时必须支持 ``dimensions=384``，与 ``ai.translation_memory.embedding`` 的维度一致
- ``LocalEmbedding``：fastembed（ONNX Runtime，无需 torch），模型懒加载；加载在线程中进行，不阻塞事件循环。
  启动时由 lifespan 调用 ``start_warmup()`` 后台预热；加载失败时降级为不可用（检索为空、写入报 C0160），
  间隔 ``tm_retry_seconds`` 后的下一次调用会再次尝试
- 向量统一做 L2 归一化，余弦相似度 = 点积，``1 - (a <=> b)`` 即语义相似度
"""

import asyncio
import logging
import math
import os
import time
from collections.abc import Callable, Sequence
from typing import Any, Protocol

from app.core.config import Settings

log = logging.getLogger("app.memory.embedding")

EMBEDDING_DIM = 384


class EmbeddingUnavailable(Exception):
    """模型未就绪、加载失败或已关闭翻译记忆。"""


class EmbeddingProvider(Protocol):
    dim: int

    @property
    def available(self) -> bool: ...

    async def embed(self, texts: Sequence[str], *, wait: bool = True) -> list[list[float]]: ...

    async def warmup(self) -> bool: ...


def normalize(vec: Sequence[float]) -> list[float]:
    norm = math.sqrt(sum(float(x) * float(x) for x in vec))
    if norm == 0:
        return [float(x) for x in vec]
    return [float(x) / norm for x in vec]


def _default_factory(settings: Settings) -> Any:
    """构建 fastembed 模型（在线程中调用）。HF_ENDPOINT 必须在导入 huggingface_hub 之前设置。"""
    if settings.hf_endpoint:
        os.environ.setdefault("HF_ENDPOINT", settings.hf_endpoint)
    from fastembed import TextEmbedding

    os.makedirs(settings.tm_model_cache_dir, exist_ok=True)
    return TextEmbedding(
        settings.tm_embedding_model,
        cache_dir=settings.tm_model_cache_dir,
        threads=settings.tm_embed_threads,
    )


class LocalEmbedding:
    """本地 fastembed 模型。状态：idle → loading → ready | failed（failed 超过重试间隔后可再次加载）。"""

    dim = EMBEDDING_DIM

    def __init__(self, settings: Settings, factory: Callable[[Settings], Any] | None = None):
        self._settings = settings
        self._factory = factory or _default_factory
        self._model: Any = None
        self._lock = asyncio.Lock()
        self._failed_at: float | None = None
        self._loading = False
        self._warmup_task: asyncio.Task | None = None
        self.error: str | None = None

    @property
    def enabled(self) -> bool:
        return self._settings.tm_enabled

    @property
    def available(self) -> bool:
        return self.enabled and self._model is not None

    @property
    def status(self) -> str:
        if not self.enabled:
            return "disabled"
        if self._model is not None:
            return "ready"
        if self._loading:
            return "loading"
        return "failed" if self._failed_at is not None else "idle"

    def _can_retry(self) -> bool:
        return self._failed_at is None or time.monotonic() - self._failed_at >= self._settings.tm_retry_seconds

    async def warmup(self) -> bool:
        """加载模型并编码一次；已就绪时立即返回。失败只记日志，返回 False。"""
        if not self.enabled:
            return False
        if self._model is not None:
            return True
        async with self._lock:
            if self._model is not None:
                return True
            if not self._can_retry():
                return False
            self._loading = True
            start = time.perf_counter()
            try:
                model = await asyncio.to_thread(self._factory, self._settings)
                vecs = await asyncio.to_thread(lambda: [list(v) for v in model.embed(["warmup"])])
                if not vecs or len(vecs[0]) != self.dim:
                    raise ValueError(f"模型输出维度 {len(vecs[0]) if vecs else 0}，期望 {self.dim}")
            except Exception as e:  # noqa: BLE001 - 下载失败、文件损坏、内存不足等一律降级
                self._failed_at = time.monotonic()
                self.error = f"{type(e).__name__}: {e}"
                log.warning("embedding 模型加载失败，翻译记忆降级为不可用: %s", self.error)
                return False
            finally:
                self._loading = False
            self._model = model
            self._failed_at = None
            self.error = None
            log.info(
                "embedding 模型已就绪 model=%s 耗时 %.1f 秒",
                self._settings.tm_embedding_model,
                time.perf_counter() - start,
            )
            return True

    def start_warmup(self) -> asyncio.Task | None:
        """后台预热（lifespan 中调用），不阻塞服务启动。"""
        if not self.enabled or self._model is not None:
            return None
        if self._warmup_task is None or self._warmup_task.done():
            self._warmup_task = asyncio.create_task(self.warmup(), name="embedding-warmup")
        return self._warmup_task

    async def close(self) -> None:
        task = self._warmup_task
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def embed(self, texts: Sequence[str], *, wait: bool = True) -> list[list[float]]:
        """编码并归一化。wait=False 时模型未就绪立即报不可用（并在后台触发加载），用于翻译中的检索。"""
        if not self.enabled:
            raise EmbeddingUnavailable("翻译记忆已关闭")
        if self._model is None:
            if not wait:
                if self._can_retry() and not self._loading:
                    self.start_warmup()
                raise EmbeddingUnavailable("embedding 模型尚未就绪")
            try:
                ok = await asyncio.wait_for(self.warmup(), timeout=self._settings.tm_write_wait_seconds)
            except TimeoutError as e:
                raise EmbeddingUnavailable("等待 embedding 模型加载超时") from e
            if not ok:
                raise EmbeddingUnavailable(self.error or "embedding 模型不可用")
        if not texts:
            return []
        model = self._model
        try:
            raw = await asyncio.to_thread(lambda: [list(v) for v in model.embed(list(texts))])
        except Exception as e:  # noqa: BLE001
            log.warning("embedding 编码失败: %s", e)
            raise EmbeddingUnavailable(f"编码失败：{type(e).__name__}") from e
        return [normalize(v) for v in raw]
