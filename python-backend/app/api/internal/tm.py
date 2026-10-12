"""翻译记忆内部接口（add-session-context-and-memory 契约 D）：写入、列表、删除与检索。

- ``POST /internal/tm/entries``：批量 upsert（≤200 条，原文 1–5000 字符），模型不可用 → C0160（HTTP 503）
- ``GET /internal/tm/entries``：分页列表，按原文或译文关键词、语言对筛选
- ``DELETE /internal/tm/entries/{id}?userId=``：不属于该用户或不存在 → A0404
- ``POST /internal/tm/search``：检索，模型不可用时 ``available=false, hits=[]``
"""

import logging
from typing import Literal

from fastapi import APIRouter, Depends, Query, Request
from pydantic import Field

from app.core.errors import BizException, ErrorCode, ok
from app.core.schema import CamelModel
from app.core.security import verify_internal_token
from app.lang import languages
from app.memory.tm import MAX_BATCH, TmEntryIn, TranslationMemory

log = logging.getLogger("app.api.tm")

router = APIRouter(prefix="/internal/tm", tags=["internal"], dependencies=[Depends(verify_internal_token)])

MAX_SOURCE_CHARS = 5000
MAX_TARGET_CHARS = 10000
MAX_PAGE_SIZE = 100
MAX_SEARCH_LIMIT = 10


class TmEntryBody(CamelModel):
    source_lang: str = Field(min_length=1, max_length=8)
    target_lang: str = Field(min_length=1, max_length=8)
    source_text: str = Field(min_length=1, max_length=MAX_SOURCE_CHARS)
    target_text: str = Field(min_length=1, max_length=MAX_TARGET_CHARS)
    origin: Literal["workbench", "document"] = "workbench"
    origin_ref: str | None = Field(default=None, max_length=64)


class WriteBody(CamelModel):
    user_id: int = Field(ge=1)
    entries: list[TmEntryBody] = Field(min_length=1, max_length=MAX_BATCH)


class SearchBody(CamelModel):
    user_id: int = Field(ge=1)
    text: str = Field(min_length=1, max_length=MAX_SOURCE_CHARS)
    source_lang: str
    target_lang: str
    limit: int = Field(default=3, ge=1, le=MAX_SEARCH_LIMIT)


def _tm(request: Request) -> TranslationMemory:
    return request.app.state.tm


def _check_pair(source_lang: str, target_lang: str) -> None:
    for code in (source_lang, target_lang):
        if not languages.is_supported(code):
            raise BizException(ErrorCode.UNSUPPORTED_LANGUAGE, f"不支持的语种: {code}")
    if source_lang == target_lang:
        raise BizException(ErrorCode.PARAM_INVALID, "源语言与目标语言不能相同")


@router.post("/entries")
async def write_entries(body: WriteBody, request: Request) -> dict:
    for e in body.entries:
        _check_pair(e.source_lang, e.target_lang)
        if not e.source_text.strip() or not e.target_text.strip():
            raise BizException(ErrorCode.PARAM_INVALID, "原文与译文不能为空")
    written = await _tm(request).upsert(
        body.user_id,
        [
            TmEntryIn(e.source_lang, e.target_lang, e.source_text, e.target_text, e.origin, e.origin_ref)
            for e in body.entries
        ],
    )
    return ok({"written": written})


@router.get("/entries")
async def list_entries(
    request: Request,
    user_id: int = Query(alias="userId", ge=1),
    page_num: int = Query(default=1, alias="pageNum", ge=1),
    page_size: int = Query(default=20, alias="pageSize", ge=1, le=MAX_PAGE_SIZE),
    keyword: str | None = Query(default=None, max_length=200),
    source_lang: str | None = Query(default=None, alias="sourceLang", max_length=8),
    target_lang: str | None = Query(default=None, alias="targetLang", max_length=8),
) -> dict:
    page = await _tm(request).list_entries(
        user_id,
        page_num=page_num,
        page_size=page_size,
        keyword=keyword,
        source_lang=source_lang or None,
        target_lang=target_lang or None,
    )
    return ok(page)


@router.delete("/entries/{entry_id}")
async def delete_entry(entry_id: int, request: Request, user_id: int = Query(alias="userId", ge=1)) -> dict:
    if not await _tm(request).delete(user_id, entry_id):
        raise BizException(ErrorCode.NOT_FOUND, "翻译记忆条目不存在")
    log.info("删除翻译记忆 userId=%s id=%s", user_id, entry_id)
    return ok(None)


@router.post("/search")
async def search(body: SearchBody, request: Request) -> dict:
    _check_pair(body.source_lang, body.target_lang)
    result = await _tm(request).search(body.user_id, body.text, body.source_lang, body.target_lang, limit=body.limit)
    return ok({"available": result.available, "hits": [h.to_vo() for h in result.hits]})
