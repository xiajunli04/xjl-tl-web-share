"""WS /internal/interpret/stream：同传发言流（契约 §1.8，design D7）。

- 握手头 X-Internal-Token；校验失败 → 关闭码 4401
- 首帧（文本）config 选择引擎；非法 → error(A0410, fatal) 后关闭码 4400
- 之后二进制帧 = PCM16LE 16 kHz 单声道；文本控制帧 targets / ptt / flush / mute / end
- 事件经单个发送协程串行写出（单行 JSON）；正常结束 ended 后关闭码 1000，致命错误 1011
- 全局并发发言流上限 INTERPRET_MAX_STREAMS：超出时发 error(A0212, fatal) 后关闭
"""

import asyncio
import contextlib
import hmac
import json
import logging
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from app.core.errors import ErrorCode
from app.interpret.cascade import CascadeEngine
from app.interpret.chat import CascadeChatEngine
from app.interpret.doubao_ast import DoubaoAstEngine
from app.interpret.engine import ConfigError, EngineDeps, EngineError, InterpretEngine, StreamConfig, error_event, event
from app.interpret.gemini_live_translate import GeminiLiveTranslateEngine
from app.interpret.openai_realtime import OpenAIRealtimeTranslateEngine
from app.interpret.qwen_livetranslate import QwenLiveTranslateEngine
from app.interpret.realtime_chat import RealtimeChatEngine

log = logging.getLogger("app.api.interpret")

router = APIRouter(prefix="/internal/interpret", tags=["internal"])

ENGINES: dict[str, type[InterpretEngine]] = {
    CascadeEngine.id: CascadeEngine,
    QwenLiveTranslateEngine.id: QwenLiveTranslateEngine,
    OpenAIRealtimeTranslateEngine.id: OpenAIRealtimeTranslateEngine,
    GeminiLiveTranslateEngine.id: GeminiLiveTranslateEngine,
    DoubaoAstEngine.id: DoubaoAstEngine,
    RealtimeChatEngine.id: RealtimeChatEngine,
}

CLOSE_NORMAL = 1000
CLOSE_ERROR = 1011
CLOSE_BAD_CONFIG = 4400
CLOSE_UNAUTHORIZED = 4401
CONFIG_TIMEOUT_SECONDS = 10.0
SEND_DRAIN_SECONDS = 5.0
CONTROL_TYPES = ("targets", "ptt", "flush", "mute", "interrupt")


class _Streams:
    """进程内并发发言流计数。"""

    active = 0


def _token_ok(ws: WebSocket) -> bool:
    expected = ws.app.state.settings.internal_token
    got = ws.headers.get("x-internal-token")
    return bool(got and expected and hmac.compare_digest(got.encode(), expected.encode()))


class _Sender:
    """把引擎事件串行写到 WS；emit 非阻塞，可在任意协程中调用。"""

    def __init__(self, ws: WebSocket):
        self._ws = ws
        self._queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        self._task = asyncio.create_task(self._run())

    def emit(self, ev: dict[str, Any]) -> None:
        self._queue.put_nowait(ev)

    async def _run(self) -> None:
        while True:
            ev = await self._queue.get()
            if ev is None:
                return
            try:
                await self._ws.send_text(json.dumps(ev, ensure_ascii=False, separators=(",", ":")))
            except Exception:  # noqa: BLE001 - 连接已断开：丢弃剩余事件
                return

    async def drain(self) -> None:
        self._queue.put_nowait(None)
        with contextlib.suppress(TimeoutError, asyncio.CancelledError):
            await asyncio.wait_for(self._task, SEND_DRAIN_SECONDS)

    def cancel(self) -> None:
        self._task.cancel()


async def _close(ws: WebSocket, code: int, reason: str = "") -> None:
    with contextlib.suppress(Exception):
        await ws.close(code=code, reason=reason)


async def _reject(ws: WebSocket, err: dict[str, Any], code: int) -> None:
    with contextlib.suppress(Exception):
        await ws.send_text(json.dumps(err, ensure_ascii=False))
    await _close(ws, code)


async def _read_config(ws: WebSocket) -> StreamConfig:
    msg = await asyncio.wait_for(ws.receive(), CONFIG_TIMEOUT_SECONDS)
    if msg.get("type") == "websocket.disconnect":
        raise WebSocketDisconnect(msg.get("code", 1000))
    text = msg.get("text")
    if not text:
        raise ConfigError("首帧必须是文本 config")
    try:
        data = json.loads(text)
    except ValueError as e:
        raise ConfigError("首帧不是合法 JSON") from e
    if not isinstance(data, dict) or data.get("type") != "config":
        raise ConfigError("首帧必须是 type=config")
    try:
        cfg = StreamConfig.model_validate(data)
    except ValidationError as e:
        first = e.errors()[0] if e.errors() else {}
        field = ".".join(str(p) for p in first.get("loc", ()))
        raise ConfigError(f"config 字段非法：{field} {first.get('msg', '')}".strip()) from e
    engine_cls = ENGINES.get(cfg.engine)
    if engine_cls is None:
        raise ConfigError(f"不支持的同传引擎: {cfg.engine}")
    if cfg.mode == "CHAT" and engine_cls not in (CascadeEngine, RealtimeChatEngine):
        raise ConfigError("AI 对话仅支持平台级联或实时语音模型")
    if cfg.mode != "CHAT" and engine_cls is RealtimeChatEngine:
        raise ConfigError("实时语音模型只用于 AI 对话")
    cfg.check(engine_cls.max_targets)
    return cfg


def engine_class(cfg: StreamConfig) -> type[InterpretEngine]:
    """引擎 id → 实现类；AI 对话的级联引擎复用级联识别链路，由 CascadeChatEngine 生成回复。"""
    if cfg.mode == "CHAT":
        return RealtimeChatEngine if cfg.engine == RealtimeChatEngine.id else CascadeChatEngine
    return ENGINES[cfg.engine]


@router.websocket("/stream")
async def interpret_stream(ws: WebSocket) -> None:
    await ws.accept()
    if not _token_ok(ws):
        await _close(ws, CLOSE_UNAUTHORIZED, "unauthorized")
        return
    settings = ws.app.state.settings
    if _Streams.active >= settings.interpret_max_streams:
        log.warning("同传并发发言流已达上限 %s", settings.interpret_max_streams)
        await _reject(ws, error_event(ErrorCode.TOO_MANY_REQUESTS, "同传并发已达上限，请稍后再试", True), CLOSE_ERROR)
        return
    _Streams.active += 1
    try:
        await _serve(ws)
    finally:
        _Streams.active -= 1


async def _serve(ws: WebSocket) -> None:
    try:
        cfg = await _read_config(ws)
    except (ConfigError, TimeoutError) as e:
        message = str(e) if isinstance(e, ConfigError) else "等待 config 超时"
        await _reject(ws, error_event(ErrorCode.PARAM_INVALID, message, True), CLOSE_BAD_CONFIG)
        return
    except WebSocketDisconnect:
        return

    state = ws.app.state
    deps = EngineDeps(
        settings=state.settings,
        registry=state.registry,
        glossary_repo=getattr(state, "glossary_repo", None),
        detector=getattr(state, "detector", None),
    )
    sender = _Sender(ws)
    engine = engine_class(cfg)(cfg, sender.emit, deps)
    close_code = CLOSE_NORMAL
    try:
        try:
            await engine.start()
        except EngineError as e:
            sender.emit(error_event(e.error, e.message, True))
            close_code = CLOSE_BAD_CONFIG if e.error is ErrorCode.PARAM_INVALID else CLOSE_ERROR
            log.info("同传引擎启动失败 stream=%s engine=%s: %s", cfg.stream_id, cfg.engine, e.message)
            return
        close_code = await _pump(ws, engine, sender)
    except Exception:
        log.exception("同传发言流异常 stream=%s", cfg.stream_id)
        sender.emit(error_event(ErrorCode.SYSTEM_ERROR, "同传服务异常", True))
        close_code = CLOSE_ERROR
    finally:
        await engine.close()
        await sender.drain()
        await _close(ws, close_code)
        log.info("同传发言流结束 stream=%s engine=%s code=%s", cfg.stream_id, cfg.engine, close_code)


async def _pump(ws: WebSocket, engine: InterpretEngine, sender: _Sender) -> int:
    """收帧循环；返回关闭码。"""
    fatal = asyncio.create_task(engine.fatal.wait())
    try:
        while True:
            recv = asyncio.create_task(ws.receive())
            done, _ = await asyncio.wait({recv, fatal}, return_when=asyncio.FIRST_COMPLETED)
            if fatal in done:
                recv.cancel()
                return CLOSE_ERROR
            msg = recv.result()
            if msg.get("type") == "websocket.disconnect":
                return CLOSE_NORMAL
            if msg.get("bytes"):
                await engine.feed(msg["bytes"])
                continue
            text = msg.get("text")
            if not text:
                continue
            try:
                ctrl = json.loads(text)
            except ValueError:
                continue
            kind = ctrl.get("type") if isinstance(ctrl, dict) else None
            if kind == "end":
                await engine.finish()
                if engine.fatal.is_set():
                    return CLOSE_ERROR
                sender.emit(event("ended", reason="user_end"))
                return CLOSE_NORMAL
            if kind in CONTROL_TYPES:
                await engine.control(ctrl)
    finally:
        fatal.cancel()
