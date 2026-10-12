"""两级恢复的持久化（design D6）。

- 分块级：``ai.doc_chunk_result``（DDL 由 Spring Flyway V3 维护），每块完成后由 Python 写入
- 阶段级：LangGraph ``AsyncPostgresSaver``，使用独立连接池并通过 ``search_path=ai`` 把检查点表建在 ai schema
"""

import json
import logging
from typing import Any, Protocol

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from app.core.config import Settings
from app.core.db import Database

log = logging.getLogger("app.doc.store")


class ChunkStore(Protocol):
    async def get(self, task_id: int, chunk_index: int) -> dict[str, Any] | None: ...

    async def put(self, task_id: int, chunk_index: int, result: dict[str, Any], usage: dict[str, int]) -> None: ...

    async def purge(self, task_id: int) -> None: ...


class PgChunkStore:
    def __init__(self, db: Database):
        self._db = db

    async def get(self, task_id: int, chunk_index: int) -> dict[str, Any] | None:
        row = await self._db.fetch_one(
            "select result, usage from ai.doc_chunk_result where task_id = %s and chunk_index = %s",
            (task_id, chunk_index),
        )
        if row is None:
            return None
        result = dict(row["result"] or {})
        result["usage"] = row["usage"] or {}
        return result

    async def put(self, task_id: int, chunk_index: int, result: dict[str, Any], usage: dict[str, int]) -> None:
        async with self._db.pool.connection() as conn:
            await conn.execute(
                """insert into ai.doc_chunk_result (task_id, chunk_index, result, usage)
                   values (%s, %s, %s::jsonb, %s::jsonb)
                   on conflict (task_id, chunk_index)
                   do update set result = excluded.result, usage = excluded.usage, created_at = now()""",
                (task_id, chunk_index, json.dumps(result, ensure_ascii=False), json.dumps(usage)),
            )

    async def purge(self, task_id: int) -> None:
        async with self._db.pool.connection() as conn:
            await conn.execute("delete from ai.doc_chunk_result where task_id = %s", (task_id,))


def checkpoint_conninfo(settings: Settings) -> str:
    return f"{settings.db_conninfo} options='-c search_path=ai'"


def make_checkpoint_pool(settings: Settings, conninfo: str | None = None) -> AsyncConnectionPool:
    """AsyncPostgresSaver 要求 autocommit、prepare_threshold=0、dict_row（setup 中有 CREATE INDEX CONCURRENTLY）。"""
    return AsyncConnectionPool(
        conninfo or checkpoint_conninfo(settings),
        min_size=1,
        max_size=max(2, settings.doc_worker_concurrency + 1),
        timeout=settings.db_connect_timeout * 3,
        kwargs={"autocommit": True, "prepare_threshold": 0, "row_factory": dict_row},
        open=False,
    )
