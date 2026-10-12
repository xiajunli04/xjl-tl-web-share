"""翻译记忆仓储（design D5 / D6）：ai.translation_memory 的写入、列表、删除与混合检索。

- 规范化：去首尾空白、合并空白、拉丁字母小写化；``source_hash`` 为规范化原文的 md5，
  唯一键 ``(user_id, source_lang, target_lang, source_hash)`` 冲突时以最新译文覆盖
- 检索：向量路（``embedding <=> q`` 最近的 20 条）与字面路（``similarity(source_norm, q_norm) > 0.3`` 的前 20 条）
  合并去重后，在 Python 中计算字符级模糊匹配度 ``fuzzy``（difflib）与语义相似度 ``semantic``（1 - 余弦距离）；
  ``fuzzy ≥ 阈值`` 或 ``semantic ≥ 阈值`` 入选，按 ``max(fuzzy, 0.9 × semantic)`` 降序
- 模型不可用时检索返回空（``available=False``），写入抛出 ``C0160``
"""

import difflib
import hashlib
import logging
import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from app.core.config import Settings
from app.core.db import Database
from app.core.errors import BizException, ErrorCode
from app.memory.embedding import EmbeddingProvider, EmbeddingUnavailable

log = logging.getLogger("app.memory.tm")

MAX_BATCH = 200
SEMANTIC_WEIGHT = 0.9
ORIGINS = ("workbench", "document")

_WS = re.compile(r"\s+")


def _is_latin(ch: str) -> bool:
    return ch.isascii() or "LATIN" in unicodedata.name(ch, "")


def normalize_text(text: str) -> str:
    """规范化原文：去掉 Markdown 行内标记、去首尾空白、合并空白、小写化（仅拉丁字母）。

    写入与检索共用同一规则，使不同入口（工作台纯文本、文档段落原文）写入的同一句话得到相同的 hash 与匹配度。
    """
    s = _WS.sub(" ", plain_text(text or "").strip())
    return "".join(c.lower() if _is_latin(c) else c for c in s)


def source_hash(norm: str) -> str:
    return hashlib.md5(norm.encode("utf-8")).hexdigest()


def fuzzy_ratio(a_norm: str, b_norm: str) -> float:
    """字符级模糊匹配度，近似 CAT 工具的编辑距离匹配度。"""
    if a_norm == b_norm:
        return 1.0
    return difflib.SequenceMatcher(None, a_norm, b_norm, autojunk=False).ratio()


def vector_literal(vec: Sequence[float]) -> str:
    return "[" + ",".join(f"{float(x):.7g}" for x in vec) + "]"


_MD_LINK = re.compile(r"!?\[([^\]]*)\]\([^)]*\)")
_MD_CODE = re.compile(r"`([^`]*)`")
_MD_STRONG = re.compile(r"(\*\*|__|~~)(.+?)\1")
_MD_EM = re.compile(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])|(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])")


def plain_text(text: str) -> str:
    """去掉 Markdown 行内标记（链接、代码、加粗、斜体、删除线），用于按段检索（与写入时的纯文本对齐）。"""
    s = _MD_LINK.sub(r"\1", text or "")
    s = _MD_CODE.sub(r"\1", s)
    s = _MD_STRONG.sub(r"\2", s)
    s = _MD_EM.sub(lambda m: m.group(1) or m.group(2) or "", s)
    return s


@dataclass
class TmEntryIn:
    source_lang: str
    target_lang: str
    source_text: str
    target_text: str
    origin: str = "workbench"
    origin_ref: str | None = None


@dataclass
class TmHit:
    id: int
    source: str
    target: str
    fuzzy: float
    semantic: float
    origin: str
    origin_ref: str | None = None

    @property
    def score(self) -> float:
        return max(self.fuzzy, SEMANTIC_WEIGHT * self.semantic)

    @property
    def exact(self) -> bool:
        return self.fuzzy >= 1.0

    def to_vo(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "source": self.source,
            "target": self.target,
            "fuzzy": round(self.fuzzy, 4),
            "semantic": round(self.semantic, 4),
            "origin": self.origin,
            "originRef": self.origin_ref,
        }


@dataclass
class SearchResult:
    available: bool
    hits: list[TmHit] = field(default_factory=list)


def _iso(v: Any) -> str | None:
    return v.isoformat() if isinstance(v, datetime) else v


def entry_vo(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "sourceLang": row["source_lang"],
        "targetLang": row["target_lang"],
        "sourceText": row["source_text"],
        "targetText": row["target_text"],
        "origin": row["origin"],
        "originRef": row["origin_ref"],
        "hitCount": row["hit_count"],
        "lastHitAt": _iso(row["last_hit_at"]),
        "createdAt": _iso(row["created_at"]),
        "updatedAt": _iso(row["updated_at"]),
    }


_RECALL_COLUMNS = (
    "id, source_text, target_text, source_norm, origin, origin_ref, 1 - (embedding <=> %(q)s::vector) as semantic"
)
_RECALL_SQL = f"""
(select {_RECALL_COLUMNS} from ai.translation_memory
  where user_id = %(u)s and source_lang = %(s)s and target_lang = %(t)s
  order by embedding <=> %(q)s::vector limit %(n)s)
union
(select {_RECALL_COLUMNS} from ai.translation_memory
  where user_id = %(u)s and source_lang = %(s)s and target_lang = %(t)s and similarity(source_norm, %(qn)s) > %(trgm)s
  order by similarity(source_norm, %(qn)s) desc limit %(n)s)
"""


class TranslationMemory:
    def __init__(self, db: Database, embedding: EmbeddingProvider, settings: Settings):
        self._db = db
        self.embedding = embedding
        self._settings = settings

    @property
    def available(self) -> bool:
        return self.embedding.available

    # ------------------------------------------------------------ 写入

    async def upsert(self, user_id: int, entries: Sequence[TmEntryIn]) -> int:
        """批量写入（最多 200 条），冲突时覆盖译文；同一批内规范化后相同的原文以最后一条为准。返回写入条数。"""
        if len(entries) > MAX_BATCH:
            raise BizException(ErrorCode.PARAM_INVALID, f"单次最多写入 {MAX_BATCH} 条")
        unique: dict[tuple[str, str, str], tuple[TmEntryIn, str]] = {}
        for e in entries:
            norm = normalize_text(e.source_text)
            if not norm or not e.target_text.strip():
                continue
            unique[(e.source_lang, e.target_lang, source_hash(norm))] = (e, norm)
        if not unique:
            return 0
        items = list(unique.items())
        try:
            vectors = await self.embedding.embed([e.source_text.strip() for _, (e, _) in items], wait=True)
        except EmbeddingUnavailable as ex:
            raise BizException(ErrorCode.TM_UNAVAILABLE, f"翻译记忆服务不可用：{ex}") from ex
        rows = [
            (
                user_id,
                e.source_lang,
                e.target_lang,
                e.source_text.strip(),
                e.target_text.strip(),
                norm,
                key[2],
                vector_literal(vec),
                e.origin,
                e.origin_ref,
            )
            for (key, (e, norm)), vec in zip(items, vectors, strict=True)
        ]
        async with self._db.pool.connection() as conn:
            async with conn.transaction():
                async with conn.cursor() as cur:
                    await cur.executemany(
                        """insert into ai.translation_memory
                           (user_id, source_lang, target_lang, source_text, target_text, source_norm, source_hash,
                            embedding, origin, origin_ref)
                           values (%s, %s, %s, %s, %s, %s, %s, %s::vector, %s, %s)
                           on conflict (user_id, source_lang, target_lang, source_hash) do update set
                             source_text = excluded.source_text, target_text = excluded.target_text,
                             source_norm = excluded.source_norm, embedding = excluded.embedding,
                             origin = excluded.origin, origin_ref = excluded.origin_ref, updated_at = now()""",
                        rows,
                    )
        log.info("翻译记忆写入 userId=%s 条数=%d", user_id, len(rows))
        return len(rows)

    # ------------------------------------------------------------ 列表与删除

    async def list_entries(
        self,
        user_id: int,
        *,
        page_num: int = 1,
        page_size: int = 20,
        keyword: str | None = None,
        source_lang: str | None = None,
        target_lang: str | None = None,
    ) -> dict[str, Any]:
        where = ["user_id = %(u)s"]
        params: dict[str, Any] = {"u": user_id}
        if keyword and keyword.strip():
            where.append("(source_text ilike %(kw)s or target_text ilike %(kw)s)")
            escaped = keyword.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            params["kw"] = f"%{escaped}%"
        if source_lang:
            where.append("source_lang = %(s)s")
            params["s"] = source_lang
        if target_lang:
            where.append("target_lang = %(t)s")
            params["t"] = target_lang
        cond = " and ".join(where)
        total = (await self._db.fetch_one(f"select count(*) as n from ai.translation_memory where {cond}", params))["n"]
        params.update(limit=page_size, offset=(page_num - 1) * page_size)
        rows = await self._db.fetch_all(
            f"""select id, source_lang, target_lang, source_text, target_text, origin, origin_ref, hit_count,
                       last_hit_at, created_at, updated_at
                from ai.translation_memory where {cond}
                order by updated_at desc, id desc limit %(limit)s offset %(offset)s""",
            params,
        )
        return {"records": [entry_vo(r) for r in rows], "total": total, "pageNum": page_num, "pageSize": page_size}

    async def delete(self, user_id: int, entry_id: int) -> bool:
        row = await self._db.fetch_one(
            "delete from ai.translation_memory where id = %s and user_id = %s returning id", (entry_id, user_id)
        )
        return row is not None

    # ------------------------------------------------------------ 检索

    async def _recall(self, conn: Any, user_id: int, text: str, vec: list[float], src: str, tgt: str) -> list[TmHit]:
        s = self._settings
        q_norm = normalize_text(text)
        cur = await conn.execute(
            _RECALL_SQL,
            {
                "u": user_id,
                "s": src,
                "t": tgt,
                "q": vector_literal(vec),
                "qn": q_norm,
                "n": s.tm_recall_limit,
                "trgm": s.tm_trgm_min,
            },
        )
        hits: dict[int, TmHit] = {}
        for r in await cur.fetchall():
            if r["id"] in hits:
                continue
            semantic = max(0.0, min(1.0, float(r["semantic"] or 0.0)))
            hits[r["id"]] = TmHit(
                id=r["id"],
                source=r["source_text"],
                target=r["target_text"],
                fuzzy=fuzzy_ratio(q_norm, r["source_norm"]),
                semantic=semantic,
                origin=r["origin"],
                origin_ref=r["origin_ref"],
            )
        return list(hits.values())

    @staticmethod
    def _select(hits: list[TmHit], fuzzy_min: float, semantic_min: float, limit: int) -> list[TmHit]:
        chosen = [h for h in hits if h.fuzzy >= fuzzy_min or h.semantic >= semantic_min]
        chosen.sort(key=lambda h: (h.score, h.fuzzy), reverse=True)
        return chosen[:limit]

    async def touch(self, ids: Sequence[int]) -> None:
        """命中计数：被返回（或放入提示词）的条目 hit_count + 1。"""
        if not ids:
            return
        async with self._db.pool.connection() as conn:
            await conn.execute(
                "update ai.translation_memory set hit_count = hit_count + 1, last_hit_at = now() where id = any(%s)",
                (list(ids),),
            )

    async def search(
        self,
        user_id: int,
        text: str,
        source_lang: str,
        target_lang: str,
        *,
        limit: int | None = None,
        touch: bool = True,
    ) -> SearchResult:
        """短文本检索：fuzzy ≥ tm_fuzzy_min 或 semantic ≥ tm_semantic_min（缺省 0.6 / 0.65）入选，取前 k 条。

        模型不可用时 available=False。
        """
        s = self._settings
        if not text.strip():
            return SearchResult(available=self.available)
        try:
            [vec] = await self.embedding.embed([text.strip()], wait=False)
        except EmbeddingUnavailable:
            return SearchResult(available=False)
        async with self._db.pool.connection() as conn:
            hits = await self._recall(conn, user_id, text, vec, source_lang, target_lang)
        chosen = self._select(hits, s.tm_fuzzy_min, s.tm_semantic_min, limit or s.tm_top_k)
        if touch:
            await self.touch([h.id for h in chosen])
        return SearchResult(available=True, hits=chosen)

    async def search_segments(
        self, user_id: int, segments: Sequence[tuple[int, str]], source_lang: str, target_lang: str
    ) -> tuple[bool, dict[int, TmHit]]:
        """文档按段检索：每段取最佳 1 条（阈值 tm_doc_fuzzy_min / tm_doc_semantic_min，缺省 0.7 / 0.75）。

        全块最多 tm_doc_max_hits 条，按得分取前若干段。

        返回 (available, {seq: hit})；入选的条目计入命中次数。
        """
        s = self._settings
        segments = [(seq, t) for seq, t in segments if t.strip()]
        if not segments:
            return self.available, {}
        try:
            vectors = await self.embedding.embed([t.strip() for _, t in segments], wait=False)
        except EmbeddingUnavailable:
            return False, {}
        best: dict[int, TmHit] = {}
        async with self._db.pool.connection() as conn:
            for (seq, text), vec in zip(segments, vectors, strict=True):
                hits = await self._recall(conn, user_id, text, vec, source_lang, target_lang)
                top = self._select(hits, s.tm_doc_fuzzy_min, s.tm_doc_semantic_min, 1)
                if top:
                    best[seq] = top[0]
        ranked = sorted(best.items(), key=lambda kv: (kv[1].score, kv[1].fuzzy), reverse=True)[: s.tm_doc_max_hits]
        chosen = dict(sorted(ranked))
        await self.touch(list({h.id for h in chosen.values()}))
        return True, chosen
