"""AI 对话的实时语音模型引擎 realtime-chat（improve-speech-playback-latency D7）。

端到端语音模型直接听用户说话、直接用语音回复，不经过平台 ASR 与 TTS。协议按 2026-10-06 与百炼
qwen3-omni-flash-realtime 真实联调抓取的事件序列实现（tests/fixtures/interpret/omni_realtime_events.jsonl），
事件名与 OpenAI Realtime 一致，两家的差异由适配器隔离：
- DASHSCOPE（百炼 Omni Realtime，已联调）：输入 PCM16 16 kHz，输出 pcm24（PCM16 24 kHz），转写模型 gummy-realtime-v1
- OPENAI_COMPATIBLE（OpenAI Realtime，实验）：输入重采样到 24 kHz，输出 pcm16 24 kHz；兼容 GA 版 output_audio 事件名

会话配置：instructions 与级联 AI 对话相同（chat_prompts）；上游断句并自动回复，新的说话会让服务端自动取消
进行中的回复（不戴耳机时前端半双工不上行，戴耳机时即为插话）。断句（improve-speech-endpointing-and-live-ux D8）：
- DASHSCOPE：server_vad，silence_duration_ms = realtime_chat_silence_ms（缺省 800，即百炼缺省值）；
  qwen3.5-omni 系列用 semantic_vad
- OPENAI_COMPATIBLE：semantic_vad，eagerness = realtime_chat_openai_eagerness（缺省 low，照顾停顿较多的语言学习者）
- 模型配置 extra.turnDetection = server | semantic 可覆盖自动选择

事件映射：
- speech_started → 分配用户句 uid；speech_stopped → 记录句末（e2e 起点）
- input_audio_transcription.completed → 用户 transcript.final + 只含 asrMs 的 metrics
- response.created → 分配 AI 回复 uid（role=assistant）；audio_transcript.delta → transcript.partial（累计），
  同时切句送母语字幕；audio.delta → audio（pcm16 24 kHz）
- response.done(completed) → transcript.final → 字幕 translation.final → audio 终止包 → metrics
- response.done(cancelled)：客户端 interrupt 已处理；服务端自动取消（插话）同样映射为 reply.interrupted
- 上游意外断开：非致命 C0174，用对话记忆摘要与尚未并入摘要的对话重建一次会话；再失败为致命错误（前端提示切换到平台级联）
- 对话记忆（improve-prompts-and-context-memory D4）：会话进行中依赖上游自身的上下文；DialogMemory 按 utteranceId
  维护对话，超出窗口时用平台默认对话模型在后台压缩并发 memory 事件，用于上游重连与发言流重建（D5）。
  没有可用的对话模型时不压缩，只保留最近 24 轮
- 母语字幕使用字幕提示词，上下文为用户上一句与本条回复前面的句子（D1.1）
"""

import asyncio
import base64
import contextlib
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, ClassVar

from websockets.asyncio.client import ClientConnection
from websockets.exceptions import ConnectionClosed

from app.core.config import get_settings
from app.core.errors import BizException, ErrorCode
from app.lang import languages
from app.llm.base import ChatMessage, ChatRequest
from app.repositories.model_config import REALTIME_CHAT, ModelConfig
from app.speech.engines import DASHSCOPE, OPENAI_COMPATIBLE, REALTIME_CHAT_ENGINE, REALTIME_CHAT_PROVIDERS
from app.speech.tts import PCM16, TTS_SAMPLE_RATE
from app.speech.vad import resample_pcm16

from .chat import ROLE_ASSISTANT
from .chat_prompts import INTERRUPTED_MARK, PROMPT_VERSION, opener_instruction, system_prompt
from .dialog_memory import compress, new_memory
from .engine import AudioSequencer, EngineError, Event, InterpretEngine, UtteranceMetrics, ms_since
from .interpret_prompts import subtitle_messages
from .output_filter import clean_final
from .s2s import UpstreamError, b64, json_message, open_ws, probe_ws, to_ws_url, upstream_engine_error, with_query
from .segmenter import SentenceSegmenter
from .subtitles import Subtitles

log = logging.getLogger("app.interpret.realtime_chat")

APPEND_MS = 100  # 上行音频按约 100 ms 一包发送
FINISH_WAIT_SECONDS = 10.0
SUBTITLE_MAX_TOKENS = 200
DASHSCOPE_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime"
OPENAI_URL = "https://api.openai.com/v1"


# ---------------- 厂商适配 ----------------


class RealtimeAdapter:
    provider: ClassVar[str]
    label: ClassVar[str]
    input_rate: ClassVar[int]
    default_voice: ClassVar[dict[str, str]]  # gender → 音色
    audio_delta: ClassVar[tuple[str, ...]] = ("response.audio.delta", "response.output_audio.delta")
    transcript_delta: ClassVar[tuple[str, ...]] = (
        "response.audio_transcript.delta",
        "response.output_audio_transcript.delta",
    )
    transcript_done: ClassVar[tuple[str, ...]] = (
        "response.audio_transcript.done",
        "response.output_audio_transcript.done",
    )

    def url(self, cfg: ModelConfig) -> str:
        raise NotImplementedError

    def headers(self, api_key: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {api_key}"}

    def voice(self, cfg: ModelConfig, gender: str) -> str:
        return cfg.extra.get("voice") or self.default_voice.get(gender) or self.default_voice["female"]

    def session(self, instructions: str, voice: str, cfg: ModelConfig) -> dict[str, Any]:
        raise NotImplementedError

    def semantic(self, cfg: ModelConfig) -> bool:
        """是否使用语义断句：模型配置 extra.turnDetection 优先，否则按厂商与模型自动选择。"""
        forced = str(cfg.extra.get("turnDetection") or "").lower()
        if forced in ("server", "semantic"):
            return forced == "semantic"
        return self.semantic_default(cfg)

    def semantic_default(self, cfg: ModelConfig) -> bool:
        return False

    def turn_detection(self, cfg: ModelConfig) -> dict[str, Any]:
        settings = get_settings()
        if self.semantic(cfg):
            return {"type": "semantic_vad", "eagerness": settings.realtime_chat_openai_eagerness}
        return {"type": "server_vad", "threshold": 0.5, "silence_duration_ms": settings.realtime_chat_silence_ms}


class DashScopeOmniAdapter(RealtimeAdapter):
    provider = DASHSCOPE
    label = "百炼实时语音对话"
    input_rate = 16000
    default_voice: ClassVar[dict[str, str]] = {"female": "Cherry", "male": "Ethan"}

    def url(self, cfg: ModelConfig) -> str:
        return with_query(to_ws_url(cfg.base_url or DASHSCOPE_URL), model=cfg.model_name)

    def semantic_default(self, cfg: ModelConfig) -> bool:
        return (cfg.model_name or "").lower().startswith("qwen3.5-omni")  # 官方仅列出 Qwen3.5-Omni-Realtime 支持

    def turn_detection(self, cfg: ModelConfig) -> dict[str, Any]:
        if self.semantic(cfg):
            return {"type": "semantic_vad"}
        return super().turn_detection(cfg)

    def session(self, instructions: str, voice: str, cfg: ModelConfig) -> dict[str, Any]:
        return {
            "modalities": ["text", "audio"],
            "voice": voice,
            "instructions": instructions,
            "input_audio_format": "pcm16",
            "output_audio_format": "pcm24",
            "input_audio_transcription": {"model": "gummy-realtime-v1"},
            "turn_detection": self.turn_detection(cfg),
        }


class OpenAIRealtimeAdapter(RealtimeAdapter):
    provider = OPENAI_COMPATIBLE
    label = "OpenAI 实时语音对话"
    input_rate = 24000
    default_voice: ClassVar[dict[str, str]] = {"female": "alloy", "male": "ash"}

    def url(self, cfg: ModelConfig) -> str:
        return with_query(to_ws_url(cfg.base_url or OPENAI_URL) + "/realtime", model=cfg.model_name)

    def headers(self, api_key: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {api_key}", "OpenAI-Beta": "realtime=v1"}

    def semantic_default(self, cfg: ModelConfig) -> bool:
        return True

    def session(self, instructions: str, voice: str, cfg: ModelConfig) -> dict[str, Any]:
        return {
            "modalities": ["text", "audio"],
            "voice": voice,
            "instructions": instructions,
            "input_audio_format": "pcm16",
            "output_audio_format": "pcm16",
            "input_audio_transcription": {"model": "whisper-1"},
            "turn_detection": self.turn_detection(cfg),
        }


ADAPTERS: dict[str, RealtimeAdapter] = {DASHSCOPE: DashScopeOmniAdapter(), OPENAI_COMPATIBLE: OpenAIRealtimeAdapter()}


def _ready(raw: str | bytes) -> bool:
    msg = json_message(raw) or {}
    if msg.get("type") == "error":
        raise UpstreamError(_error_message(msg))
    return msg.get("type") == "session.updated"


def _error_message(ev: dict[str, Any]) -> str:
    err = ev.get("error") or {}
    if isinstance(err, dict):
        return str(err.get("message") or err.get("code") or "未知错误")
    return str(err)


def _error_of(raw: str | bytes) -> str | None:
    msg = json_message(raw) or {}
    return _error_message(msg) if msg.get("type") == "error" else None


async def resolve_chat_config(registry: Any, model_config_id: int | None) -> tuple[ModelConfig, str]:
    """实时语音对话的模型配置：未指定 id 时取第一个启用的 REALTIME_CHAT 配置（默认配置优先）。"""
    unavailable = EngineError(ErrorCode.SPEECH_ENGINE_UNAVAILABLE, "未配置实时语音对话模型（REALTIME_CHAT）")
    if model_config_id is None and getattr(registry, "repo", None) is not None:
        enabled = [c for c in await registry.repo.find_enabled(REALTIME_CHAT) if c.provider in REALTIME_CHAT_PROVIDERS]
        if not enabled:
            raise unavailable
        model_config_id = enabled[0].id
    try:
        cfg, api_key = await registry.config_with_key(REALTIME_CHAT, model_config_id)
    except BizException:
        raise unavailable from None
    if cfg.provider not in ADAPTERS:
        raise EngineError(ErrorCode.SPEECH_ENGINE_UNAVAILABLE, f"实时语音对话不支持该提供方：{cfg.provider}")
    return cfg, api_key


async def probe(cfg: ModelConfig, api_key: str) -> str:
    """连通性测试：建立会话、完成配置后关闭。"""
    adapter = ADAPTERS.get(cfg.provider)
    if adapter is None:
        raise EngineError(ErrorCode.SPEECH_ENGINE_UNAVAILABLE, f"实时语音对话不支持该提供方：{cfg.provider}")
    setup = json.dumps(
        {"type": "session.update", "session": adapter.session("你好", adapter.voice(cfg, "female"), cfg)},
        ensure_ascii=False,
    )
    return await probe_ws(
        adapter.label,
        adapter.url(cfg),
        adapter.headers(api_key),
        setup,
        _ready,
        _error_of,
        get_settings().interpret_upstream_retries,
    )


# ---------------- 引擎 ----------------


@dataclass
class _UserTurn:
    uid: int
    t_end: float | None = None


@dataclass
class _Reply:
    uid: int
    response_id: str | None
    metrics: UtteranceMetrics
    created_at: float
    text: str = ""
    audio_started: bool = False
    done: bool = False
    subtitles: Subtitles | None = None
    segmenter: SentenceSegmenter | None = None
    tasks: list[asyncio.Task] = field(default_factory=list)


class RealtimeChatEngine(InterpretEngine):
    id = REALTIME_CHAT_ENGINE
    max_targets = 1

    def __init__(self, cfg, emit, deps):
        super().__init__(cfg, emit, deps)
        self._chat = cfg.chat
        self._adapter: RealtimeAdapter | None = None
        self._model: ModelConfig | None = None
        self._key = ""
        self._voice = ""
        self._llm = None  # 母语字幕与对话记忆压缩用的对话模型（可选）
        self._ws: ClientConnection | None = None
        self._reader: asyncio.Task | None = None
        self._buf = bytearray()
        self._closing = False
        self._reconnected = False
        self._users: dict[str, _UserTurn] = {}
        self._last_stop: float | None = None
        self._reply: _Reply | None = None
        self._last_ai_uid: int | None = None
        self._ai_uids: set[int] = set()
        # 按 utteranceId 有序（用户转写可能晚于回复完成到达）；发言流重建时从 config 恢复
        self._memory = new_memory(deps.settings)
        self._memory.seed(
            [ChatMessage(role=h.role, content=h.text) for h in cfg.history], cfg.chat.memory if cfg.chat else None
        )
        # 用户句原文（按 uid）：字幕翻译时取该回复之前最近的一句作为上下文；恢复的最后一句用户话记为 uid 0
        restored = next((h.text for h in reversed(cfg.history) if h.role == "user"), None)
        self._user_texts: dict[int, str] = {0: restored} if restored else {}
        self._tasks: set[asyncio.Task] = set()
        inner = self._emit_fn

        def emit_tagged(ev: Event) -> None:
            if ev.get("utteranceId") in self._ai_uids:
                ev = {**ev, "role": ROLE_ASSISTANT}
            inner(ev)

        self._emit_fn = emit_tagged
        self.sequencer = AudioSequencer(emit_tagged)

    # ---------------- 生命周期 ----------------

    async def start(self) -> None:
        self._model, self._key = await resolve_chat_config(self.deps.registry, None)
        self._adapter = ADAPTERS[self._model.provider]
        self._voice = (self.cfg.voices or {}).get(self._chat.ai_lang) or self._adapter.voice(
            self._model, self.cfg.gender
        )
        try:
            self._llm = await self.deps.registry.get(self.cfg.model_config_id)
        except BizException:
            log.info("没有可用的对话模型，实时语音对话不提供母语字幕与对话记忆压缩 stream=%s", self.cfg.stream_id)
        # 发言流重建时（greet=false）首次建立上游会话就带上恢复的对话与摘要
        await self._connect(self._instructions(self._dialog))
        self.emit_ready()
        if self._chat.greet:
            await self._greet()
        log.info(
            "实时语音对话开始 stream=%s provider=%s model=%s voice=%s prompt=%s restored=%s",
            self.cfg.stream_id,
            self._model.provider,
            self._model.model_name,
            self._voice,
            PROMPT_VERSION,
            len(self._dialog),
        )

    @property
    def _dialog(self) -> list[ChatMessage]:
        return self._memory.history()

    def _remember(self, uid: int, role: str, content: str) -> None:
        self._memory.append(ChatMessage(role=role, content=content), order=uid)
        if role == "assistant":
            self._maybe_compress()

    def _maybe_compress(self) -> None:
        if self._llm is None:
            return
        batch = self._memory.due()
        if batch is not None:
            self._spawn(self._compress(batch))

    async def _compress(self, batch: list[ChatMessage]) -> None:
        chat = self._chat
        summary = await compress(
            self._llm.client,
            self._memory,
            batch,
            scenario=chat.scenario,
            persona=chat.persona,
            settings=self.deps.settings,
            stream_id=self.cfg.stream_id,
        )
        if summary is not None:
            self.emit("memory", summary=summary, turns=self._memory.memorized_turns)

    def _user_before(self, uid: int) -> str | None:
        earlier = [k for k in self._user_texts if k < uid]
        return self._user_texts[max(earlier)] if earlier else None

    def _instructions(self, history: list[ChatMessage] | None = None) -> str:
        chat = self._chat
        text = system_prompt(chat.scenario, chat.my_lang, chat.ai_lang, chat.persona, self._memory.summary)
        if history:
            lines = "\n".join(f"{'用户' if m.role == 'user' else chat.persona}：{m.content}" for m in history)
            text += f"\n\n## 此前的对话（连接中断后恢复，请自然地接着聊）\n{lines}"
        return text

    async def _connect(self, instructions: str) -> None:
        adapter, cfg = self._adapter, self._model
        setup = json.dumps(
            {"type": "session.update", "session": adapter.session(instructions, self._voice, cfg)}, ensure_ascii=False
        )
        try:
            self._ws = await open_ws(
                adapter.url(cfg),
                adapter.headers(self._key),
                setup,
                _ready,
                self.deps.settings.interpret_upstream_retries,
                adapter.label,
            )
        except UpstreamError as e:
            raise upstream_engine_error(adapter.label, e) from None
        self._reader = asyncio.create_task(self._read(self._ws))

    async def _greet(self) -> None:
        self._last_stop = time.perf_counter()  # 开场白的 e2e 起点为请求时刻
        await self._send(
            {"type": "response.create", "response": {"instructions": opener_instruction(self._chat.scenario)}}
        )

    async def feed(self, pcm: bytes) -> None:
        if not pcm or self._ws is None:
            return
        if self._adapter.input_rate != 16000:
            pcm = resample_pcm16(pcm, 16000, self._adapter.input_rate)
        self._buf += pcm
        if len(self._buf) >= self._adapter.input_rate * 2 * APPEND_MS // 1000:
            await self._flush_audio()

    async def _flush_audio(self) -> None:
        if not self._buf:
            return
        data, self._buf = bytes(self._buf), bytearray()
        await self._send({"type": "input_audio_buffer.append", "audio": b64(data)})

    async def control(self, msg: dict[str, Any]) -> None:
        if msg.get("type") == "interrupt":
            await self.interrupt()
        elif msg.get("type") == "flush":
            await self._flush_audio()

    async def finish(self) -> None:
        await self._flush_audio()
        reply = self._reply
        if reply is not None:
            with contextlib.suppress(TimeoutError):
                async with asyncio.timeout(FINISH_WAIT_SECONDS):
                    while self._reply is reply and not reply.done:
                        await asyncio.sleep(0.05)
        pending = [t for t in self._tasks if not t.done()]
        if pending:
            await asyncio.wait(pending, timeout=FINISH_WAIT_SECONDS)

    async def close(self) -> None:
        self._closing = True
        tasks = [t for t in (self._reader, *self._tasks) if t is not None and not t.done()]
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        if self._ws is not None:
            with contextlib.suppress(Exception):
                await self._ws.close()

    async def _send(self, ev: dict[str, Any]) -> None:
        ws = self._ws
        if ws is None:
            return
        try:
            await ws.send(json.dumps(ev, ensure_ascii=False))
        except ConnectionClosed:
            pass  # 由读协程处理断线

    def _spawn(self, coro) -> asyncio.Task:
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    # ---------------- 上游事件 ----------------

    async def _read(self, ws: ClientConnection) -> None:
        try:
            async for raw in ws:
                ev = json_message(raw)
                if ev is not None:
                    self._handle(ev)
        except ConnectionClosed:
            pass
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("实时语音对话事件处理异常 stream=%s", self.cfg.stream_id)
        if not self._closing and ws is self._ws:
            self._spawn(self._session_lost())

    def _handle(self, ev: dict[str, Any]) -> None:
        kind = ev.get("type")
        adapter = self._adapter
        if kind == "input_audio_buffer.speech_started":
            self._users[ev.get("item_id") or ""] = _UserTurn(self.next_uid())
        elif kind == "input_audio_buffer.speech_stopped":
            self._last_stop = time.perf_counter()
            turn = self._users.get(ev.get("item_id") or "")
            if turn is not None:
                turn.t_end = self._last_stop
        elif kind == "conversation.item.input_audio_transcription.completed":
            self._user_final(ev)
        elif kind == "response.created":
            self._start_reply((ev.get("response") or {}).get("id"))
        elif kind in adapter.transcript_delta:
            self._reply_text(ev)
        elif kind in adapter.transcript_done:
            reply = self._current(ev)
            if reply is not None and ev.get("transcript"):
                reply.text = ev["transcript"]
        elif kind in adapter.audio_delta:
            self._reply_audio(ev)
        elif kind == "response.done":
            self._reply_done(ev.get("response") or {})
        elif kind == "error":
            self.emit_error(ErrorCode.REALTIME_UPSTREAM_FAILED, f"实时语音模型错误：{_error_message(ev)}")

    def _user_final(self, ev: dict[str, Any]) -> None:
        text = (ev.get("transcript") or "").strip()
        turn = self._users.pop(ev.get("item_id") or "", None)
        if not text:
            return
        uid = turn.uid if turn is not None else self.next_uid()
        lang = ev.get("language")
        if not languages.is_supported(lang):
            lang = self._chat.my_lang
        self.emit("transcript.final", utteranceId=uid, text=text, lang=lang)
        asr_ms = ms_since(turn.t_end) if turn is not None and turn.t_end is not None else None
        self._emit_fn(UtteranceMetrics(t0=time.perf_counter(), asr_ms=asr_ms).to_event(uid, None))
        self._user_texts[uid] = text
        self._remember(uid, "user", text)

    def _current(self, ev: dict[str, Any]) -> _Reply | None:
        reply = self._reply
        if reply is None:
            return None
        rid = ev.get("response_id")
        return reply if rid is None or reply.response_id is None or rid == reply.response_id else None

    def _start_reply(self, response_id: str | None) -> None:
        if self._reply is not None and not self._reply.done:
            self._abandon(self._reply)  # 上一条未完成的回复被新回复取代
        uid = self.next_uid()
        self._ai_uids.add(uid)
        self._last_ai_uid = uid
        now = time.perf_counter()
        reply = _Reply(uid, response_id, UtteranceMetrics(t0=self._last_stop or now), now)
        my, ai = self._chat.my_lang, self._chat.ai_lang
        if my != ai and self._llm is not None:

            async def translate(text: str, src: str, tgt: str, prev: list[str]) -> str:
                # 用户转写可能晚于回复到达：翻译时再取该回复之前最近的一句用户话
                return await self._translate(self._user_before(uid), prev, text, src, tgt)

            reply.subtitles = Subtitles(self.emit, self.emit_error, translate, uid, ai, my)
            reply.segmenter = SentenceSegmenter(
                self.deps.settings.interpret_seg_first_min, self.deps.settings.interpret_seg_min_chars
            )
        self.sequencer.open(
            uid,
            [ai],
            PCM16,
            TTS_SAMPLE_RATE,
            on_done=lambda first_audio: self._emit_fn(reply.metrics.to_event(uid, first_audio)),
        )
        self._reply = reply

    def _reply_text(self, ev: dict[str, Any]) -> None:
        reply = self._current(ev)
        delta = ev.get("delta") or ""
        if reply is None or not delta:
            return
        if not reply.text:
            reply.metrics.mt_first.append(ms_since(reply.metrics.t0))
        reply.text += delta
        self.emit("transcript.partial", utteranceId=reply.uid, text=reply.text.strip())
        if reply.segmenter is not None:
            for piece in reply.segmenter.feed(delta):
                reply.subtitles.add(piece)

    def _reply_audio(self, ev: dict[str, Any]) -> None:
        reply = self._current(ev)
        if reply is None or not ev.get("delta"):
            return
        data = base64.b64decode(ev["delta"])
        if not reply.audio_started:
            reply.audio_started = True
            reply.metrics.tts_first.append(ms_since(reply.created_at))
        self.sequencer.push(reply.uid, self._chat.ai_lang, data)

    def _reply_done(self, response: dict[str, Any]) -> None:
        reply = self._reply
        if reply is None or (response.get("id") and reply.response_id and response["id"] != reply.response_id):
            return  # 已被客户端打断处理过
        status = response.get("status")
        if status == "cancelled":
            self._interrupted(reply)  # 服务端在用户插话时自动取消
            return
        if status not in (None, "completed"):
            self.emit_error(ErrorCode.REALTIME_UPSTREAM_FAILED, f"实时语音模型回复失败（{status}）")
        reply.done = True
        self._reply = None
        text = reply.text.strip()
        if text:
            reply.metrics.mt_total.append(ms_since(reply.metrics.t0))
            reply.metrics.final_emitted()
            self.emit("transcript.final", utteranceId=reply.uid, text=text, lang=self._chat.ai_lang, ttsFallback=False)
            self._remember(reply.uid, "assistant", text)
        self._spawn(self._complete(reply))

    async def _complete(self, reply: _Reply) -> None:
        try:
            if reply.subtitles is not None:
                if (rest := reply.segmenter.flush()) is not None:
                    reply.subtitles.add(rest)
                await reply.subtitles.finish()
        finally:
            self.sequencer.end(reply.uid, self._chat.ai_lang)

    # ---------------- 打断 ----------------

    async def interrupt(self) -> None:
        """客户端打断：取消上游回复；没有进行中的回复时针对最近一条回执。"""
        reply = self._reply
        if reply is None:
            if self._last_ai_uid is not None:
                self.emit("reply.interrupted", utteranceId=self._last_ai_uid, text="")
            return
        self._interrupted(reply)
        await self._send({"type": "response.cancel"})

    def _interrupted(self, reply: _Reply) -> None:
        self._reply = None
        reply.done = True
        text = reply.text.strip()
        self.sequencer.abort(reply.uid, self._chat.ai_lang)
        if reply.subtitles is not None:
            self._spawn(reply.subtitles.cancel())
        if text:
            reply.metrics.final_emitted()
            self.emit("transcript.final", utteranceId=reply.uid, text=text, lang=self._chat.ai_lang, ttsFallback=False)
            self._remember(reply.uid, "assistant", text + INTERRUPTED_MARK)
        self.emit("reply.interrupted", utteranceId=reply.uid, text=text)
        log.info("实时语音回复被打断 stream=%s uid=%s chars=%s", self.cfg.stream_id, reply.uid, len(text))

    def _abandon(self, reply: _Reply) -> None:
        self._interrupted(reply)

    # ---------------- 字幕与断线 ----------------

    async def _translate(self, user_text: str | None, prev: list[str], text: str, source: str, target: str) -> str:
        req = ChatRequest(
            messages=subtitle_messages(user_text, prev, text, source, target, self._chat.persona),
            temperature=self.deps.settings.interpret_mt_temperature,
            max_tokens=SUBTITLE_MAX_TOKENS,
        )
        res = await self._llm.client.chat(req)
        return clean_final(res.content or "", text)

    async def _session_lost(self) -> None:
        if self._reply is not None:
            self._interrupted(self._reply)
        if self._reconnected:
            self.fail(EngineError(ErrorCode.REALTIME_UPSTREAM_FAILED, "实时语音模型连接中断，请切换到平台级联重新开始"))
            return
        self._reconnected = True
        self.emit_error(ErrorCode.REALTIME_UPSTREAM_FAILED, "实时语音模型连接中断，正在重连")
        log.info("实时语音对话上游断开，重建会话 stream=%s", self.cfg.stream_id)
        try:
            await self._connect(self._instructions(self._dialog))
        except EngineError as e:
            self.fail(EngineError(ErrorCode.REALTIME_UPSTREAM_FAILED, f"{e.message}，请切换到平台级联重新开始"))
