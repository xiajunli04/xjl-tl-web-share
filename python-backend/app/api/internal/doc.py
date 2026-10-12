"""POST /internal/doc/segment/retranslate：无状态单段重译（design D11）。

上下文由 Spring 从 doc_task / doc_segment / doc_task_term 组装后传入；Python 只负责保护、调用与还原。
返回 ``{target, usage, latencyMs}``；标记还原失败时重试一次，仍失败返回 C0150。
"""

import logging
import time
from typing import Any

from fastapi import APIRouter, Depends, Request
from pydantic import Field, field_validator

from app.agent.state import Style
from app.core.errors import BizException, ErrorCode, ok
from app.core.schema import CamelModel
from app.core.security import verify_internal_token
from app.doc import prompts
from app.doc.llm import call_json, parse_segments
from app.doc.memory import ChunkMemory, chunk_context, term_hits
from app.doc.protect import protect, restore
from app.doc.state import DocDeps, sum_usage, usage_dict
from app.lang import languages
from app.llm.base import Usage
from app.llm.registry import LLMRegistry

log = logging.getLogger("app.api.doc")

router = APIRouter(prefix="/internal/doc", tags=["internal"], dependencies=[Depends(verify_internal_token)])

MAX_SEGMENT_CHARS = 10000
ATTEMPTS = 2


class TermPair(CamelModel):
    source: str
    target: str


class RetranslateRequest(CamelModel):
    task_id: int | None = None
    seq: int = 0
    source: str = Field(min_length=1, max_length=MAX_SEGMENT_CHARS)
    source_lang: str | None = None  # 可选：任务生效的源语言（未提供或为 auto 时自动识别）
    block_type: str | None = None  # 可选：表格行需要保护单元格分隔符
    prev_source: str | None = None
    prev_target: str | None = None
    next_source: str | None = None
    summary: str | None = None
    terms: list[TermPair] = Field(default_factory=list)
    target_lang: str
    style: Style = "faithful"
    domain: str | None = None
    model_config_id: int | None = Field(default=None, ge=1)
    instruction: str | None = Field(default=None, max_length=200)

    # Spring 发送 D11 的全部字段，未提供的为 null
    @field_validator("terms", mode="before")
    @classmethod
    def _none_terms(cls, v: Any) -> Any:
        return [] if v is None else v

    @field_validator("style", mode="before")
    @classmethod
    def _none_style(cls, v: Any) -> Any:
        return "faithful" if v is None else v


@router.post("/segment/retranslate")
async def retranslate(body: RetranslateRequest, request: Request) -> dict:
    if not body.source.strip():
        raise BizException(ErrorCode.PARAM_INVALID, "原文不能为空")
    if not languages.is_supported(body.target_lang):
        raise BizException(ErrorCode.UNSUPPORTED_LANGUAGE, f"不支持的目标语言: {body.target_lang}")
    settings = request.app.state.settings
    registry: LLMRegistry = request.app.state.registry
    resolved = await registry.get(body.model_config_id)
    deps = DocDeps(
        llm=resolved.client,
        settings=settings,
        detector=request.app.state.detector,
        glossary_repo=request.app.state.glossary_repo,
        emitter=None,  # 无状态接口不发事件
        store=None,
        model_params=resolved.params,
    )
    start = time.perf_counter()
    usage = Usage()
    source_lang = body.source_lang
    if not source_lang or source_lang == languages.AUTO or not languages.is_supported(source_lang):

        async def provider():
            return resolved.client

        detected = await deps.detector.detect(body.source, provider)
        source_lang = detected.lang
        usage = sum_usage(usage, detected.usage)

    protected = protect(body.source, table_row=body.block_type == "table_row")
    hits = term_hits([t.model_dump() for t in body.terms])
    ctx = chunk_context(
        hits, body.source, domain=body.domain, style=body.style, max_terms=settings.doc_prompt_max_terms
    )
    prev = [(body.prev_source, body.prev_target or "")] if body.prev_source else []
    memory = ChunkMemory(summary=body.summary or None, prev=prev)
    items = [{"id": body.seq, "text": protected.text}]
    instruction = (body.instruction or "").strip() or None
    if body.next_source:
        hint = f"下一段原文（仅供参考，不要翻译）：{body.next_source}"
        instruction = f"{instruction}\n{hint}" if instruction else hint
    messages = prompts.translate_messages(ctx, memory, items, source_lang, body.target_lang, instruction)

    for attempt in range(ATTEMPTS):
        obj, u = await call_json(deps, messages)
        usage = sum_usage(usage, u)
        got = parse_segments(obj)
        text = got.get(body.seq) or (next(iter(got.values())) if len(got) == 1 else None)
        if text is None:
            log.warning("单段重译未返回译文（第 %d 次）", attempt + 1)
            continue
        r = restore(text, protected.spans)
        if r.ok:
            latency = int((time.perf_counter() - start) * 1000)
            log.info("单段重译完成 taskId=%s seq=%s", body.task_id, body.seq)
            return ok({"target": r.text, "usage": usage_dict(usage), "latencyMs": latency})
        log.warning("单段重译标记还原失败（第 %d 次）：%s", attempt + 1, r.problem)
    raise BizException(ErrorCode.DOC_TASK_FAILED, "单段重译失败：模型未按要求返回译文或未保留受保护内容")
