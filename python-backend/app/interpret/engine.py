"""同传引擎接口与统一事件模型（design D3 / D7，契约 §1.8）。

- StreamConfig：WS 首帧 config（一条连接 = 一条发言流）
- InterpretEngine：引擎接口 start / feed / control / finish / close，
  事件经 emit 推送（单行 JSON，camelCase）
- AudioSequencer：按 utteranceId 顺序发出 audio（每个语种内前一句发完才发下一句），
  同句同语种 seq 递增、最后一包 last=true，整句全部语种结束后回调发出 metrics
- UtteranceMetrics：逐句计时（asrMs / mtFirstMs / mtMs / ttsFirstMs / e2eMs）
- 发言流重建恢复上下文（improve-prompts-and-context-memory D5）：config 的 history 为本成员最近的定稿语句，
  chat.memory 为 AI 对话记忆摘要；均由 Spring 暂存后下发，首次建流时为空
"""

import asyncio
import base64
import logging
import time
from abc import ABC, abstractmethod
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, ClassVar, Literal

from pydantic import Field, field_validator

from app.core.config import Settings
from app.core.errors import ErrorCode
from app.core.schema import CamelModel
from app.glossary.repository import Glossary
from app.lang import languages

log = logging.getLogger("app.interpret")

Mode = Literal["LISTEN", "CONVERSE", "ROOM", "CHAT"]
ChatScenario = Literal["free", "travel", "restaurant", "business", "interview"]
LatencyMode = Literal["balanced", "fast"]
Event = dict[str, Any]
Emit = Callable[[Event], None]

SIDE_A = "A"
SIDE_B = "B"


class ConfigError(ValueError):
    """首帧 config 非法（A0410，关闭码 4400）。"""


HISTORY_MAX_ITEMS = 24
HISTORY_MAX_TEXT = 500
CHAT_MEMORY_MAX_CHARS = 2000


def _cut(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit]


class HistoryItem(CamelModel):
    """发言流重建时恢复的一句：角色、语言、原文与各语言译文（Spring 已截断，这里兜底）。"""

    role: Literal["user", "assistant"] = "user"
    lang: str | None = None
    text: str = ""
    translations: dict[str, str] = Field(default_factory=dict)

    @field_validator("role", mode="before")
    @classmethod
    def _none_to_user(cls, v: Any) -> Any:
        return "user" if v is None else v

    @field_validator("text", mode="before")
    @classmethod
    def _cut_text(cls, v: Any) -> Any:
        return _cut(v.strip(), HISTORY_MAX_TEXT) if isinstance(v, str) else ("" if v is None else v)

    @field_validator("translations", mode="before")
    @classmethod
    def _clean_translations(cls, v: Any) -> Any:
        if not isinstance(v, dict):
            return {}
        return {k: _cut(t, HISTORY_MAX_TEXT) for k, t in v.items() if isinstance(t, str) and t.strip()}


class ChatConfig(CamelModel):
    """AI 对话（CHAT）配置（add-ai-avatar-and-landing D6）。"""

    scenario: ChatScenario = "free"
    my_lang: str
    ai_lang: str
    persona: str = Field(default="Lumi", max_length=32)
    greet: bool = True  # 发言流首次建立时 AI 先开口；断线重建时为 false
    memory: str | None = None  # 对话记忆摘要（发言流重建时恢复）

    @field_validator("memory", mode="before")
    @classmethod
    def _cut_memory(cls, v: Any) -> Any:
        return (_cut(v.strip(), CHAT_MEMORY_MAX_CHARS) or None) if isinstance(v, str) else v


class StreamConfig(CamelModel):
    type: Literal["config"] = "config"
    stream_id: str = ""
    session_id: int | None = None
    user_id: int | None = None
    mode: Mode = "LISTEN"
    engine: str = "cascade"
    source_langs: list[str] = Field(default_factory=lambda: [languages.AUTO])
    target_langs: list[str] = Field(default_factory=list)
    converse_routing: Literal["auto", "ptt"] = "auto"
    glossary_ids: list[int] = Field(default_factory=list)
    domain_hint: str | None = Field(default=None, max_length=64)
    model_config_id: int | None = Field(default=None, ge=1)
    asr_engine: str | None = None
    tts_engine: str | None = None
    tts: bool = True
    voices: dict[str, str | None] = Field(default_factory=dict)
    gender: Literal["female", "male"] = "female"
    chat: ChatConfig | None = None
    # 响应速度档位（improve-speech-playback-latency D6）：只对级联引擎生效，S2S 与实时语音模型忽略
    latency_mode: LatencyMode = "balanced"
    # 本成员最近的定稿语句（发言流重建时恢复上下文）：没有 text 的条目丢弃，超过上限时只保留最新的
    history: list[HistoryItem] = Field(default_factory=list)

    @field_validator("history", mode="before")
    @classmethod
    def _history_items(cls, v: Any) -> Any:
        if not isinstance(v, list):
            return []
        items = [h for h in v if isinstance(h, dict) and isinstance(h.get("text"), str) and h["text"].strip()]
        return items[-HISTORY_MAX_ITEMS:]

    @field_validator("source_langs", "target_langs", "glossary_ids", mode="before")
    @classmethod
    def _none_to_empty(cls, v: Any) -> Any:
        return [] if v is None else v

    @field_validator("voices", mode="before")
    @classmethod
    def _none_to_dict(cls, v: Any) -> Any:
        return {} if v is None else v

    @field_validator("gender", mode="before")
    @classmethod
    def _none_to_female(cls, v: Any) -> Any:
        return "female" if v is None else v

    @field_validator("latency_mode", mode="before")
    @classmethod
    def _none_to_balanced(cls, v: Any) -> Any:
        return "balanced" if v is None else v

    @field_validator("converse_routing", mode="before")
    @classmethod
    def _none_to_auto(cls, v: Any) -> Any:
        # Spring 在 LISTEN / ROOM 模式下传 null（路由只对 CONVERSE 有意义）
        return "auto" if v is None else v

    @property
    def pair(self) -> tuple[str, str]:
        """CONVERSE 的语言 A、B（sourceLangs 为 [A,B]，缺省时取 targetLangs）。"""
        langs = self.source_langs if len(self.source_langs) == 2 else self.target_langs
        return langs[0], langs[1]

    @property
    def declared_source(self) -> str | None:
        """LISTEN 只给出一个确定源语种时、ROOM 发言人语言、CHAT 两种语言相同时；否则 None（自动识别）。"""
        if self.mode == "CONVERSE":
            return None
        if self.mode == "CHAT":
            # 两种语言相同（用母语聊天）时识别语种确定；否则在两者间自动识别
            return self.chat.my_lang if self.chat and self.chat.my_lang == self.chat.ai_lang else None
        known = [s for s in self.source_langs if s != languages.AUTO]
        return known[0] if len(known) == 1 and len(self.source_langs) == 1 else None

    def side_lang(self, side: str | None) -> str | None:
        if self.mode != "CONVERSE" or side not in (SIDE_A, SIDE_B):
            return None
        a, b = self.pair
        return a if side == SIDE_A else b

    def check(self, max_targets: int) -> None:
        def _supported(codes: list[str], what: str) -> None:
            bad = [c for c in codes if not languages.is_supported(c)]
            if bad:
                raise ConfigError(f"{what}包含不支持的语种: {', '.join(bad)}")

        if self.mode == "LISTEN":
            if len(self.target_langs) != 1:
                raise ConfigError("同传收听需要且只能指定一种目标语言")
            _supported(self.target_langs, "目标语言")
            _supported([s for s in self.source_langs if s != languages.AUTO], "源语种提示")
        elif self.mode == "CONVERSE":
            langs = self.source_langs if len(self.source_langs) == 2 else self.target_langs
            if len(langs) != 2:
                raise ConfigError("双向对话需要指定两种语言")
            _supported(langs, "对话语言")
            if langs[0] == langs[1]:
                raise ConfigError("双向对话的两种语言不能相同")
        elif self.mode == "CHAT":
            if self.chat is None:
                raise ConfigError("AI 对话需要 chat 配置")
            _supported([self.chat.my_lang, self.chat.ai_lang], "对话语言")
        else:
            if len(self.source_langs) != 1:
                raise ConfigError("会议室需要指定发言人语言")
            _supported(self.source_langs, "发言人语言")
            _supported(self.target_langs, "目标语言")
            if len(set(self.target_langs)) > max_targets:
                raise ConfigError(f"目标语言最多 {max_targets} 种")


def room_targets(source: str | None, targets: list[str]) -> list[str]:
    """会议室目标：去重、去掉发言人自己的语言。"""
    return [t for t in dict.fromkeys(targets) if t != source]


@dataclass
class EngineDeps:
    """引擎运行时依赖（来自 app.state）。"""

    settings: Settings
    registry: Any  # app.llm.registry.LLMRegistry
    glossary_repo: Any  # app.glossary.repository.GlossaryRepository
    detector: Any = None  # app.lang.detector.LanguageDetector


class EngineError(Exception):
    def __init__(self, error: ErrorCode, message: str | None = None, fatal: bool = True):
        self.error = error
        self.message = message or error.message
        self.fatal = fatal
        super().__init__(self.message)


def event(type_: str, **fields: Any) -> Event:
    return {"type": type_, **fields}


def error_event(error: ErrorCode, message: str | None = None, fatal: bool = False) -> Event:
    return event("error", code=error.code, message=message or error.message, fatal=fatal)


def ms_since(t: float | None, now: float | None = None) -> int | None:
    if t is None:
        return None
    return max(0, int(((now if now is not None else time.perf_counter()) - t) * 1000))


@dataclass
class UtteranceMetrics:
    """逐句计时：t0 为说话结束（级联：VAD 判定句末；S2S：speech_stopped）。

    e2eMs = t0 → 首段译音就绪（合成或上游返回首包，不含按序发出时的排队）；
    没有音频（未开播报或合成失败）时为 t0 → 首个译文定稿；只有原文时为 null。
    多目标时 mtFirstMs / ttsFirstMs 取最快的目标，mtMs 取最慢的目标。
    """

    t0: float
    asr_ms: int | None = None
    hold_ms: int | None = None  # 级联两段式断句：该句在续说等待中累计停留的时长（其他引擎没有）
    mt_first: list[int] = field(default_factory=list)
    mt_total: list[int] = field(default_factory=list)
    tts_first: list[int] = field(default_factory=list)
    first_final_at: float | None = None

    def final_emitted(self, at: float | None = None) -> None:
        at = at if at is not None else time.perf_counter()
        if self.first_final_at is None or at < self.first_final_at:
            self.first_final_at = at

    def to_event(self, utterance_id: int, first_audio_at: float | None) -> Event:
        end = first_audio_at if first_audio_at is not None else self.first_final_at
        extra = {"holdMs": self.hold_ms} if self.hold_ms is not None else {}
        return event(
            "metrics",
            utteranceId=utterance_id,
            asrMs=self.asr_ms,
            mtFirstMs=min(self.mt_first) if self.mt_first else None,
            mtMs=max(self.mt_total) if self.mt_total else None,
            ttsFirstMs=min(self.tts_first) if self.tts_first else None,
            e2eMs=ms_since(self.t0, end) if end is not None else None,
            **extra,
        )


@dataclass
class _Chunk:
    data: bytes
    seg_last: bool = False


@dataclass
class _Track:
    chunks: deque[_Chunk] = field(default_factory=deque)
    ended: bool = False
    aborted: bool = False
    seq: int = 0
    seg: int = 0  # 当前段号，发出 segLast 后 +1
    seg_has_data: bool = False


@dataclass
class _Utterance:
    uid: int
    tracks: dict[str, _Track]
    fmt: str
    sample_rate: int
    on_done: Callable[[float | None], None] | None
    first_audio_at: float | None = None
    finished: set[str] = field(default_factory=set)


class AudioSequencer:
    """音频顺序发射器（improve-speech-playback-latency D3）。

    - open(uid, langs)：句子在路由完成后登记（uid 递增顺序），langs 为该句需要等待的目标语种
    - push(uid, lang, data, seg_last=False)：合成或上游音频到达；seg_last=True 标记一次独立合成（段）的最后一包，
      data 可为空（合成方结束时缓冲已空）。end_segment(uid, lang) 等价于推一个空的段尾标记
    - end(uid, lang)：该语种结束（无论是否有音频都必须调用）；abort(uid, lang)：丢弃未发出的音频并结束（打断）
    - 每个语种内只有队首句子的音频立即发出，后续句子的音频先缓存；不再暂扣任何分包。
      audio 事件带 seq（track 内递增）、seg（段号）、segLast；track 结束且发过音频时补发 data 为空、last=true 的终止包
      （被 abort 的 track 不发终止包）
    - 句子全部语种结束后调用 on_done(first_audio_at)，由调用方发出 metrics
    """

    def __init__(self, emit: Emit, clock: Callable[[], float] = time.perf_counter):
        self._emit = emit
        self._clock = clock
        self._utts: dict[int, _Utterance] = {}
        self._queues: dict[str, deque[int]] = {}

    @property
    def pending(self) -> int:
        return len(self._utts)

    def open(
        self,
        uid: int,
        langs: list[str],
        fmt: str = "mp3",
        sample_rate: int = 24000,
        on_done: Callable[[float | None], None] | None = None,
    ) -> None:
        langs = list(dict.fromkeys(langs))
        utt = _Utterance(uid, {lang: _Track() for lang in langs}, fmt, sample_rate, on_done)
        if not langs:
            if on_done:
                on_done(None)
            return
        self._utts[uid] = utt
        for lang in langs:
            self._queues.setdefault(lang, deque()).append(uid)

    def push(self, uid: int, lang: str, data: bytes, seg_last: bool = False) -> None:
        track = self._track(uid, lang)
        if track is None or track.ended or not (data or seg_last):
            return
        track.chunks.append(_Chunk(data, seg_last))
        utt = self._utts[uid]
        if data and utt.first_audio_at is None:
            # 首段译音"就绪"时刻：不含等待前一句音频发完的排队时间（播放本就在客户端按序进行）
            utt.first_audio_at = self._clock()
        self._pump(lang)

    def end_segment(self, uid: int, lang: str) -> None:
        self.push(uid, lang, b"", seg_last=True)

    def end(self, uid: int, lang: str) -> None:
        track = self._track(uid, lang)
        if track is None or track.ended:
            return
        track.ended = True
        self._pump(lang)

    def abort(self, uid: int, lang: str) -> None:
        """丢弃该句该语种尚未发出的音频并结束（打断时用，之后不再发出该句的 audio）。"""
        track = self._track(uid, lang)
        if track is None or track.ended:
            return
        track.chunks.clear()
        track.ended = True
        track.aborted = True
        self._pump(lang)

    def first_audio_at(self, uid: int) -> float | None:
        utt = self._utts.get(uid)
        return utt.first_audio_at if utt else None

    def _track(self, uid: int, lang: str) -> _Track | None:
        utt = self._utts.get(uid)
        return utt.tracks.get(lang) if utt else None

    def _audio(self, utt: _Utterance, lang: str, track: _Track, data: bytes, seg_last: bool, last: bool) -> None:
        self._emit(
            event(
                "audio",
                utteranceId=utt.uid,
                lang=lang,
                format=utt.fmt,
                sampleRate=utt.sample_rate,
                seq=track.seq,
                seg=track.seg,
                segLast=seg_last,
                last=last,
                data=base64.b64encode(data).decode("ascii"),
            )
        )
        track.seq += 1

    def _pump(self, lang: str) -> None:
        queue = self._queues.get(lang)
        while queue:
            utt = self._utts[queue[0]]
            track = utt.tracks[lang]
            while track.chunks:
                chunk = track.chunks.popleft()
                if not chunk.data and not track.seg_has_data:
                    continue  # 空段（合成失败等）不发段尾标记，也不占段号
                self._audio(utt, lang, track, chunk.data, chunk.seg_last, last=False)
                track.seg_has_data = not chunk.seg_last
                if chunk.seg_last:
                    track.seg += 1
            if not track.ended:
                return
            if track.seq > 0 and not track.aborted:
                self._audio(utt, lang, track, b"", seg_last=False, last=True)
            queue.popleft()
            utt.finished.add(lang)
            if len(utt.finished) == len(utt.tracks):
                del self._utts[utt.uid]
                if utt.on_done:
                    try:
                        utt.on_done(utt.first_audio_at)
                    except Exception:  # noqa: BLE001
                        log.exception("metrics 回调失败 uid=%s", utt.uid)


class InterpretEngine(ABC):
    """同传引擎接口。一个实例对应一条发言流；emit 为非阻塞推送（由 WS 端点的发送协程串行写出）。"""

    id: ClassVar[str]
    max_targets: ClassVar[int]

    def __init__(self, cfg: StreamConfig, emit: Emit, deps: EngineDeps):
        self.cfg = cfg
        self.deps = deps
        self._emit_fn = emit
        self.fatal = asyncio.Event()
        self.fatal_error: EngineError | None = None
        self.sequencer = AudioSequencer(emit)
        self._uid = 0

    def emit(self, type_: str, **fields: Any) -> None:
        self._emit_fn(event(type_, **fields))

    def emit_error(self, error: ErrorCode, message: str | None = None, fatal: bool = False) -> None:
        self._emit_fn(error_event(error, message, fatal))

    def fail(self, err: EngineError) -> None:
        """致命错误：发出 error(fatal=true) 并通知端点关闭连接（1011）。"""
        if self.fatal.is_set():
            return
        self.fatal_error = err
        self.emit_error(err.error, err.message, fatal=True)
        self.fatal.set()

    def next_uid(self) -> int:
        self._uid += 1
        return self._uid

    def emit_ready(self) -> None:
        self.emit("ready", engine=self.id, sourceLangs=self.cfg.source_langs, targetLangs=self.cfg.target_langs)

    async def load_glossaries(self) -> dict[int, Glossary]:
        if not self.cfg.glossary_ids or self.deps.glossary_repo is None:
            return {}
        return await self.deps.glossary_repo.load(self.cfg.glossary_ids)

    async def detect_lang(self, text: str, allowed: tuple[str, ...] | None = None) -> str | None:
        """lingua 判定文本语种；allowed 不为空时只在其中选择。"""
        if not text or self.deps.detector is None:
            return None
        try:
            candidates = await asyncio.to_thread(self.deps.detector.lingua_candidates, text)
        except Exception:  # noqa: BLE001
            log.debug("语种判定失败", exc_info=True)
            return None
        for code, _ in candidates:
            if allowed is None or code in allowed:
                return code
        return None

    @abstractmethod
    async def start(self) -> None:
        """建连 / 加载模型，完成后发出 ready；失败抛出 EngineError。"""

    @abstractmethod
    async def feed(self, pcm: bytes) -> None:
        """PCM16LE 16 kHz 单声道音频帧。"""

    @abstractmethod
    async def control(self, msg: dict[str, Any]) -> None:
        """控制帧：targets / ptt / flush / mute。"""

    @abstractmethod
    async def finish(self) -> None:
        """正常结束：冲刷缓冲并等待在途句子处理完。"""

    @abstractmethod
    async def close(self) -> None:
        """释放资源（可重复调用）。"""
