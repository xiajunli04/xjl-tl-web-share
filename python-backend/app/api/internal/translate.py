"""POST /internal/translate/stream：SSE 翻译流（design D5）；追问恢复与放弃（add-session-context-and-memory D4）。

- 参数校验、模型配置解析在建立流之前完成，失败时返回普通 JSON（A0410 / A0420 / C0130 / B0100）
- 流建立后：start → node/detect/terms/plan/delta/review/memory … → final | error | clarify，data 一律为单行 JSON
- POST /internal/translate/resume：以 Command(resume=answer) 从追问断点继续，事件协议相同；thread 不存在 → error(A0440)
- DELETE /internal/translate/threads/{threadId}：放弃追问，删除检查点（不存在也返回成功）
- 空闲时每 sse_heartbeat_seconds 秒发送 `: ping` 注释心跳
- 总时长超过 translate_total_timeout_seconds 时发送 error(C0141) 并结束
- 客户端断开时取消图任务，正在进行的 LLM 请求随之关闭。取消由响应对象兜底：断开时生成器可能停在 yield
  处（取消落在 send 上），生成器不会被唤醒也不会被关闭，其 finally 不执行，因此不能只依赖生成器自身的清理
"""

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Callable
from typing import Any

import anyio
from fastapi import APIRouter, Depends, Request
from fastapi.sse import KEEPALIVE_COMMENT, EventSourceResponse, format_sse_event
from pydantic import Field

from app.agent.graph import THREAD_PREFIX, resume_agent, run_agent
from app.agent.nodes.base import AgentDeps, AgentError
from app.agent.nodes.session import MAX_ANSWER_CHARS
from app.agent.state import TranslateRequest
from app.core.config import Settings
from app.core.errors import BizException, ErrorCode, ok
from app.core.logging import get_trace_id, trace_id_var
from app.core.schema import CamelModel
from app.core.security import verify_internal_token
from app.llm.base import LLMError
from app.llm.registry import LLMRegistry
from app.llm.reviewer import ReviewerSource

log = logging.getLogger("app.api.translate")

router = APIRouter(prefix="/internal/translate", tags=["internal"], dependencies=[Depends(verify_internal_token)])

CANCEL_WAIT_SECONDS = 5.0
_DONE = object()
TERMINAL_EVENTS = ("final", "error", "clarify")
EventSource = Callable[[], AsyncIterator[tuple[str, dict[str, Any]]]]


class _RunHandle:
    """一次翻译的后台任务句柄：生成器与响应对象共同持有，任一方结束时都能幂等地取消任务。"""

    def __init__(self, request_id: str) -> None:
        self.request_id = request_id
        self.task: asyncio.Task | None = None
        self.outcome = "disconnected"
        self._logged = False

    async def shutdown(self) -> None:
        task = self.task
        if self.outcome == "disconnected" and not self._logged:
            self._logged = True
            # 上游（Spring）优雅关闭连接时，uvicorn 要到下一次写入才感知断开，此时在途的 LLM 调用可能已经结束
            state = "取消翻译任务" if task is not None and not task.done() else "翻译任务已结束"
            log.info("客户端已断开，%s requestId=%s", state, self.request_id)
        if task is None or task.done():
            return
        task.cancel()
        # 断开时外层处于取消状态，需要屏蔽取消才能等待任务真正结束（LLM 连接被关闭）
        with anyio.CancelScope(shield=True):
            await asyncio.wait({task}, timeout=CANCEL_WAIT_SECONDS)


class _CancellingEventSourceResponse(EventSourceResponse):
    """响应结束（正常完成、客户端断开或被取消）时，确保后台 Agent 任务被取消。"""

    def __init__(self, content: AsyncIterator[bytes], handle: _RunHandle, **kwargs: Any) -> None:
        super().__init__(content, **kwargs)
        self._handle = handle

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            await self._handle.shutdown()


def sse_event(event: str, data: dict[str, Any]) -> bytes:
    return format_sse_event(event=event, data_str=json.dumps(data, ensure_ascii=False, separators=(",", ":")))


def error_payload(exc: BaseException) -> dict[str, str]:
    if isinstance(exc, LLMError):
        return {"code": exc.error_code.code, "message": exc.message}
    if isinstance(exc, BizException):
        return {"code": exc.error.code, "message": exc.message}
    if isinstance(exc, AgentError):
        return {"code": exc.error_code.code, "message": exc.message}
    log.error("Agent 执行异常: %s", type(exc).__name__, exc_info=exc)
    return {"code": ErrorCode.AGENT_FAILED.code, "message": ErrorCode.AGENT_FAILED.message}


async def translation_events(
    source: EventSource,
    settings: Settings,
    handle: _RunHandle,
    *,
    with_start: bool = True,
    timeout_seconds: float | None = None,
) -> AsyncIterator[bytes]:
    """with_start=False 时不发送 start 事件（解读追问的事件只有 delta/done/error）；
    timeout_seconds 为空时使用 translate_total_timeout_seconds（图片翻译含两次 LLM 调用，单独指定）。"""
    request_id = handle.request_id
    total_timeout = timeout_seconds or settings.translate_total_timeout_seconds
    queue: asyncio.Queue[Any] = asyncio.Queue()

    async def produce() -> None:
        try:
            async for item in source():
                queue.put_nowait(item)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 - 统一转为 error 事件
            queue.put_nowait(("error", error_payload(e)))
        finally:
            queue.put_nowait(_DONE)

    loop = asyncio.get_running_loop()
    deadline = loop.time() + total_timeout
    try:
        if with_start:
            yield sse_event("start", {"requestId": request_id})
        handle.task = asyncio.create_task(produce())
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                handle.outcome = "timeout"
                log.warning("翻译超时（%.0f 秒），取消 Agent 任务", total_timeout)
                yield sse_event(
                    "error",
                    {"code": ErrorCode.TRANSLATE_TIMEOUT.code, "message": f"翻译超时（超过 {total_timeout:.0f} 秒）"},
                )
                break
            try:
                item = await asyncio.wait_for(queue.get(), timeout=min(settings.sse_heartbeat_seconds, remaining))
            except TimeoutError:
                if loop.time() < deadline:
                    yield KEEPALIVE_COMMENT
                continue
            if item is _DONE:
                handle.outcome = "done"
                break
            event, data = item
            yield sse_event(event, data)
            if event in TERMINAL_EVENTS:
                handle.outcome = event
                if event == "error":
                    log.warning("翻译失败 code=%s message=%s", data.get("code"), data.get("message"))
                break
    finally:
        await handle.shutdown()
        if handle.outcome == "final":
            log.info("翻译完成 requestId=%s", request_id)
        elif handle.outcome == "clarify":
            log.info("等待用户澄清 requestId=%s", request_id)


def _deps(request: Request, resolved: Any, review_model_config_id: int | None) -> AgentDeps:
    registry: LLMRegistry = request.app.state.registry
    return AgentDeps(
        llm=resolved.client,
        settings=request.app.state.settings,
        detector=request.app.state.detector,
        glossary_repo=request.app.state.glossary_repo,
        model_params=resolved.params,
        reviewer=ReviewerSource.of(resolved, review_model_config_id, registry.get),
        tm=getattr(request.app.state, "tm", None),
    )


def _sse_response(
    source: EventSource,
    settings: Settings,
    trace_id: str,
    *,
    with_start: bool = True,
    timeout_seconds: float | None = None,
) -> EventSourceResponse:
    handle = _RunHandle(trace_id)

    async def stream() -> AsyncIterator[bytes]:
        # 响应体在中间件返回之后才开始迭代，这里重新绑定 traceId 以便日志关联
        trace_id_var.set(trace_id)
        events = translation_events(source, settings, handle, with_start=with_start, timeout_seconds=timeout_seconds)
        async for chunk in events:
            yield chunk

    return _CancellingEventSourceResponse(
        stream(), handle, headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )


@router.post("/stream")
async def translate_stream(body: TranslateRequest, request: Request) -> EventSourceResponse:
    settings: Settings = request.app.state.settings
    body.check(settings.translate_max_text_length)
    registry: LLMRegistry = request.app.state.registry
    resolved = await registry.get(body.model_config_id)  # 不存在/停用 -> C0130（建立流之前）
    deps = _deps(request, resolved, body.review_model_config_id)
    trace_id = get_trace_id()
    log.info(
        "开始翻译 userId=%s model=%s reviewModel=%s mode=%s %s->%s len=%d glossaries=%s session=%s",
        body.user_id,
        resolved.config.id,
        body.review_model_config_id,
        body.mode,
        body.source_lang,
        body.target_lang,
        len(body.text),
        body.glossary_ids,
        body.session.session_id if body.session else None,
    )
    hitl = getattr(request.app.state, "hitl", None)
    return _sse_response(lambda: run_agent(body, deps, request_id=trace_id, hitl=hitl), settings, trace_id)


class ResumeRequest(CamelModel):
    thread_id: str = Field(min_length=1, max_length=128)
    answer: str = Field(min_length=1, max_length=MAX_ANSWER_CHARS)
    user_id: int | None = None


async def _expired() -> AsyncIterator[tuple[str, dict[str, Any]]]:
    yield "error", {"code": ErrorCode.CLARIFY_EXPIRED.code, "message": "追问已失效，请重新提交原文"}


@router.post("/resume")
async def translate_resume(body: ResumeRequest, request: Request) -> EventSourceResponse:
    settings: Settings = request.app.state.settings
    if not body.answer.strip():
        raise BizException(ErrorCode.PARAM_INVALID, "回答不能为空")
    trace_id = get_trace_id()
    hitl = getattr(request.app.state, "hitl", None)
    snap = await hitl.snapshot(body.thread_id, settings.agent_max_refine_rounds) if hitl is not None else None
    req: TranslateRequest | None = snap.values.get("request") if snap is not None else None
    if req is None or (body.user_id is not None and req.user_id is not None and req.user_id != body.user_id):
        log.info("追问已失效 threadId=%s userId=%s", body.thread_id, body.user_id)
        return _sse_response(_expired, settings, trace_id)
    registry: LLMRegistry = request.app.state.registry
    resolved = await registry.get(req.model_config_id)
    deps = _deps(request, resolved, req.review_model_config_id)
    log.info("恢复翻译 threadId=%s userId=%s model=%s", body.thread_id, body.user_id, resolved.config.id)
    answer = body.answer.strip()
    return _sse_response(lambda: resume_agent(body.thread_id, answer, snap, deps, hitl), settings, trace_id)


@router.delete("/threads/{thread_id}")
async def delete_thread(thread_id: str, request: Request) -> dict:
    """放弃追问：删除检查点；不存在也返回成功。只允许删除 turn:* thread（文档任务的 thread 不受影响）。"""
    if not thread_id.startswith(THREAD_PREFIX):
        raise BizException(ErrorCode.PARAM_INVALID, "threadId 不合法")
    hitl = getattr(request.app.state, "hitl", None)
    if hitl is not None:
        await hitl.delete_thread(thread_id)
    log.info("放弃追问，已删除检查点 threadId=%s", thread_id)
    return ok(None)
