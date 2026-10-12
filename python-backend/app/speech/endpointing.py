"""两段式断句（improve-speech-endpointing-and-live-ux D1–D4）。

VAD 静音达到候选阈值只算"候选句末"：对"已挂起音频 + 本段"整体识别，再由 TurnJudge 判定是否说完：
- 说完 → Commit；未说完 → Hold（等待续说），等待期间再开口则并入同一句、对合并音频重新识别；
- 等待按音频时钟计时（Hold 之后收到的采样数），另由调用方按 Hold.deadline_s 投递墙钟兜底（expire）；
- 强制定稿：flush、VAD 达到最长语音时长被强制切出的段、合并语音达到上限；
- 识别为空（或去掉语气词后为空）的语句丢弃（Discard），不翻译、不回复。

判定（D2）：识别模型会给半句也补句末标点（实测"请问去。""Let's move on to the."），因此不看标点：
1. 文本强规则：以延续词（连词、介词、冠词、语气词等）结尾 → 未说完；
2. 声学模型 Smart Turn v3（可用时）：完成概率 ≥ 阈值 → 说完；以弱延续词（如中文"的"）结尾时，
   概率还须 ≥ confident（缺省 0.99）才算说完——实测合成中文的半句在逗号处也有降调，模型给分普遍偏高；
3. 模型不可用：弱延续词判为未说完，其余一律判为说完（与改造前一致）。
"""

import logging
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Protocol

import numpy as np

from app.speech.asr import AsrResult
from app.speech.vad import SAMPLE_RATE, SpeechSegment

log = logging.getLogger("app.speech.endpointing")

MERGE_GAP_MS = 120  # 合并语音段之间插入的静音
FORCED_CUT_MARGIN_S = 0.2  # 段长达到 max_speech − margin 视为被强制切出
BACKSTOP_MS = 300  # 墙钟兜底 = 续说等待 + 300 ms

_PUNCT = re.compile(r"[\s\W_]+$", re.UNICODE)
_CJK = "぀-ヿ㐀-䶿一-鿿가-힯"
_CJK_CHAR = re.compile(rf"[{_CJK}]")
_LATIN_WORD = re.compile(r"[^\W\d_]{2,}", re.UNICODE)
_DIGIT = re.compile(r"\d")
_TOKEN = re.compile(rf"[^\s\W_{_CJK}]+(?:['’][^\s\W]+)?|[{_CJK}]", re.UNICODE)

# 语气词：zh / ja / ko 按子串去除，其他语言按词
FILLERS: dict[str, tuple[str, ...]] = {
    "zh": ("就是说", "那个", "就是", "嗯", "呃", "额", "啊", "哦", "唔", "噢", "呀"),
    "en": ("um", "umm", "uh", "uhh", "uhm", "er", "erm", "hmm", "hm", "mm", "ah", "oh", "eh"),
    "ja": ("えーと", "えっと", "ええと", "うーん", "あのー", "あの", "まあ", "えー", "ええ"),
    "ko": ("저기", "음", "어", "그", "아"),
}
_FILLER_WORDS = {w for lang in ("en",) for w in FILLERS[lang]}
_CJK_FILLERS = sorted({w for lang in ("zh", "ja", "ko") for w in FILLERS[lang]}, key=len, reverse=True)

# 延续词：强规则总是生效；弱规则只在没有声学模型时生效（单独看文本容易误判为未说完）
STRONG_SUFFIX = {
    "zh": (
        "而且",
        "但是",
        "可是",
        "不过",
        "所以",
        "因为",
        "如果",
        "然后",
        "那个",
        "这个",
        "就是",
        "比如",
        "还有",
        "以及",
        "或者",
        "并且",
        "而是",
        "和",
        "跟",
        "与",
        "及",
        "把",
        "被",
        "从",
        "向",
        "往",
        "嗯",
        "呃",
    ),
    "ja": ("えーと", "えっと", "あの", "けど", "から", "ので", "けれど"),
    "ko": ("그리고", "그런데", "그래서", "하지만", "음", "어"),
}
WEAK_SUFFIX = {
    "zh": ("的", "地", "是", "要", "想", "在", "给", "对于", "关于"),
    "ja": ("を", "に", "が", "は", "と", "で", "の"),
    "ko": ("을", "를", "이", "가", "은", "는", "에서", "에게", "고"),
}
STRONG_WORDS = {
    "en": {
        "the",
        "a",
        "an",
        "of",
        "and",
        "but",
        "or",
        "because",
        "my",
        "your",
        "our",
        "their",
        "um",
        "uh",
        "er",
        "erm",
        "uhm",
        "umm",
        "with",
        "from",
        "into",
        "than",
        "if",
    },
}
WEAK_WORDS = {
    "en": {
        "to",
        "for",
        "in",
        "on",
        "at",
        "by",
        "about",
        "is",
        "are",
        "was",
        "were",
        "his",
        "her",
        "its",
        "like",
        "will",
        "would",
        "can",
        "could",
        "should",
        "that",
        "which",
        "who",
        "so",
        "then",
    },
}
# 以"的"等弱延续词结尾、但通常是完整说法的例外
COMPLETE_SUFFIX = (
    "是的",
    "好的",
    "对的",
    "真的",
    "挺好的",
    "可以的",
    "没问题的",
    "当然的",
    "行的",
    "会的",
    "有的",
    "没有的",
    "我的",
    "你的",
    "他的",
    "她的",
    "我们的",
    "你们的",
    "他们的",
    "别的",
    "似的",
    "是在",
    "不在",
    "不是",
    "就是这样",
)


def _lang_key(lang: str | None) -> str:
    return "zh" if lang in (None, "", "yue") else lang


def strip_tail(text: str) -> str:
    """去掉末尾标点与空白。"""
    return _PUNCT.sub("", text or "").strip()


def content_of(text: str) -> str:
    """去掉标点、空白与语气词后的内容（用于判断纯语气词 / 比较续说是否带来新内容）。"""
    s = text or ""
    for w in _CJK_FILLERS:
        s = s.replace(w, " ")
    tokens = [t for t in _TOKEN.findall(s) if t.lower() not in _FILLER_WORDS]
    return "".join(tokens).lower()


def is_meaningful(text: str) -> bool:
    """有实际内容：至少 1 个中日韩字、1 个长度 ≥ 2 的拉丁词或 1 个数字（单字回答"好""no"仍算）。"""
    c = content_of(text)
    return bool(_CJK_CHAR.search(c) or _LATIN_WORD.search(c) or _DIGIT.search(c))


def continuation(text: str, lang: str | None) -> str | None:
    """以延续词结尾时返回 "strong" / "weak"，否则 None。问句（以 ? 结尾）不算。"""
    raw = (text or "").rstrip()
    if raw.endswith(("?", "？")):
        return None
    tail = strip_tail(raw)
    if not tail:
        return None
    key = _lang_key(lang)
    if _CJK_CHAR.search(tail[-1]):
        if tail.endswith(COMPLETE_SUFFIX):
            return None
        for kind, table in (("strong", STRONG_SUFFIX), ("weak", WEAK_SUFFIX)):
            suffixes = table.get(key, ()) + (table.get("zh", ()) if key not in table else ())
            if tail.endswith(suffixes):
                return kind
        return None
    words = re.findall(r"[^\W\d_]+(?:['’][^\W\d_]+)?", tail.lower())
    if not words:
        return None
    last = words[-1]
    if last in STRONG_WORDS.get("en", set()) or last in _FILLER_WORDS:
        return "strong"
    if last in WEAK_WORDS.get("en", set()):
        return "weak"
    return None


# ---------------- 判定器 ----------------


class TurnModel(Protocol):
    """声学句末模型（Smart Turn）。"""

    @property
    def available(self) -> bool: ...

    async def predict(self, audio: np.ndarray) -> float: ...


@dataclass
class Verdict:
    complete: bool
    reason: str
    prob: float | None = None


class TurnJudge:
    def __init__(self, model: TurnModel | None = None, threshold: float = 0.5, confident: float = 0.99):
        self._model = model
        self._threshold = threshold
        self._confident = confident

    @property
    def model_ready(self) -> bool:
        return self._model is not None and self._model.available

    async def judge(self, text: str, lang: str | None, audio: np.ndarray) -> Verdict:
        cont = continuation(text, lang)
        if cont == "strong":
            return Verdict(False, "continuation")
        if self.model_ready:
            try:
                prob = await self._model.predict(audio)
            except Exception:  # noqa: BLE001 - 模型异常时退化为文本规则
                log.warning("Smart Turn 推理失败，本句按文本规则判定", exc_info=True)
            else:
                if cont == "weak":
                    return Verdict(prob >= self._confident, "model-weak", prob)
                return Verdict(prob >= self._threshold, "model", prob)
        if cont == "weak":
            return Verdict(False, "continuation-weak")
        return Verdict(True, "default")


# ---------------- 参数档位 ----------------


@dataclass(frozen=True)
class EndpointProfile:
    candidate_silence_ms: int
    hold_ms: int
    merge_max_s: float
    max_speech_s: float = 10.0


def profile_for(settings, mode: str | None, latency_mode: str | None) -> EndpointProfile:
    """LISTEN / CONVERSE / ROOM 用同传档，CHAT 用对话档；均衡 / 极速取自 latencyMode。"""
    fast = latency_mode == "fast"
    chat = mode == "CHAT"
    silence = settings.speech_vad_min_silence_ms_fast if fast else settings.speech_vad_min_silence_ms
    if chat:
        hold = settings.endpoint_hold_ms_chat_fast if fast else settings.endpoint_hold_ms_chat
        merge = settings.endpoint_merge_max_s_chat
    else:
        hold = settings.endpoint_hold_ms_fast if fast else settings.endpoint_hold_ms
        merge = settings.endpoint_merge_max_s_fast if fast else settings.endpoint_merge_max_s
    return EndpointProfile(silence, hold, merge, settings.speech_vad_max_speech_s)


# ---------------- 判定结果 ----------------


@dataclass
class Hold:
    """未说完，等待续说：text 为合并音频的识别结果（发 partial{hold:true}）。"""

    text: str
    lang: str | None
    token: int
    deadline_s: float


@dataclass
class Commit:
    text: str
    lang: str | None
    start_ms: int
    end_ms: int
    hold_ms: int
    asr_ms: int
    t0: float  # 最后一次候选句末开始识别的时刻（metrics 的起点）
    reason: str = ""


@dataclass
class Discard:
    """该句作废（识别为空 / 纯语气词 / 识别失败）；error 为识别失败时的 (ErrorCode, message)。"""

    reason: str
    error: tuple | None = None


Decision = Hold | Commit | Discard


class Vad(Protocol):
    @property
    def speaking(self) -> bool: ...

    def accept(self, samples: np.ndarray) -> list[SpeechSegment]: ...

    def current(self) -> SpeechSegment | None: ...

    def flush(self) -> list[SpeechSegment]: ...


class Asr(Protocol):
    async def transcribe(self, samples: np.ndarray, lang_hint: str | None = None) -> AsrResult: ...


@dataclass
class _Pending:
    segments: list[SpeechSegment] = field(default_factory=list)
    text: str = ""
    lang: str | None = None
    asr_ms: int = 0
    t0: float = 0.0
    hold_ms: int = 0  # 已完成的等待累计
    holding: bool = False
    hold_fed: int = 0  # 本次等待已收到的采样数
    token: int = 0

    @property
    def samples(self) -> int:
        return sum(len(s.samples) for s in self.segments)


class Endpointer:
    """一条发言流的断句器（非线程安全，由单个处理协程驱动）。"""

    def __init__(
        self,
        vad: Vad,
        asr: Asr,
        judge: TurnJudge,
        profile: EndpointProfile,
        hint: Callable[[], str | None] = lambda: None,
    ):
        self._vad = vad
        self._asr = asr
        self._judge = judge
        self.profile = profile
        self._hint = hint
        self._p: _Pending | None = None
        self._token = 0

    # ---------------- 状态 ----------------

    @property
    def speaking(self) -> bool:
        return self._vad.speaking

    @property
    def holding(self) -> bool:
        return self._p is not None and self._p.holding

    @property
    def open(self) -> bool:
        """有尚未定稿的语句（挂起中或正在说）。"""
        return self._p is not None or self._vad.speaking

    def current_audio(self) -> np.ndarray | None:
        """partial 用：挂起音频 + 进行中的语音段。"""
        cur = self._vad.current()
        parts = [s.samples for s in self._p.segments] if self._p else []
        if cur is not None:
            parts.append(cur.samples)
        return _concat(parts) if parts else None

    # ---------------- 驱动 ----------------

    async def accept(self, samples: np.ndarray, hint: str | None = None) -> list[Decision]:
        out: list[Decision] = []
        for seg in self._vad.accept(samples):
            out += await self._candidate(seg, hint)
        p = self._p
        if p is None or not len(samples):
            return out
        if p.holding:
            if self._vad.speaking:
                self._resume(p)
            else:
                p.hold_fed += len(samples)
                if p.hold_fed * 1000 >= self.profile.hold_ms * SAMPLE_RATE:
                    out.append(self._expire(p))
        elif not self._vad.speaking:
            out.append(self._hold(p))  # 续说太短没有成段（VAD 抖动）：回到等待
        return out

    async def flush(self, hint: str | None = None) -> list[Decision]:
        """强制断句：缓冲中的语音与挂起内容立即定稿（或丢弃）。"""
        out: list[Decision] = []
        segs = self._vad.flush()
        for seg in segs:
            out += await self._candidate(seg, hint, force=True)
        if not segs and self._p is not None:
            out.append(self._expire(self._p, "flush"))
        return out

    def expire(self, token: int) -> list[Decision]:
        """墙钟兜底：该次等待仍未结束（且没有在说话）时定稿。"""
        p = self._p
        if p is None or not p.holding or p.token != token or self._vad.speaking:
            return []
        return [self._expire(p)]

    # ---------------- 内部 ----------------

    def _resume(self, p: _Pending) -> None:
        p.holding = False
        p.hold_ms += p.hold_fed * 1000 // SAMPLE_RATE
        p.hold_fed = 0

    def _expire(self, p: _Pending, reason: str = "hold-timeout") -> Decision:
        if p.holding:
            self._resume(p)
        self._p = None
        if not is_meaningful(p.text):
            return Discard("filler" if p.text else "empty")
        return self._commit(p, reason)

    def _commit(self, p: _Pending, reason: str) -> Commit:
        first, last = p.segments[0], p.segments[-1]
        return Commit(p.text, p.lang, first.start_ms, last.end_ms, p.hold_ms, p.asr_ms, p.t0, reason)

    async def _candidate(self, seg: SpeechSegment, hint: str | None, force: bool = False) -> list[Decision]:
        t0 = time.perf_counter()
        p = self._p or _Pending()
        if p.holding:
            self._resume(p)
        prev = content_of(p.text)
        p.segments.append(seg)
        audio = _concat([s.samples for s in p.segments])
        try:
            res = await self._asr.transcribe(audio, hint if hint is not None else self._hint())
        except Exception as e:  # noqa: BLE001 - 由调用方发 error
            self._p = None
            return [Discard("asr-error", error=_asr_error(e))]
        p.t0, p.asr_ms = t0, res.latency_ms
        if res.text:
            p.text, p.lang = res.text, res.lang or p.lang
        self._p = p
        content = content_of(p.text)
        forced = force or seg.duration_ms >= (self.profile.max_speech_s - FORCED_CUT_MARGIN_S) * 1000
        too_long = p.samples >= self.profile.merge_max_s * SAMPLE_RATE
        if not is_meaningful(p.text):
            if not p.text or forced or too_long or self.profile.hold_ms <= 0:
                self._p = None  # 识别为空：噪声直接丢弃；纯语气词在不能再等时丢弃
                return [Discard("filler" if p.text else "empty")]
            return [self._hold(p)]  # 纯语气词：可能正在想词，等续说
        if forced or too_long or self.profile.hold_ms <= 0:
            self._p = None
            return [self._commit(p, "forced" if forced else ("merge-max" if too_long else "no-hold"))]
        if prev and content == prev:
            return [self._hold(p)]  # 续说只带来语气词或噪声：保持等待并重新计时
        verdict = await self._judge.judge(p.text, p.lang, audio)
        if verdict.complete:
            self._p = None
            return [self._commit(p, verdict.reason)]
        return [self._hold(p)]

    def _hold(self, p: _Pending) -> Hold:
        self._token += 1
        p.holding, p.hold_fed, p.token = True, 0, self._token
        return Hold(p.text, p.lang, p.token, (self.profile.hold_ms + BACKSTOP_MS) / 1000)


def _concat(parts: list[np.ndarray]) -> np.ndarray:
    if len(parts) == 1:
        return parts[0]
    gap = np.zeros(MERGE_GAP_MS * SAMPLE_RATE // 1000, dtype=np.float32)
    out: list[np.ndarray] = []
    for i, x in enumerate(parts):
        if i:
            out.append(gap)
        out.append(x)
    return np.concatenate(out).astype(np.float32, copy=False)


def _asr_error(e: Exception) -> tuple:
    from app.core.errors import BizException, ErrorCode

    if isinstance(e, BizException):
        return e.error, f"语音识别失败：{e.message}"
    log.exception("候选句末识别失败", exc_info=e)
    return ErrorCode.SPEECH_ENGINE_UNAVAILABLE, "语音识别失败"
