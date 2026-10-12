"""psycopg 异步连接池（tl_ai 角色）。"""

import logging

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from app.core.config import Settings

log = logging.getLogger("app.db")


class Database:
    def __init__(self, settings: Settings, conninfo: str | None = None):
        self._settings = settings
        self.pool = AsyncConnectionPool(
            conninfo or settings.db_conninfo,
            min_size=settings.db_pool_min_size,
            max_size=settings.db_pool_max_size,
            timeout=settings.db_connect_timeout,
            kwargs={"row_factory": dict_row, "autocommit": True},
            open=False,
        )

    async def open(self) -> None:
        # wait=False：数据库不可达时服务仍可启动，健康检查报告 db=DOWN
        await self.pool.open(wait=False)

    async def close(self) -> None:
        await self.pool.close()

    async def ping(self) -> bool:
        try:
            async with self.pool.connection(timeout=self._settings.db_connect_timeout) as conn:
                await conn.execute("select 1")
            return True
        except Exception as e:
            log.warning("数据库连通检查失败: %s", type(e).__name__)
            return False

    async def fetch_one(self, sql: str, params: tuple | dict | None = None) -> dict | None:
        async with self.pool.connection() as conn:
            cur = await conn.execute(sql, params)
            return await cur.fetchone()

    async def fetch_all(self, sql: str, params: tuple | dict | None = None) -> list[dict]:
        async with self.pool.connection() as conn:
            cur = await conn.execute(sql, params)
            return await cur.fetchall()
