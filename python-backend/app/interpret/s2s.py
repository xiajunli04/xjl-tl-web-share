"""可选语音到语音（S2S）同传引擎的公共骨架（design D3 / D6，tasks 12.1–12.3）。

沿用百炼引擎（qwen_livetranslate.py）的结构，供 OpenAI / Gemini / 豆包三个可选引擎复用：
- S2SEngine：每个目标语言一个上游会话；会议室各会话收到同一路音频，按第 k 句对齐到同一 utteranceId，原文只取首个会话；
  双向对话只支持按键（按下哪一侧就把音频送往对侧语言的会话）；单人会议室借占位目标建会话、只转发原文与指标；
  会话中途断开发非致命 C0174 并重建一次，再断则致命
- S2SSession：一个目标语言的上游会话：建连重试（指数退避，上游拒绝不重试）、上行缓冲、读循环、逐句事件与计时
- SegmentedSession：厂商没有显式句子边界（OpenAI / Gemini）时，按输入转写静默 1.2 s 或句末标点切出一句；
  译文与译音归属到最早一句尚未结束的句子，译文在原文已定稿且出现句末标点（或输出静默 1.2 s）时定稿
"""

import asyncio
import base64
import contextlib
import json
import logging
import time
from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, ClassVar

from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, InvalidStatus, WebSocketException

from app.core.errors import BizException, ErrorCode
from app.repositories.model_config import REALTIME_TRANSLATE, ModelConfig
from app.speech.engines import S2S_MAX_TARGETS
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

log = logging.getLogger("app.interpret.s2s")

APPEND_BYTES = 3200  # 100 ms PCM16 16 kHz
SILENCE_FLUSH = b"\x00" * (16000 * 2 * 9 // 10)  # 0.9 s 静音：促使上游断句（flush / 按键松开 / 静音）
OPEN_TIMEOUT_SECONDS = 10.0
SESSION_READY_TIMEOUT_SECONDS = 10.0
FINISH_TIMEOUT_SECONDS = 15.0
PROBE_ERROR_WAIT_SECONDS = 0.5
BACKOFF_BASE_SECONDS = 0.5
MAX_PHRASES = 200

INPUT_SILENCE_SECONDS = 1.2  # 输入转写静默多久切句
OUTPUT_SILENCE_SECONDS = 1.2  # 原文定稿后译文 / 译音静默多久结束该句
OUTPUT_WAIT_SECONDS = 6.0  # 原文定稿后一直没有译文输出时最多等待多久（同语种输入等不出译文的情况）
FINISH_IDLE_SECONDS = 1.2  # 没有会话结束事件的厂商：结束时句子都已收尾且上游静默多久视为输出完毕
FINISH_QUIET_SECONDS = 3.0  # 同上，仍有未收尾句子时上游静默多久强制结束
TICK_SECONDS = 0.1

SENTENCE_END = tuple("。！？!?.…；;")
CLOSING_MARKS = "\"'”’」』)）]】》 \t\r\n"

Ready = Callable[[str | bytes], bool]


class UpstreamError(Exception):
    """上游拒绝会话（HTTP 4xx 握手失败、配置阶段返回错误或关闭帧），不重试。"""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.message = message
        self.status = status


def upstream_engine_error(label: str, e: UpstreamError) -> EngineError:
    """握手 401/403 → C0121，429 → C0123，其余 → C0174。"""
    if e.status in (401, 403):
        return EngineError(ErrorCode.LLM_AUTH_FAILED, f"{label}鉴权失败（HTTP {e.status}），请检查密钥")
    if e.status == 429:
        return EngineError(ErrorCode.LLM_RATE_LIMITED, f"{label}限流（HTTP 429）")
    return EngineError(ErrorCode.REALTIME_UPSTREAM_FAILED, f"{label}会话配置失败：{e.message}")


def to_ws_url(base: str) -> str:
    base = base.rstrip("/")
    if base.startswith("https://"):
        return "wss://" + base[len("https://") :]
    if base.startswith("http://"):
        return "ws://" + base[len("http://") :]
    return base


def with_query(url: str, **params: str) -> str:
    query = "&".join(f"{k}={v}" for k, v in params.items())
    return f"{url}{'&' if '?' in url else '?'}{query}"


def ends_sentence(text: str) -> bool:
    """去掉末尾引号括号后是否以句末标点结束。"""
    return text.rstrip(CLOSING_MARKS).endswith(SENTENCE_END)


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def json_message(raw: str | bytes) -> dict[str, Any] | None:
    try:
        msg = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return msg if isinstance(msg, dict) else None


async def open_ws(
    url: str,
    headers: dict[str, str],
    setup: str | bytes | None,
    ready: Ready,
    retries: int,
    label: str,
) -> ClientConnection:
    """建连并完成会话配置（ready(raw) 返回 True 为就绪，抛 UpstreamError 为上游拒绝）。

    网络错误、握手 5xx、无关闭帧的断开按指数退避重试；握手 4xx、配置阶段的错误事件或关闭帧不重试。
    """
    last: Exception | None = None
    for attempt in range(retries + 1):
        ws: ClientConnection | None = None
        try:
            ws = await connect(url, additional_headers=headers, open_timeout=OPEN_TIMEOUT_SECONDS, max_size=None)
            if setup is not None:
                await ws.send(setup)
            async with asyncio.timeout(SESSION_READY_TIMEOUT_SECONDS):
                while True:
                    if ready(await ws.recv()):
                        return ws
        except UpstreamError:
            if ws is not None:
                with contextlib.suppress(Exception):
                    await ws.close()
            raise
        except InvalidStatus as e:
            status = e.response.status_code
            if status < 500:
                raise UpstreamError(f"握手被拒绝（HTTP {status}）", status) from None
            last = e
        except ConnectionClosed as e:
            if e.rcvd is not None and e.rcvd.code != 1011:  # 上游带关闭帧拒绝（如配置非法 1007 / 1008）
                reason = f" {e.rcvd.reason}" if e.rcvd.reason else ""
                raise UpstreamError(f"连接被关闭（{e.rcvd.code}{reason}）") from None
            last = e
        except (OSError, WebSocketException, TimeoutError) as e:
            if ws is not None:
                with contextlib.suppress(Exception):
                    await ws.close()
            last = e
        log.info("%s建连失败（第 %s 次）: %s", label, attempt + 1, type(last).__name__)
        if attempt < retries:
            await asyncio.sleep(BACKOFF_BASE_SECONDS * 2**attempt)
    raise EngineError(ErrorCode.REALTIME_UPSTREAM_FAILED, f"{label}连接失败（{type(last).__name__}）")


async def probe_ws(
    label: str,
    url: str,
    headers: dict[str, str],
    setup: str | bytes | None,
    ready: Ready,
    error_of: Callable[[str | bytes], str | None],
    retries: int,
) -> str:
    """连通性测试：建立会话、完成配置后关闭（配置完成后短时间内没有错误事件即成功）。"""
    try:
        ws = await open_ws(url, headers, setup, ready, retries, label)
    except UpstreamError as e:
        raise upstream_engine_error(label, e) from None
    try:
        with contextlib.suppress(TimeoutError, ConnectionClosed):
            async with asyncio.timeout(PROBE_ERROR_WAIT_SECONDS):
                while True:
                    message = error_of(await ws.recv())
                    if message:
                        raise EngineError(ErrorCode.REALTIME_UPSTREAM_FAILED, f"{label}会话错误：{message}")
    finally:
        with contextlib.suppress(Exception):
            await ws.close()
    return "会话已建立"


async def resolve_config(registry: Any, provider: str, model_config_id: int | None, label: str):
    """S2S 引擎的模型配置：未指定 id 时取该 provider 第一个启用的 REALTIME_TRANSLATE 配置（默认配置优先）。"""
    unavailable = EngineError(ErrorCode.SPEECH_ENGINE_UNAVAILABLE, f"未配置启用的{label}模型")
    if model_config_id is None and getattr(registry, "repo", None) is not None:
        enabled = [c for c in await registry.repo.find_enabled(REALTIME_TRANSLATE) if c.provider == provider]
        if not enabled:
            raise unavailable
        model_config_id = enabled[0].id
    try:
        cfg, api_key = await registry.config_with_key(REALTIME_TRANSLATE, model_config_id)
    except BizException:
        raise unavailable from None
    if cfg.provider != provider:
        raise EngineError(ErrorCode.SPEECH_ENGINE_UNAVAILABLE, f"所选实时同传配置不是{label}（{provider}）")
    return cfg, api_key


@dataclass
class Utt:
    uid: int
    started_ms: int | None = None
    ended_ms: int | None = None
    source: str = ""
    source_closed: bool = False
    lang: str | None = None  # 厂商报告的原文语种
    translation: str = ""
    translation_closed: bool = False
    t_end: float | None = None  # 说话结束（e2e 起点）
    asr_done_at: float | None = None
    final_at: float | None = None
    first_audio_after_end: float | None = None
    audio_ended: bool = False
    last_in_at: float | None = None
    last_out_at: float | None = None
    last_out_elapsed: int | None = None
    tx_end_elapsed: int | None = None
    has_output: bool = False


class S2SSession(ABC):
    """一个目标语言的上游会话。子类实现建连、上行音频消息、结束消息与事件映射。"""

    output_format: ClassVar[str] = PCM16
    output_rate: ClassVar[int] = TTS_SAMPLE_RATE

    def __init__(
        self,
        engine: "S2SEngine",
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
        self._ticker: asyncio.Task | None = None
        self._buf = bytearray()
        self._closing = False
        self._finished = asyncio.Event()
        self._last_msg_at = time.perf_counter()
        self._utts: dict[int, Utt] = {}
        self._sequencer = AudioSequencer(engine._emit_fn)

    @property
    def index(self) -> int:
        return self._index

    @property
    def source(self) -> str | None:
        """本会话的源语种（双向对话为另一侧语言；收听 / 会议室为声明的源语种，未声明为 None）。"""
        return self.engine.session_source(self.target)

    # ---------------- 子类实现 ----------------

    @abstractmethod
    async def open(self) -> ClientConnection:
        """建连并完成会话配置；上游拒绝时抛 UpstreamError。"""

    @abstractmethod
    def audio_message(self, pcm: bytes) -> str | bytes:
        """把一段 PCM16 16 kHz 音频编码为上行消息。"""

    @abstractmethod
    def finish_message(self) -> str | bytes | None:
        """结束会话的上行消息。"""

    @abstractmethod
    async def handle(self, raw: str | bytes) -> None:
        """处理一条下行消息。"""

    async def tick(self) -> None:  # noqa: B027 - 默认无定时任务
        """定时检查（切句等），默认无。"""

    # ---------------- 连接 ----------------

    async def connect(self) -> None:
        await self.flush_open()  # 重建会话时，上一条连接上未结束的句子直接收尾
        try:
            self._ws = await self.open()
        except UpstreamError as e:
            raise upstream_engine_error(self.engine.label, e) from None
        self._closing = False
        self._finished.clear()
        self._reader = asyncio.create_task(self._read(self._ws))
        if self._ticker is None or self._ticker.done():
            self._ticker = asyncio.create_task(self._tick_loop())

    async def send(self, msg: str | bytes) -> None:
        if self._ws is None:
            return
        with contextlib.suppress(ConnectionClosed):
            await self._ws.send(msg)

    async def send_audio(self, pcm: bytes) -> None:
        self._buf += pcm
        if len(self._buf) >= APPEND_BYTES:
            await self.flush_buffer()

    async def flush_buffer(self) -> None:
        if not self._buf or self._ws is None:
            return
        data = bytes(self._buf)
        self._buf.clear()
        await self.send(self.audio_message(data))

    async def push_silence(self) -> None:
        """送入一段静音，促使上游断句（flush / 按键松开 / 静音）。"""
        await self.send_audio(SILENCE_FLUSH)
        await self.flush_buffer()

    async def finish(self) -> None:
        await self.flush_buffer()
        self._closing = True
        self._last_msg_at = time.perf_counter()
        if self._ws is not None:
            msg = self.finish_message()
            if msg is not None:
                await self.send(msg)
            with contextlib.suppress(TimeoutError):
                async with asyncio.timeout(FINISH_TIMEOUT_SECONDS):
                    await self._finished.wait()
        await self.flush_open()
        await self.close()

    async def close(self) -> None:
        self._closing = True
        if self._ws is not None:
            with contextlib.suppress(Exception):
                await self._ws.close()
        current = asyncio.current_task()
        for task in (self._reader, self._ticker):
            if task is not None and not task.done() and task is not current:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task

    async def _read(self, ws: ClientConnection) -> None:
        try:
            async for raw in ws:
                self._last_msg_at = time.perf_counter()
                await self.handle(raw)
        except ConnectionClosed:
            pass
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("%s事件处理异常 target=%s", self.engine.label, self.target)
        if ws is not self._ws:
            return
        if self._closing:
            self._finished.set()
        else:
            self.engine.session_lost(self)

    async def _tick_loop(self) -> None:
        while True:
            await asyncio.sleep(TICK_SECONDS)
            try:
                await self.tick()
            except Exception:
                log.exception("%s定时检查异常 target=%s", self.engine.label, self.target)

    # ---------------- 逐句事件 ----------------

    def new_utt(self) -> Utt:
        self._index += 1
        utt = Utt(uid=self.engine.allocate_uid(self, self._index))
        self._utts[utt.uid] = utt
        if not self.transcribe_only:
            self._sequencer.open(utt.uid, [self.target], self.output_format, self.output_rate)
        return utt

    def source_partial(self, utt: Utt) -> None:
        text = utt.source.strip()
        if self.primary and text:
            self.engine.emit("transcript.partial", utteranceId=utt.uid, text=text)

    async def source_final(self, utt: Utt, text: str | None = None, at: float | None = None) -> None:
        """原文定稿：at 为说话结束时刻（缺省为现在）。"""
        if utt.source_closed:
            return
        utt.source_closed = True
        if text is not None:
            utt.source = text
        utt.t_end = at or time.perf_counter()
        text = utt.source.strip()
        if self.primary and text:
            self.engine.emit(
                "transcript.final",
                utteranceId=utt.uid,
                text=text,
                lang=await self.engine.source_lang(text, self.target, utt.lang),
                startedMs=utt.started_ms,
                endedMs=utt.ended_ms,
            )
        if self.transcribe_only:
            self.complete(utt)

    def translation_delta(self, utt: Utt, delta: str, elapsed: int | None = None) -> None:
        if self.transcribe_only or not delta:
            return
        utt.translation += delta
        utt.has_output = True
        utt.last_out_at = time.perf_counter()
        if elapsed is not None:
            utt.last_out_elapsed = elapsed
        self.engine.emit("translation.delta", utteranceId=utt.uid, lang=self.target, delta=delta)

    def translation_final(self, utt: Utt, text: str | None = None) -> None:
        if utt.translation_closed:
            return
        utt.translation_closed = True
        utt.tx_end_elapsed = utt.last_out_elapsed
        if text is not None:
            utt.translation = text
        if self.transcribe_only or not utt.translation.strip():
            return  # 没有译文（如同语种输入）：不发 translation.final
        utt.final_at = time.perf_counter()
        self.engine.emit(
            "translation.final", utteranceId=utt.uid, lang=self.target, text=utt.translation.strip(), ttsFallback=False
        )

    def audio(self, utt: Utt, data: bytes) -> None:
        if self.transcribe_only or utt.audio_ended or not data:
            return
        now = time.perf_counter()
        utt.has_output = True
        utt.last_out_at = now
        if utt.t_end is not None and utt.first_audio_after_end is None:
            utt.first_audio_after_end = now
        self._sequencer.push(utt.uid, self.target, data)

    def audio_end(self, utt: Utt) -> None:
        if utt.audio_ended:
            return
        utt.audio_ended = True
        if not self.transcribe_only:
            self._sequencer.end(utt.uid, self.target)

    def complete(self, utt: Utt) -> None:
        """一句话结束：结束该句音频，主会话发出 metrics。"""
        if self._utts.pop(utt.uid, None) is None:
            return
        self.audio_end(utt)
        if not self.primary:
            return
        asr = ms_since(utt.t_end, utt.asr_done_at) if utt.t_end and utt.asr_done_at else None
        if self.transcribe_only:
            self.engine.emit(
                "metrics", utteranceId=utt.uid, asrMs=asr, mtFirstMs=None, mtMs=None, ttsFirstMs=None, e2eMs=asr
            )
            return
        end = utt.first_audio_after_end or utt.final_at
        self.engine.emit(
            "metrics",
            utteranceId=utt.uid,
            asrMs=asr,
            mtFirstMs=None,
            mtMs=ms_since(utt.t_end, utt.final_at) if utt.t_end and utt.final_at else None,
            ttsFirstMs=None,
            e2eMs=ms_since(utt.t_end, end) if utt.t_end and end else None,
        )

    async def flush_open(self) -> None:
        """会话结束或重建：所有未结束的句子按现有内容定稿并收尾。"""
        for utt in sorted(self._utts.values(), key=lambda u: u.uid):
            await self.source_final(utt)
            self.translation_final(utt)
            self.complete(utt)


class SegmentedSession(S2SSession):
    """没有显式句子边界的上游：按输入转写静默或句末标点切句，译文 / 译音按顺序归属。

    - 原文：输入转写增量追加到当前句；出现句末标点或静默 INPUT_SILENCE_SECONDS 时定稿
      （e2e 起点取最后一个原文增量的时刻）
    - 译文：归属到最早一句译文未定稿的句子；该句原文已定稿且译文出现句末标点时定稿
    - 译音：归属到最早一句译音未结束的句子；该句译文已定稿后，带 elapsed_ms 的音频按译文定稿帧切分，
      没有 elapsed_ms 时以下一句开始出现译文为界
    - 原文已定稿且输出静默 OUTPUT_SILENCE_SECONDS（一直没有输出则 OUTPUT_WAIT_SECONDS）时该句结束
    """

    finish_on_quiet: ClassVar[bool] = False  # 没有会话结束事件：结束时以上游静默判定输出完毕

    def __init__(self, *args: Any, **kwargs: Any):
        super().__init__(*args, **kwargs)
        self._src: Utt | None = None

    def _start_utt(self) -> Utt:
        utt = self.new_utt()
        self._src = utt
        return utt

    async def flush_open(self) -> None:
        await super().flush_open()
        self._src = None

    def _ordered(self) -> list[Utt]:
        return sorted(self._utts.values(), key=lambda u: u.uid)

    async def input_text(self, delta: str, elapsed: int | None = None, lang: str | None = None) -> None:
        if not delta:
            return
        utt = self._src or self._start_utt()
        if utt.started_ms is None:
            utt.started_ms = elapsed
        if elapsed is not None:
            utt.ended_ms = elapsed
        if lang:
            utt.lang = lang
        utt.source += delta
        utt.last_in_at = time.perf_counter()
        self.source_partial(utt)
        if ends_sentence(utt.source):
            await self.close_source(utt)

    async def close_source(self, utt: Utt) -> None:
        if self._src is utt:
            self._src = None
        await self.source_final(utt, at=utt.last_in_at)

    def _tx_utt(self) -> Utt:
        for utt in self._ordered():
            if not utt.translation_closed:
                return utt
        return self._start_utt()  # 先于原文到达的译文：新开一句，随后的原文并入该句

    def output_text(self, delta: str, elapsed: int | None = None) -> None:
        if self.transcribe_only or not delta:
            return
        utt = self._tx_utt()
        self.translation_delta(utt, delta, elapsed)
        if utt.source_closed and ends_sentence(utt.translation):
            self.translation_final(utt)

    def output_audio(self, data: bytes, elapsed: int | None = None) -> None:
        if self.transcribe_only or not data:
            return
        ordered = self._ordered()
        target: Utt | None = None
        for i, utt in enumerate(ordered):
            if utt.audio_ended:
                continue
            if utt.translation_closed and self._audio_past(utt, ordered[i + 1 :], elapsed):
                self.audio_end(utt)
                self._maybe_complete(utt)
                continue
            target = utt
            break
        self.audio(target or self._tx_utt(), data)

    @staticmethod
    def _audio_past(utt: Utt, later: list[Utt], elapsed: int | None) -> bool:
        if elapsed is not None and utt.tx_end_elapsed is not None:
            return elapsed > utt.tx_end_elapsed
        return any(u.translation for u in later)

    def _maybe_complete(self, utt: Utt) -> None:
        if utt.source_closed and utt.translation_closed and utt.audio_ended:
            self.complete(utt)

    async def turn_complete(self) -> None:
        """上游明确的轮次结束：当前句原文定稿，所有未结束的句子收尾。"""
        if self._src is not None:
            await self.close_source(self._src)
        for utt in self._ordered():
            self.translation_final(utt)
            self.complete(utt)

    async def tick(self) -> None:
        now = time.perf_counter()
        src = self._src
        if src is not None and src.last_in_at is not None and now - src.last_in_at >= INPUT_SILENCE_SECONDS:
            await self.close_source(src)
        for utt in self._ordered():
            if not utt.source_closed or utt.t_end is None:
                break
            if utt.has_output:
                if utt.last_out_at is None or now - utt.last_out_at < OUTPUT_SILENCE_SECONDS:
                    break
            elif now - utt.t_end < OUTPUT_WAIT_SECONDS:
                break
            self.translation_final(utt)
            self.complete(utt)
        if self._closing and self.finish_on_quiet:
            quiet = now - self._last_msg_at
            if quiet >= FINISH_QUIET_SECONDS or (not self._utts and quiet >= FINISH_IDLE_SECONDS):
                self._finished.set()


class S2SEngine(InterpretEngine):
    """可选 S2S 引擎基类：子类给出 id、provider、label、语种集合与会话类。"""

    max_targets = S2S_MAX_TARGETS
    provider: ClassVar[str]
    label: ClassVar[str]  # 中文名，如"OpenAI 实时翻译"
    languages: ClassVar[tuple[str, ...]]  # 支持的目标语言（平台语种代码）
    session_cls: ClassVar[type[S2SSession]]

    def __init__(self, cfg: StreamConfig, emit, deps):
        super().__init__(cfg, emit, deps)
        self.model_cfg: ModelConfig | None = None
        self.api_key = ""
        self._sessions: dict[str, S2SSession] = {}
        self._glossaries: dict = {}
        self._ptt: str | None = None
        self._muted = False
        self._finishing = False
        self._uids: dict[Any, int] = {}
        self._bg: set[asyncio.Task] = set()

    # ---------------- 子类可覆盖 ----------------

    def check_pair(self, source: str | None, target: str) -> str | None:
        """语种约束：返回不支持的原因，支持时返回 None。"""
        if target not in self.languages:
            return f"{self.label}不支持目标语言 {target}"
        return None

    # ---------------- 生命周期 ----------------

    async def start(self) -> None:
        cfg = self.cfg
        if cfg.mode == "CONVERSE" and cfg.converse_routing != "ptt":
            raise EngineError(ErrorCode.PARAM_INVALID, "该引擎仅支持按键说话")
        # 会议室：发言人语言须能与占位目标组成合法语种对（目标中不合法的语言只跳过）
        checks = [self._placeholder_target()] if cfg.mode == "ROOM" else self._initial_targets()
        for t in checks:
            reason = self.check_pair(self.session_source(t), t)
            if reason:
                raise EngineError(ErrorCode.PARAM_INVALID, reason)
        targets = self._initial_targets()
        self.model_cfg, self.api_key = await resolve_config(
            self.deps.registry, self.provider, cfg.model_config_id, self.label
        )
        self._glossaries = await self.load_glossaries()
        primary = [cfg.mode == "CONVERSE" or i == 0 for i in range(len(targets))]
        sessions = [self.session_cls(self, t, primary=p) for t, p in zip(targets, primary, strict=True)]
        if not sessions and cfg.mode == "ROOM":
            sessions = [self._placeholder_session()]
        results = await asyncio.gather(*(s.connect() for s in sessions), return_exceptions=True)
        failed = next((r for r in results if isinstance(r, BaseException)), None)
        if failed is not None:
            await asyncio.gather(*(s.close() for s in sessions), return_exceptions=True)
            if isinstance(failed, EngineError):
                raise failed
            raise EngineError(ErrorCode.REALTIME_UPSTREAM_FAILED, f"{self.label}连接失败") from failed
        self._sessions = {s.target: s for s in sessions}
        self.emit_ready()
        log.info("%s开始 stream=%s model=%s targets=%s", self.label, cfg.stream_id, self.model_cfg.model_name, targets)

    def _initial_targets(self) -> list[str]:
        cfg = self.cfg
        if cfg.mode == "LISTEN":
            return cfg.target_langs[:1]
        if cfg.mode == "CONVERSE":
            return list(cfg.pair)
        return self._room_targets(cfg.target_langs)

    def _room_targets(self, targets: list[str]) -> list[str]:
        """会议室目标：去重、去掉发言人语言；不满足语种约束的发非致命 A0410 并跳过；最多 max_targets 个。"""
        wanted: list[str] = []
        for t in room_targets(self.cfg.declared_source, [t for t in targets if isinstance(t, str)]):
            reason = self.check_pair(self.cfg.declared_source, t)
            if reason:
                self.emit_error(ErrorCode.PARAM_INVALID, reason)
            else:
                wanted.append(t)
        return wanted[: self.max_targets]

    async def feed(self, pcm: bytes) -> None:
        if self._muted or not pcm:
            return
        for s in self._active_sessions():
            await s.send_audio(pcm)

    def _active_sessions(self, side: str | None = None) -> list[S2SSession]:
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

    def _placeholder_target(self) -> str:
        return "zh" if self.cfg.declared_source == "en" else "en"

    def _placeholder_session(self, index_base: int = 0) -> S2SSession:
        """单人会议室：目标取英语（发言人说英语时取中文），只转发原文。"""
        return self.session_cls(
            self, self._placeholder_target(), primary=True, index_base=index_base, transcribe_only=True
        )

    async def _update_targets(self, targets: list[str]) -> None:
        wanted = self._room_targets(targets)
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
            s = self.session_cls(self, t, primary=not self._sessions, index_base=base)
            self._sessions[t] = s
            self._spawn(self._connect_new(s))

    async def _connect_new(self, s: S2SSession) -> None:
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

    def allocate_uid(self, session: S2SSession, index: int) -> int:
        """会议室各会话收到同一路音频：第 k 句对齐到同一 utteranceId；其他模式各会话独立分配。"""
        key: Any = index if self.cfg.mode == "ROOM" else (session.target, index)
        uid = self._uids.get(key)
        if uid is None:
            uid = self._uids[key] = self.next_uid()
        return uid

    def session_source(self, target: str) -> str | None:
        if self.cfg.mode == "CONVERSE":
            a, b = self.cfg.pair
            return a if target == b else b
        return self.cfg.declared_source

    def phrases(self, target: str) -> dict[str, str]:
        """热词：目标语言匹配的术语库全部术语（源语种已知时还要求源语种一致）。"""
        source = self.session_source(target)
        out: dict[str, str] = {}
        for g in self._glossaries.values():
            if g.target_lang != target or (source and g.source_lang != source):
                continue
            for term in g.terms:
                if len(out) >= MAX_PHRASES:
                    return out
                out.setdefault(term.source_term, term.target_term)
        return out

    async def source_lang(self, text: str, target: str, reported: str | None = None) -> str | None:
        """原文语种：双向对话为该会话目标语言的另一侧；否则声明的源语种 > 厂商报告的语种 > lingua 判定。"""
        return self.session_source(target) or reported or await self.detect_lang(text)

    def emit_error_upstream(self, message: str) -> None:
        """上游会话中的错误事件：非致命 C0174。"""
        self.emit_error(ErrorCode.REALTIME_UPSTREAM_FAILED, f"{self.label}：{message}")

    def session_lost(self, session: S2SSession) -> None:
        if self._finishing or self.fatal.is_set():
            return
        if session.reconnected:
            self.fail(EngineError(ErrorCode.REALTIME_UPSTREAM_FAILED, f"{self.label}上游连接中断"))
            return
        session.reconnected = True
        self.emit_error(ErrorCode.REALTIME_UPSTREAM_FAILED, f"{self.label}上游连接中断，正在重建会话")
        self._spawn(self._reconnect(session))

    async def _reconnect(self, session: S2SSession) -> None:
        try:
            await session.connect()
        except EngineError as e:
            self.fail(EngineError(e.error, f"{self.label}会话重建失败：{e.message}"))
        else:
            log.info("%s会话已重建 target=%s", self.label, session.target)
