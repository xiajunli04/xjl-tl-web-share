"""术语库只读访问（tl_ai 对 biz.glossary / biz.glossary_term 只有 SELECT 权限，design D4/D6）。

缓存键为 (glossary.updated_at, 术语最大 updated_at, 术语条数)：术语增删改都能使缓存失效，
即使 Spring 修改术语时没有同步刷新 glossary.updated_at。
"""

import asyncio
import logging
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from app.core.db import Database

log = logging.getLogger("app.glossary.repository")

CACHE_MAX_ENTRIES = 256

_VERSION_SQL = """
select g.id, g.name, g.source_lang, g.target_lang, g.updated_at,
       (select max(t.updated_at) from biz.glossary_term t where t.glossary_id = g.id) as terms_updated_at,
       (select count(*) from biz.glossary_term t where t.glossary_id = g.id) as terms_count
from biz.glossary g
where g.id = any(%s) and not g.deleted
"""

_TERMS_SQL = """
select glossary_id, id, source_term, target_term, case_sensitive
from biz.glossary_term
where glossary_id = any(%s)
order by glossary_id, id
"""


@dataclass(frozen=True)
class Term:
    id: int
    glossary_id: int
    source_term: str
    target_term: str
    case_sensitive: bool = False


@dataclass(frozen=True)
class Glossary:
    id: int
    name: str
    source_lang: str
    target_lang: str
    terms: tuple[Term, ...] = ()


VersionKey = tuple[datetime | None, datetime | None, int]


class GlossaryRepository:
    def __init__(self, db: Database):
        self._db = db
        self._cache: OrderedDict[int, tuple[VersionKey, Glossary]] = OrderedDict()
        self._lock = asyncio.Lock()

    async def load(self, glossary_ids: list[int]) -> dict[int, Glossary]:
        """按 id 加载术语库及其术语；不存在或已删除的 id 不出现在结果中。"""
        ids = list(dict.fromkeys(glossary_ids))
        if not ids:
            return {}
        rows = await self._db.fetch_all(_VERSION_SQL, (ids,))
        result: dict[int, Glossary] = {}
        stale: dict[int, tuple[VersionKey, dict[str, Any]]] = {}
        async with self._lock:
            for row in rows:
                key: VersionKey = (row["updated_at"], row["terms_updated_at"], int(row["terms_count"]))
                cached = self._cache.get(row["id"])
                if cached and cached[0] == key:
                    self._cache.move_to_end(row["id"])
                    result[row["id"]] = cached[1]
                else:
                    stale[row["id"]] = (key, row)
        if stale:
            term_rows = await self._db.fetch_all(_TERMS_SQL, (list(stale),))
            terms: dict[int, list[Term]] = {gid: [] for gid in stale}
            for t in term_rows:
                terms[t["glossary_id"]].append(
                    Term(
                        id=t["id"],
                        glossary_id=t["glossary_id"],
                        source_term=t["source_term"],
                        target_term=t["target_term"],
                        case_sensitive=bool(t["case_sensitive"]),
                    )
                )
            async with self._lock:
                for gid, (key, row) in stale.items():
                    glossary = Glossary(
                        id=gid,
                        name=row["name"],
                        source_lang=row["source_lang"],
                        target_lang=row["target_lang"],
                        terms=tuple(terms[gid]),
                    )
                    self._cache[gid] = (key, glossary)
                    self._cache.move_to_end(gid)
                    result[gid] = glossary
                while len(self._cache) > CACHE_MAX_ENTRIES:
                    self._cache.popitem(last=False)
            log.info("加载术语库 ids=%s", list(stale))
        return result
