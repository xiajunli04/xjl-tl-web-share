"""短文本歧义追问的检查点（add-session-context-and-memory D4）。

- AsyncPostgresSaver 与文档共用 ai schema 的检查点表（独立的小连接池，search_path=ai），
  thread_id 为 ``turn:{requestId}``
- 序列化：短文本状态含 dataclass（Review、ReviewIssue、TermHit、TermCompliance、TranslationContext、NodeTrace、
  TextFeatures、Usage）与 pydantic 模型（TranslateRequest 及会话、修订载荷）。``JsonPlusSerializer`` 以 msgpack
  白名单（``allowed_msgpack_modules``）显式放行这些类型，未登记的类型一律拒绝反序列化（不依赖 LANGGRAPH_STRICT_MSGPACK）
- 表结构由 ``setup()`` 幂等创建；数据库不可用时 ``graph()`` 返回 None，调用方退回无检查点的图（不追问）
- 清理：正常完成后立即删除 thread；后台任务每小时删除最后一个检查点早于 24 小时的 ``turn:*`` thread
"""

import asyncio
import logging
import time
from typing import Any

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer
from langgraph.graph.state import CompiledStateGraph
from psycopg_pool import AsyncConnectionPool

from app.agent.graph import THREAD_PREFIX, build_graph
from app.core.config import Settings
from app.doc.store import make_checkpoint_pool

log = logging.getLogger("app.agent.hitl")

SETUP_RETRY_SECONDS = 30.0
STARTUP_CLEANUP_DELAY_SECONDS = 60.0

# 检查点中可能出现的自定义类型（模块, 类名）
SERDE_ALLOWLIST: tuple[tuple[str, str], ...] = (
    ("app.agent.state", "TranslateRequest"),
    ("app.agent.state", "SessionPayload"),
    ("app.agent.state", "SessionTurn"),
    ("app.agent.state", "SessionEntity"),
    ("app.agent.state", "RevisePayload"),
    ("app.agent.state", "TranslationContext"),
    ("app.agent.state", "Review"),
    ("app.agent.state", "ReviewIssue"),
    ("app.agent.state", "NodeTrace"),
    ("app.agent.state", "TextFeatures"),
    ("app.glossary.matcher", "TermHit"),
    ("app.glossary.matcher", "TermCompliance"),
    ("app.llm.base", "Usage"),
)

STALE_THREADS_SQL = """
select thread_id from checkpoints
 where thread_id like %(prefix)s
 group by thread_id
having max((checkpoint->>'ts')::timestamptz) < now() - make_interval(secs => %(ttl)s)
"""


def make_serde() -> JsonPlusSerializer:
    return JsonPlusSerializer(allowed_msgpack_modules=SERDE_ALLOWLIST)


class TurnCheckpoints:
    def __init__(self, settings: Settings, pool: AsyncConnectionPool | None = None):
        self._settings = settings
        self._own_pool = pool is None
        self._pool = pool or make_checkpoint_pool(settings)
        self.saver = AsyncPostgresSaver(conn=self._pool, serde=make_serde())
        self._ready = False
        self._failed_at: float | None = None
        self._lock = asyncio.Lock()
        self._graphs: dict[int, CompiledStateGraph] = {}
        self._cleanup_task: asyncio.Task | None = None

    async def open(self) -> None:
        if self._own_pool:
            await self._pool.open(wait=False)

    async def close(self) -> None:
        task = self._cleanup_task
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        if self._own_pool:
            await self._pool.close()

    async def ensure_ready(self) -> bool:
        """幂等建表；失败后 30 秒内不再重试，期间会话请求退回无检查点的图。"""
        if self._ready:
            return True
        async with self._lock:
            if self._ready:
                return True
            if self._failed_at is not None and time.monotonic() - self._failed_at < SETUP_RETRY_SECONDS:
                return False
            try:
                await self.saver.setup()
            except Exception as e:  # noqa: BLE001 - 数据库不可用时降级为不追问
                self._failed_at = time.monotonic()
                log.warning("追问检查点初始化失败，本次不启用歧义追问: %s", e)
                return False
            self._ready = True
            return True

    async def graph(self, max_refine_rounds: int) -> CompiledStateGraph | None:
        if not await self.ensure_ready():
            return None
        g = self._graphs.get(max_refine_rounds)
        if g is None:
            g = self._graphs[max_refine_rounds] = build_graph(max_refine_rounds, self.saver)
        return g

    async def snapshot(self, thread_id: str, max_refine_rounds: int) -> Any | None:
        """thread 不存在（或已删除、已执行完毕）时返回 None。"""
        if not thread_id.startswith(THREAD_PREFIX):
            return None
        g = await self.graph(max_refine_rounds)
        if g is None:
            return None
        snap = await g.aget_state({"configurable": {"thread_id": thread_id}})
        if snap.created_at is None or not snap.next:
            return None
        return snap

    async def delete_thread(self, thread_id: str) -> None:
        if not await self.ensure_ready():
            return
        await self.saver.adelete_thread(thread_id)

    async def delete_thread_quietly(self, thread_id: str) -> None:
        try:
            await self.delete_thread(thread_id)
        except Exception as e:  # noqa: BLE001 - 删除失败交给定期清理
            log.warning("删除追问检查点失败 threadId=%s: %s", thread_id, e)

    async def cleanup(self, ttl_seconds: float | None = None) -> int:
        """删除最后一个检查点早于 ttl 的 turn:* thread，返回删除的 thread 数。"""
        if not await self.ensure_ready():
            return 0
        ttl = ttl_seconds if ttl_seconds is not None else self._settings.turn_thread_ttl_hours * 3600
        async with self._pool.connection() as conn:
            cur = await conn.execute(STALE_THREADS_SQL, {"prefix": f"{THREAD_PREFIX}%", "ttl": ttl})
            threads = [r["thread_id"] for r in await cur.fetchall()]
        for t in threads:
            await self.saver.adelete_thread(t)
        if threads:
            log.info("清理过期的追问检查点 %d 个", len(threads))
        return len(threads)

    def start_cleanup(self) -> asyncio.Task:
        if self._cleanup_task is None or self._cleanup_task.done():
            self._cleanup_task = asyncio.create_task(self._cleanup_loop(), name="turn-thread-cleanup")
        return self._cleanup_task

    async def _cleanup_loop(self) -> None:
        interval = self._settings.turn_cleanup_interval_seconds
        # 启动后稍等再做第一次清理，避免与文档 worker 同时执行检查点表的 setup
        await asyncio.sleep(min(STARTUP_CLEANUP_DELAY_SECONDS, interval))
        while True:
            try:
                await self.cleanup()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - 清理失败下个周期重试
                log.warning("清理追问检查点失败: %s", e)
            await asyncio.sleep(interval)
