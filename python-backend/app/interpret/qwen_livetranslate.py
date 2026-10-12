"""百炼 qwen3.8 / 3.5-livetranslate-flash-realtime 语音到语音同传引擎（design D6）。

协议按 2026-10-04 真实联调抓取的事件序列实现（tests/fixtures/interpret/qwen_livetranslate_events.jsonl）：
- 地址 wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=…，Header Authorization: Bearer <key>
- session.update：3.8 用 output_modalities；3.5 用 modalities + input_audio_format/output_audio_format。
  必须显式传 voice（默认 Tina，模型配置 extra.voice 可覆盖），否则默认音色 Chelsie 报错；
  translation.language 为目标语言，术语库写入 translation.corpus.phrases；input_audio_transcription 获取原文
- 上行 input_audio_buffer.append（PCM16 16 kHz base64，约 100 ms 一包），结束 session.finish → session.finished
- 每句话：speech_started(输入条目 X) → input_audio_transcription.delta(X)…
  / response.audio_transcript.delta(输出条目 Y)… / response.audio.delta(Y，PCM16 24 kHz)…
  → speech_stopped(X) → input_audio_transcription.completed(X)
  → response.audio_transcript.done(Y) → response.audio.done(Y) → response.done。
  Y 由 conversation.item.created 的 previous_item_id=X 关联；译文与译音在说话过程中即开始输出（同声）

映射：transcription.delta → transcript.partial（累计全文）；completed → transcript.final；audio_transcript.delta/done →
translation.delta/final；audio.delta/done → audio（pcm16 24 kHz）；response.done → metrics。
每个目标语言一个上游会话；会议室中各会话收到同一路音频，按各自第 k 句对齐到同一 utteranceId，原文只取首个会话。
建连失败（TLS 重置等）最多重试 interpret_upstream_retries 次、指数退避；会话中途断开时发非致命 C0174 并重建一次。
"""

import asyncio
import base64
import contextlib
import json
import logging
import time
from dataclasses import dataclass
from typing import Any

from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, WebSocketException

from app.core.config import get_settings
from app.core.errors import ErrorCode
from app.repositories.model_config import ModelConfig
from app.speech.engines import DASHSCOPE, QWEN_LIVETRANSLATE, S2S_MAX_TARGETS
from app.speech.tts import PCM16, TTS_SAMPLE_RATE

from .engine import (
    SIDE_A,
    SIDE_B,
    AudioSequencer,
    EngineError,
    InterpretEngine,
    StreamConfig,
    ms_since,
    room_targets,
)
from .s2s import resolve_config

log = logging.getLogger("app.interpret.qwen")

DEFAULT_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime"
ASR_MODEL = "qwen3-asr-flash-realtime"
APPEND_BYTES = 3200  # 100 ms PCM16 16 kHz
SILENCE_FLUSH = b"\x00" * (16000 * 2 * 9 // 10)  # 0.9 s 静音：服务端 VAD 静音阈值 800 ms，用于强制断句
OPEN_TIMEOUT_SECONDS = 10.0
SESSION_READY_TIMEOUT_SECONDS = 10.0
FINISH_TIMEOUT_SECONDS = 15.0
PROBE_ERROR_WAIT_SECONDS = 0.5
MAX_PHRASES = 200
TRANSCRIPTION_DELTA = "conversation.item.input_audio_transcription.delta"
TRANSCRIPTION_TEXT = "conversation.item.input_audio_transcription.text"  # 文档中的另一种形式（text + stash）
BACKOFF_BASE_SECONDS = 0.5


class UpstreamError(Exception):
    """上游返回 error 事件（配置错误等，不重试）。"""


def realtime_url(cfg: ModelConfig) -> str:
    base = (cfg.base_url or DEFAULT_URL).rstrip("/")
    if base.startswith("https://"):
        base = "wss://" + base[len("https://") :]
    elif base.startswith("http://"):
        base = "ws://" + base[len("http://") :]
    sep = "&" if "?" in base else "?"
    return f"{base}{sep}model={cfg.model_name}"


def is_legacy_model(model_name: str) -> bool:
    """3.5 版使用 modalities + input/output_audio_format 的旧字段。"""
    return "3.5-livetranslate" in model_name


def build_session(model_name: str, target: str, voice: str, phrases: dict[str, str] | None = None) -> dict[str, Any]:
    translation: dict[str, Any] = {"language": target}
    if phrases:
        translation["corpus"] = {"phrases": phrases}
    session: dict[str, Any] = {
        "voice": voice,
        "input_audio_transcription": {"model": ASR_MODEL},
        "translation": translation,
    }
    if is_legacy_model(model_name):
        session.update(modalities=["text", "audio"], input_audio_format="pcm", output_audio_format="pcm")
    else:
        session["output_modalities"] = ["text", "audio"]
    return session


def voice_of(cfg: ModelConfig) -> str:
    return cfg.extra.get("voice") or get_settings().interpret_qwen_default_voice


def _error_message(ev: dict[str, Any]) -> str:
    err = ev.get("error") or {}
    if isinstance(err, dict):
        return str(err.get("message") or err.get("code") or "未知错误")
    return str(err)


async def open_session(url: str, api_key: str, session: dict[str, Any], retries: int) -> ClientConnection:
    """建连并完成 session.update（等到 session.updated）；网络错误按指数退避重试，上游 error 事件不重试。"""
    last: Exception | None = None
    for attempt in range(retries + 1):
        ws: ClientConnection | None = None
        try:
            ws = await connect(
                url,
                additional_headers={"Authorization": f"Bearer {api_key}"},
                open_timeout=OPEN_TIMEOUT_SECONDS,
                max_size=None,
            )
            await ws.send(json.dumps({"type": "session.update", "session": session}, ensure_ascii=False))
            async with asyncio.timeout(SESSION_READY_TIMEOUT_SECONDS):
                while True:
                    ev = json.loads(await ws.recv())
                    if ev.get("type") == "session.updated":
                        return ws
                    if ev.get("type") == "error":
                        raise UpstreamError(_error_message(ev))
        except UpstreamError:
            if ws is not None:
                await ws.close()
            raise
        except (OSError, WebSocketException, TimeoutError) as e:
            if ws is not None:
                with contextlib.suppress(Exception):
                    await ws.close()
            last = e
            log.info("百炼同传建连失败（第 %s 次）: %s", attempt + 1, type(e).__name__)
            if attempt < retries:
                await asyncio.sleep(BACKOFF_BASE_SECONDS * 2**attempt)
    raise EngineError(ErrorCode.REALTIME_UPSTREAM_FAILED, f"百炼同传连接失败（{type(last).__name__}）")


async def probe(cfg: ModelConfig, api_key: str) -> str:
    """连通性测试：建立会话、完成配置后关闭（校验 session.updated 之后短时间内没有 error）。"""
    session = build_session(cfg.model_name, "en", voice_of(cfg))
    try:
        ws = await open_session(realtime_url(cfg), api_key, session, get_settings().interpret_upstream_retries)
    except UpstreamError as e:
        raise EngineError(ErrorCode.REALTIME_UPSTREAM_FAILED, f"百炼同传会话配置失败：{e}") from None
    try:
        with contextlib.suppress(TimeoutError):
            async with asyncio.timeout(PROBE_ERROR_WAIT_SECONDS):
                while True:
                    ev = json.loads(await ws.recv())
                    if ev.get("type") == "error":
                        raise EngineError(ErrorCode.REALTIME_UPSTREAM_FAILED, f"百炼同传会话错误：{_error_message(ev)}")
    finally:
        await ws.close()
    return "会话已建立"


@dataclass
class _Utt:
    uid: int
    started_ms: int | None = None
    ended_ms: int | None = None
    partial: str = ""
    t_end: float | None = None  # speech_stopped 到达时刻（e2e 起点）
    asr_done_at: float | None = None
    final_at: float | None = None
    first_audio_after_end: float | None = None
    audio_ended: bool = False


class _QwenSession:
    """一个目标语言的上游会话。"""

    def __init__(
        self,
        engine: "QwenLiveTranslateEngine",
        target: str,
        primary: bool,
        index_base: int = 0,
        transcribe_only: bool = False,
    ):
        self.engine = engine
        self.target = target
        self.primary = primary  # 是否发出原文事件（会议室中只有首个会话发）
        # 单人会议室没有翻译目标：借一个占位目标语言建立上游会话，只转发原文与指标，丢弃译文和译音
        self.transcribe_only = transcribe_only
        self.reconnected = False
        self._index = index_base
        self._ws: ClientConnection | None = None
        self._reader: asyncio.Task | None = None
        self._buf = bytearray()
        self._closing = False
        self._finished = asyncio.Event()
        self._items: dict[str, int] = {}  # 条目 id → uid
        self._utts: dict[int, _Utt] = {}
        self._cur: _Utt | None = None
        self._sequencer = AudioSequencer(engine._emit_fn)

    @property
    def index(self) -> int:
        return self._index

    async def connect(self) -> None:
        eng = self.engine
        cfg = eng.model_cfg
        session = build_session(cfg.model_name, self.target, voice_of(cfg), eng.phrases(self.target))
        try:
            self._ws = await open_session(
                realtime_url(eng.model_cfg), eng.api_key, session, eng.deps.settings.interpret_upstream_retries
            )
        except UpstreamError as e:
            raise EngineError(ErrorCode.REALTIME_UPSTREAM_FAILED, f"百炼同传会话配置失败：{e}") from None
        self._reader = asyncio.create_task(self._read(self._ws))

    async def send_audio(self, pcm: bytes) -> None:
        self._buf += pcm
        if len(self._buf) >= APPEND_BYTES:
            await self.flush_buffer()

    async def flush_buffer(self) -> None:
        if not self._buf or self._ws is None:
            return
        data = bytes(self._buf)
        self._buf.clear()
        msg = {"type": "input_audio_buffer.append", "audio": base64.b64encode(data).decode("ascii")}
        with contextlib.suppress(ConnectionClosed):
            await self._ws.send(json.dumps(msg))

    async def push_silence(self) -> None:
        """送入一段静音，促使服务端 VAD 断句（flush / 按键松开 / 静音）。"""
        await self.send_audio(SILENCE_FLUSH)
        await self.flush_buffer()

    async def finish(self) -> None:
        await self.flush_buffer()
        self._closing = True
        if self._ws is not None:
            with contextlib.suppress(ConnectionClosed):
                await self._ws.send(json.dumps({"type": "session.finish"}))
            with contextlib.suppress(TimeoutError):
                async with asyncio.timeout(FINISH_TIMEOUT_SECONDS):
                    await self._finished.wait()
        await self.close()

    async def close(self) -> None:
        self._closing = True
        if self._ws is not None:
            with contextlib.suppress(Exception):
                await self._ws.close()
        if self._reader is not None and not self._reader.done() and self._reader is not asyncio.current_task():
            self._reader.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._reader

    async def _read(self, ws: ClientConnection) -> None:
        try:
            async for raw in ws:
                try:
                    ev = json.loads(raw)
                except (TypeError, ValueError):
                    continue
                await self._handle(ev)
        except ConnectionClosed:
            pass
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("百炼同传事件处理异常 target=%s", self.target)
        if not self._closing and ws is self._ws:
            self.engine.session_lost(self)

    # ---------------- 事件映射 ----------------

    def _new_utt(self, item_id: str | None) -> _Utt:
        self._index += 1
        utt = _Utt(uid=self.engine.allocate_uid(self, self._index))
        if item_id:
            self._items[item_id] = utt.uid
        self._utts[utt.uid] = utt
        self._cur = utt
        self._sequencer.open(utt.uid, [self.target], PCM16, TTS_SAMPLE_RATE)
        return utt

    def _utt_of(self, item_id: str | None) -> _Utt:
        uid = self._items.get(item_id or "")
        if uid is not None and uid in self._utts:
            return self._utts[uid]
        if self._cur is not None:
            if item_id:
                self._items[item_id] = self._cur.uid
            return self._cur
        return self._new_utt(item_id)

    async def _handle(self, ev: dict[str, Any]) -> None:
        kind = ev.get("type")
        eng = self.engine
        if kind == "input_audio_buffer.speech_started":
            utt = self._new_utt(ev.get("item_id"))
            utt.started_ms = ev.get("audio_start_ms")
        elif kind == "conversation.item.created":
            item = ev.get("item") or {}
            prev = ev.get("previous_item_id")
            is_input = any(c.get("type") == "input_audio" for c in item.get("content") or [] if isinstance(c, dict))
            if not is_input and item.get("id") and item["id"] not in self._items and prev in self._items:
                self._items[item["id"]] = self._items[prev]
        elif kind in (TRANSCRIPTION_DELTA, TRANSCRIPTION_TEXT):
            utt = self._utt_of(ev.get("item_id"))
            if kind.endswith(".delta"):
                utt.partial += ev.get("delta") or ""
                text = utt.partial
            else:  # 文档中的 text/stash 形式：已定稿部分 + 暂定部分
                text = (ev.get("text") or "") + (ev.get("stash") or "")
            if self.primary and text.strip():
                eng.emit("transcript.partial", utteranceId=utt.uid, text=text.strip())
        elif kind == "conversation.item.input_audio_transcription.completed":
            utt = self._utt_of(ev.get("item_id"))
            utt.asr_done_at = time.perf_counter()
            text = (ev.get("transcript") or utt.partial).strip()
            if self.primary and text:
                eng.emit(
                    "transcript.final",
                    utteranceId=utt.uid,
                    text=text,
                    lang=await eng.source_lang(text, self.target),
                    startedMs=utt.started_ms,
                    endedMs=utt.ended_ms,
                )
        elif kind == "input_audio_buffer.speech_stopped":
            utt = self._utt_of(ev.get("item_id"))
            utt.ended_ms = ev.get("audio_end_ms")
            utt.t_end = time.perf_counter()
        elif self.transcribe_only and kind.startswith("response.") and kind != "response.done":
            return
        elif kind in ("response.audio_transcript.delta", "response.audio_transcript.text"):
            utt = self._utt_of(ev.get("item_id"))
            delta = ev.get("delta") if kind.endswith(".delta") else ev.get("text")
            if delta:
                eng.emit("translation.delta", utteranceId=utt.uid, lang=self.target, delta=delta)
        elif kind == "response.audio_transcript.done":
            utt = self._utt_of(ev.get("item_id"))
            utt.final_at = time.perf_counter()
            eng.emit(
                "translation.final",
                utteranceId=utt.uid,
                lang=self.target,
                text=(ev.get("transcript") or "").strip(),
                ttsFallback=False,
            )
        elif kind == "response.audio.delta":
            utt = self._utt_of(ev.get("item_id"))
            if utt.t_end is not None and utt.first_audio_after_end is None:
                utt.first_audio_after_end = time.perf_counter()
            with contextlib.suppress(ValueError, TypeError):
                self._sequencer.push(utt.uid, self.target, base64.b64decode(ev.get("delta") or ""))
        elif kind == "response.audio.done":
            utt = self._utt_of(ev.get("item_id"))
            utt.audio_ended = True
            self._sequencer.end(utt.uid, self.target)
        elif kind == "response.done":
            output = (ev.get("response") or {}).get("output") or []
            ids = [o.get("id") for o in output if isinstance(o, dict)]
            uid = next((self._items[i] for i in ids if i in self._items), None)
            utt = self._utts.get(uid) if uid is not None else self._cur
            if utt is not None:
                self._complete(utt)
        elif kind == "error":
            eng.emit_error(ErrorCode.REALTIME_UPSTREAM_FAILED, f"百炼同传：{_error_message(ev)}")
        elif kind == "session.finished":
            self._finished.set()

    def _complete(self, utt: _Utt) -> None:
        if self.transcribe_only:
            self._utts.pop(utt.uid, None)
            if self._cur is utt:
                self._cur = None
            if self.primary:
                asr = ms_since(utt.t_end, utt.asr_done_at) if utt.t_end and utt.asr_done_at else None
                self.engine.emit(
                    "metrics", utteranceId=utt.uid, asrMs=asr, mtFirstMs=None, mtMs=None, ttsFirstMs=None, e2eMs=asr
                )
            return
        if not utt.audio_ended:
            utt.audio_ended = True
            self._sequencer.end(utt.uid, self.target)
        self._utts.pop(utt.uid, None)
        if self._cur is utt:
            self._cur = None
        if not self.primary:
            return
        end = utt.first_audio_after_end or utt.final_at
        self.engine.emit(
            "metrics",
            utteranceId=utt.uid,
            asrMs=ms_since(utt.t_end, utt.asr_done_at) if utt.t_end and utt.asr_done_at else None,
            mtFirstMs=None,
            mtMs=ms_since(utt.t_end, utt.final_at) if utt.t_end and utt.final_at else None,
            ttsFirstMs=None,
            e2eMs=ms_since(utt.t_end, end) if utt.t_end and end else None,
        )


class QwenLiveTranslateEngine(InterpretEngine):
    id = QWEN_LIVETRANSLATE
    max_targets = S2S_MAX_TARGETS

    def __init__(self, cfg: StreamConfig, emit, deps):
        super().__init__(cfg, emit, deps)
        self.model_cfg: ModelConfig | None = None
        self.api_key = ""
        self._sessions: dict[str, _QwenSession] = {}
        self._glossaries: dict = {}
        self._ptt: str | None = None
        self._muted = False
        self._finishing = False
        self._uids: dict[Any, int] = {}
        self._bg: set[asyncio.Task] = set()

    # ---------------- 生命周期 ----------------

    async def start(self) -> None:
        cfg = self.cfg
        if cfg.mode == "CONVERSE" and cfg.converse_routing != "ptt":
            raise EngineError(ErrorCode.PARAM_INVALID, "该引擎仅支持按键说话")
        # 未指定配置时取 DASHSCOPE 的启用配置（REALTIME_TRANSLATE 下可能同时有多家厂商的配置）
        self.model_cfg, self.api_key = await resolve_config(
            self.deps.registry, DASHSCOPE, cfg.model_config_id, "百炼实时同传"
        )
        self._glossaries = await self.load_glossaries()
        targets = self._initial_targets()
        sessions = [_QwenSession(self, t, primary=(cfg.mode == "CONVERSE" or i == 0)) for i, t in enumerate(targets)]
        if not sessions and cfg.mode == "ROOM":
            sessions = [self._placeholder_session()]
        results = await asyncio.gather(*(s.connect() for s in sessions), return_exceptions=True)
        failed = next((r for r in results if isinstance(r, BaseException)), None)
        if failed is not None:
            await asyncio.gather(*(s.close() for s in sessions), return_exceptions=True)
            if isinstance(failed, EngineError):
                raise failed
            raise EngineError(ErrorCode.REALTIME_UPSTREAM_FAILED, "百炼同传连接失败") from failed
        self._sessions = {s.target: s for s in sessions}
        self.emit_ready()
        log.info("百炼同传开始 stream=%s model=%s targets=%s", cfg.stream_id, self.model_cfg.model_name, targets)

    def _initial_targets(self) -> list[str]:
        cfg = self.cfg
        if cfg.mode == "LISTEN":
            return cfg.target_langs[:1]
        if cfg.mode == "CONVERSE":
            return list(cfg.pair)
        return room_targets(cfg.declared_source, cfg.target_langs)[: self.max_targets]

    async def feed(self, pcm: bytes) -> None:
        if self._muted or not pcm:
            return
        for s in self._active_sessions():
            await s.send_audio(pcm)

    def _active_sessions(self, side: str | None = None) -> list[_QwenSession]:
        if self.cfg.mode != "CONVERSE":
            return list(self._sessions.values())
        side = side or self._ptt
        if side not in (SIDE_A, SIDE_B):
            return []  # 语音到语音引擎只支持按键说话：未按键时不送音频
        a, b = self.cfg.pair
        target = b if side == SIDE_A else a
        s = self._sessions.get(target)
        return [s] if s else []

    async def control(self, msg: dict[str, Any]) -> None:
        kind = msg.get("type")
        if kind == "targets" and self.cfg.mode == "ROOM":
            await self._update_targets(msg.get("targetLangs") or [])
        elif kind == "ptt":
            side = msg.get("side")
            prev = self._ptt
            self._ptt = side if side in (SIDE_A, SIDE_B) else None
            if prev and prev != self._ptt:
                for s in self._active_sessions(prev):
                    await s.push_silence()
        elif kind == "flush":
            for s in self._active_sessions():
                await s.push_silence()
        elif kind == "mute":
            muted = bool(msg.get("muted"))
            if muted and not self._muted:
                for s in self._active_sessions():
                    await s.push_silence()
            self._muted = muted

    def _placeholder_session(self, index_base: int = 0) -> _QwenSession:
        """单人会议室：目标取英语（发言人说英语时取中文），只转发原文。"""
        target = "zh" if self.cfg.declared_source == "en" else "en"
        return _QwenSession(self, target, primary=True, index_base=index_base, transcribe_only=True)

    async def _update_targets(self, targets: list[str]) -> None:
        wanted = room_targets(self.cfg.declared_source, [t for t in targets if isinstance(t, str)])[: self.max_targets]
        if not wanted:
            if not all(s.transcribe_only for s in self._sessions.values()) or not self._sessions:
                base = max((s.index for s in self._sessions.values()), default=0)
                for t in list(self._sessions):
                    self._spawn(self._sessions.pop(t).finish())
                placeholder = self._placeholder_session(base)
                self._sessions[placeholder.target] = placeholder
                self._spawn(self._connect_new(placeholder))
            return
        for t in [t for t, s in self._sessions.items() if t not in wanted or s.transcribe_only]:
            self._spawn(self._sessions.pop(t).finish())
        if self._sessions and not any(s.primary for s in self._sessions.values()):
            next(iter(self._sessions.values())).primary = True
        base = max((s.index for s in self._sessions.values()), default=0)
        for t in [t for t in wanted if t not in self._sessions]:
            s = _QwenSession(self, t, primary=not self._sessions, index_base=base)
            self._sessions[t] = s
            self._spawn(self._connect_new(s))

    async def _connect_new(self, s: _QwenSession) -> None:
        try:
            await s.connect()
        except EngineError as e:
            self._sessions.pop(s.target, None)
            self.emit_error(e.error, f"{s.target} 会话建立失败：{e.message}")

    def _spawn(self, coro) -> None:
        task = asyncio.create_task(coro)
        self._bg.add(task)
        task.add_done_callback(self._bg.discard)

    async def finish(self) -> None:
        self._finishing = True
        await asyncio.gather(*(s.finish() for s in self._sessions.values()), return_exceptions=True)
        if self._bg:
            await asyncio.wait(list(self._bg), timeout=FINISH_TIMEOUT_SECONDS)

    async def close(self) -> None:
        self._finishing = True
        await asyncio.gather(*(s.close() for s in self._sessions.values()), return_exceptions=True)
        for t in list(self._bg):
            t.cancel()

    # ---------------- 供会话回调 ----------------

    def allocate_uid(self, session: _QwenSession, index: int) -> int:
        """会议室各会话收到同一路音频：第 k 句对齐到同一 utteranceId；其他模式各会话独立分配。"""
        key: Any = index if self.cfg.mode == "ROOM" else (session.target, index)
        uid = self._uids.get(key)
        if uid is None:
            uid = self._uids[key] = self.next_uid()
        return uid

    def phrases(self, target: str) -> dict[str, str]:
        """热词：目标语言匹配的术语库全部术语（源语种已知时还要求源语种一致）。"""
        source = self.cfg.declared_source
        out: dict[str, str] = {}
        for g in self._glossaries.values():
            if g.target_lang != target or (source and g.source_lang != source):
                continue
            for term in g.terms:
                if len(out) >= MAX_PHRASES:
                    return out
                out.setdefault(term.source_term, term.target_term)
        return out

    async def source_lang(self, text: str, target: str) -> str | None:
        """原文语种：双向对话为该会话目标语言的另一侧；收听 / 会议室为声明的源语种，否则用 lingua 判定。"""
        if self.cfg.mode == "CONVERSE":
            a, b = self.cfg.pair
            return a if target == b else b
        return self.cfg.declared_source or await self.detect_lang(text)

    def session_lost(self, session: _QwenSession) -> None:
        if self._finishing or self.fatal.is_set():
            return
        if session.reconnected:
            self.fail(EngineError(ErrorCode.REALTIME_UPSTREAM_FAILED, "百炼同传上游连接中断"))
            return
        session.reconnected = True
        self.emit_error(ErrorCode.REALTIME_UPSTREAM_FAILED, "百炼同传上游连接中断，正在重建会话")
        self._spawn(self._reconnect(session))

    async def _reconnect(self, session: _QwenSession) -> None:
        try:
            await session.connect()
        except EngineError as e:
            self.fail(EngineError(e.error, f"百炼同传会话重建失败：{e.message}"))
        else:
            log.info("百炼同传会话已重建 target=%s", session.target)
