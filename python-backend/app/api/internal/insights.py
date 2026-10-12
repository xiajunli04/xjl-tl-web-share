"""译文解读接口（design D11，契约 §1.6 / §1.7）。

- POST /internal/insights：JSON 信封，data 为 {alternatives, expressions, summary, usage}；原文超长 → A0410
- POST /internal/insights/ask：SSE，事件为 delta / done / error（无 start）；参数校验失败时在建立流之前返回 JSON
"""

import logging

from fastapi import APIRouter, Depends, Request
from fastapi.sse import EventSourceResponse

from app.api.internal.translate import _sse_response
from app.core.config import Settings
from app.core.errors import BizException, ok
from app.core.logging import get_trace_id
from app.core.security import verify_internal_token
from app.insights.service import AskRequest, InsightsRequest, ask_events, get_insights
from app.llm.base import LLMError
from app.llm.registry import LLMRegistry

log = logging.getLogger("app.api.insights")

router = APIRouter(prefix="/internal/insights", tags=["internal"], dependencies=[Depends(verify_internal_token)])


@router.post("")
async def insights(body: InsightsRequest, request: Request) -> dict:
    settings: Settings = request.app.state.settings
    body.check(settings.insights_max_chars)
    registry: LLMRegistry = request.app.state.registry
    resolved = await registry.get(body.model_config_id)  # 未指定时取 CHAT 默认模型；不存在/停用 -> C0130
    log.info(
        "请求解读 model=%s %s->%s len=%d", resolved.config.id, body.source_lang, body.target_lang, len(body.source)
    )
    try:
        data = await get_insights(resolved.client, body, settings.insights_max_tokens)
    except LLMError as e:  # LLM 调用失败按错误码返回（C0120–C0123），HTTP 状态与错误码表一致
        log.warning("解读失败 kind=%s", e.kind)
        raise BizException(e.error_code, e.message) from None
    return ok(data)


@router.post("/ask")
async def insights_ask(body: AskRequest, request: Request) -> EventSourceResponse:
    settings: Settings = request.app.state.settings
    body.check(settings.insights_max_chars)
    registry: LLMRegistry = request.app.state.registry
    resolved = await registry.get(body.model_config_id)
    log.info("解读追问 model=%s history=%d", resolved.config.id, len(body.history))
    return _sse_response(
        lambda: ask_events(resolved.client, body, settings.insights_max_tokens),
        settings,
        get_trace_id(),
        with_start=False,
    )
