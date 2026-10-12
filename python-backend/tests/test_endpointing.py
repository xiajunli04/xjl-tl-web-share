"""两段式断句（improve-speech-endpointing-and-live-ux 1.1 / 1.4）：延续词规则、判定器与断句状态机。

状态机用假 VAD（由测试决定何时产出语音段、是否在说话）与脚本化 ASR 驱动，按音频时钟推进。
"""

from dataclasses import dataclass, field

import numpy as np
import pytest

from app.speech.endpointing import (
    Commit,
    Discard,
    Endpointer,
    EndpointProfile,
    Hold,
    TurnJudge,
    content_of,
    continuation,
    is_meaningful,
    profile_for,
)
from app.speech.vad import SpeechSegment
from tests.speech_fakes import FakeASR

# ---------------- 规则 ----------------


@pytest.mark.parametrize(
    "text,lang,expected",
    [
        ("Let's move on to the.", "en", "strong"),
        ("Most of the growth came from Asia and.", "en", "strong"),
        ("I want to.", "en", "weak"),
        ("How can I help you today?", "en", None),
        ("What for?", "en", None),
        ("So um.", "en", "strong"),
        ("大家好，今天我们讨论新版本的。", "zh", "weak"),
        ("挺好的。", "zh", None),
        ("好的。", "zh", None),
        ("如果错误率超过千分之一。", "zh", None),
        ("我想问一下就是。", "zh", "strong"),
        ("因为。", "zh", "strong"),
        ("请问火车站怎么走？", "zh", None),
        ("他不在。", "zh", None),
        ("駅に。", "ja", "weak"),
    ],
)
def test_continuation(text, lang, expected):
    assert continuation(text, lang) == expected


@pytest.mark.parametrize(
    "text,meaningful",
    [
        ("嗯……", False),
        ("嗯，那个。", False),
        ("Um, uh.", False),
        (".", False),
        ("好。", True),
        ("对", True),
        ("No.", True),
        ("OK", True),
        ("5", True),
        ("嗯，我想退货", True),
        ("えーと", False),
        ("음", False),
    ],
)
def test_meaningful(text, meaningful):
    assert is_meaningful(text) is meaningful


def test_content_ignores_fillers_and_punct():
    assert content_of("我想问一下。") == content_of("我想问一下，嗯……")


@dataclass
class FakeModel:
    prob: float = 0.9
    available: bool = True
    error: bool = False
    calls: int = 0

    async def predict(self, audio: np.ndarray) -> float:
        self.calls += 1
        if self.error:
            raise RuntimeError("boom")
        return self.prob


async def test_judge_strong_rule_overrides_model():
    model = FakeModel(prob=0.99)
    v = await TurnJudge(model).judge("Let's move on to the.", "en", np.zeros(16000, np.float32))
    assert not v.complete and v.reason == "continuation" and model.calls == 0


async def test_judge_model_decides():
    audio = np.zeros(16000, np.float32)
    assert (await TurnJudge(FakeModel(prob=0.8)).judge("我们讨论发布计划。", "zh", audio)).complete
    weak = await TurnJudge(FakeModel(prob=0.98)).judge("我们讨论新版本的。", "zh", audio)
    assert not weak.complete and weak.reason == "model-weak"
    assert (await TurnJudge(FakeModel(prob=0.995)).judge("我们讨论新版本的。", "zh", audio)).complete
    v = await TurnJudge(FakeModel(prob=0.2)).judge("Most of the growth came.", "en", audio)
    assert not v.complete and v.prob == 0.2


async def test_judge_without_model():
    audio = np.zeros(16000, np.float32)
    assert (await TurnJudge(None).judge("Most of the growth came.", "en", audio)).complete
    weak = await TurnJudge(None).judge("我们讨论新版本的。", "zh", audio)
    assert not weak.complete and weak.reason == "continuation-weak"
    broken = await TurnJudge(FakeModel(error=True)).judge("Thanks for calling.", "en", audio)
    assert broken.complete and broken.reason == "default"


def test_profiles():
    class S:
        speech_vad_min_silence_ms = 500
        speech_vad_min_silence_ms_fast = 300
        speech_vad_max_speech_s = 10.0
        endpoint_hold_ms = 700
        endpoint_hold_ms_fast = 400
        endpoint_hold_ms_chat = 1500
        endpoint_hold_ms_chat_fast = 1000
        endpoint_merge_max_s = 12.0
        endpoint_merge_max_s_fast = 8.0
        endpoint_merge_max_s_chat = 20.0

    assert profile_for(S, "LISTEN", "balanced") == EndpointProfile(500, 700, 12.0, 10.0)
    assert profile_for(S, "ROOM", "fast") == EndpointProfile(300, 400, 8.0, 10.0)
    assert profile_for(S, "CHAT", None) == EndpointProfile(500, 1500, 20.0, 10.0)
    assert profile_for(S, "CHAT", "fast").hold_ms == 1000


# ---------------- 状态机 ----------------

FRAME = 640  # 40 ms


@dataclass
class FakeVad:
    speaking: bool = False
    ready: list[SpeechSegment] = field(default_factory=list)
    cur: SpeechSegment | None = None
    flushed: int = 0

    def accept(self, samples):
        out, self.ready = self.ready, []
        return out

    def current(self):
        return self.cur if self.speaking else None

    def flush(self):
        self.flushed += 1
        out, self.ready = self.ready, []
        return out


def seg(start_ms: int, ms: int) -> SpeechSegment:
    return SpeechSegment(start_ms * 16, np.ones(ms * 16, dtype=np.float32) * 0.1)


def silence(ms: int = 40) -> np.ndarray:
    return np.zeros(ms * 16, dtype=np.float32)


PROFILE = EndpointProfile(candidate_silence_ms=500, hold_ms=700, merge_max_s=12.0, max_speech_s=10.0)


def make(asr: list[tuple[str, str | None]], *, prob: float = 0.2, profile=PROFILE, model=True):
    vad = FakeVad()
    fake_asr = FakeASR(list(asr))
    judge = TurnJudge(FakeModel(prob=prob) if model else None)
    return Endpointer(vad, fake_asr, judge, profile), vad, fake_asr


async def feed_silence(ep: Endpointer, ms: int) -> list:
    out = []
    for _ in range(ms // 40):
        out += await ep.accept(silence())
    return out


async def test_complete_commits_immediately():
    ep, vad, _ = make([("请问火车站怎么走？", "zh")], prob=0.9)
    vad.ready = [seg(0, 1500)]
    out = await ep.accept(silence())
    assert len(out) == 1 and isinstance(out[0], Commit)
    c = out[0]
    assert (c.text, c.start_ms, c.end_ms, c.hold_ms) == ("请问火车站怎么走？", 0, 1500, 0)
    assert not ep.open


async def test_pause_merges_into_one_sentence():
    ep, vad, asr = make([("大家好，今天我们讨论新版本的。", "zh"), ("大家好，今天我们讨论新版本的发布计划。", "zh")])
    vad.ready = [seg(0, 2000)]
    first = await ep.accept(silence())
    assert isinstance(first[0], Hold) and ep.holding
    assert await feed_silence(ep, 400) == []  # 等待未到期
    vad.speaking = True  # 续说
    await ep.accept(silence())
    assert not ep.holding
    vad.speaking = False
    ep._judge = TurnJudge(FakeModel(prob=0.9))
    vad.ready = [seg(3000, 800)]
    out = await ep.accept(silence())
    assert len(out) == 1 and isinstance(out[0], Commit)
    c = out[0]
    assert c.text == "大家好，今天我们讨论新版本的发布计划。"
    assert (c.start_ms, c.end_ms) == (0, 3800)
    assert c.hold_ms == 440  # 400 ms 静音 + 续说时那一帧之前的 1 帧
    # 第二次识别使用合并音频：两段 + 120 ms 间隔
    assert asr.calls[1][0] == (2000 + 120 + 800) * 16


async def test_hold_timeout_commits_last_text():
    ep, vad, asr = make([("我想订两碗。", "zh")])
    vad.ready = [seg(0, 1200)]
    assert isinstance((await ep.accept(silence()))[0], Hold)
    out = await feed_silence(ep, 760)
    assert len(out) == 1 and isinstance(out[0], Commit)
    assert out[0].text == "我想订两碗。" and out[0].reason == "hold-timeout"
    assert out[0].hold_ms >= 700
    assert len(asr.calls) == 1  # 到期定稿不再识别


async def test_wall_clock_backstop():
    ep, vad, _ = make([("Let's move on to the.", "en")])
    vad.ready = [seg(0, 1000)]
    hold = (await ep.accept(silence()))[0]
    assert isinstance(hold, Hold) and hold.deadline_s == pytest.approx(1.0)
    assert ep.expire(hold.token + 1) == []  # 过期的兜底令牌
    out = ep.expire(hold.token)
    assert isinstance(out[0], Commit)


async def test_flush_commits_now():
    ep, vad, _ = make([("我想订两碗。", "zh")])
    vad.ready = [seg(0, 1200)]
    await ep.accept(silence())
    out = await ep.flush()
    assert isinstance(out[0], Commit) and out[0].reason == "flush"


async def test_flush_with_buffered_speech_is_forced():
    ep, vad, _ = make([("我想", "zh")])
    vad.ready = [seg(0, 600)]
    out = await ep.flush()
    assert isinstance(out[0], Commit) and out[0].reason == "forced"


async def test_forced_cut_segment_commits():
    ep, vad, _ = make([("这是一段很长的连续讲话然后", "zh")])
    vad.ready = [seg(0, 9900)]
    out = await ep.accept(silence())
    assert isinstance(out[0], Commit) and out[0].reason == "forced"


async def test_merge_cap():
    profile = EndpointProfile(500, 700, merge_max_s=3.0)
    ep, vad, _ = make([("我们先说第一个问题。", "zh"), ("我们先说第一个问题，然后第二个。", "zh")], profile=profile)
    vad.ready = [seg(0, 2000)]
    assert isinstance((await ep.accept(silence()))[0], Hold)
    vad.speaking = True
    await ep.accept(silence())
    vad.speaking = False
    vad.ready = [seg(2500, 1500)]
    out = await ep.accept(silence())
    assert isinstance(out[0], Commit) and out[0].reason == "merge-max"


async def test_noise_discarded():
    ep, vad, _ = make([("", None)])
    vad.ready = [seg(0, 400)]
    out = await ep.accept(silence())
    assert isinstance(out[0], Discard) and out[0].reason == "empty"
    assert not ep.open


async def test_filler_only_waits_then_discards():
    ep, vad, _ = make([("嗯。", "zh")])
    vad.ready = [seg(0, 500)]
    assert isinstance((await ep.accept(silence()))[0], Hold)
    out = await feed_silence(ep, 760)
    assert isinstance(out[0], Discard) and out[0].reason == "filler"


async def test_filler_then_sentence_merges():
    ep, vad, _ = make([("嗯。", "zh"), ("嗯，我想退货。", "zh")], prob=0.9)
    vad.ready = [seg(0, 500)]
    await ep.accept(silence())
    vad.speaking = True
    await ep.accept(silence())
    vad.speaking = False
    vad.ready = [seg(1000, 1200)]
    out = await ep.accept(silence())
    assert isinstance(out[0], Commit) and out[0].text == "嗯，我想退货。" and out[0].start_ms == 0


async def test_filler_during_hold_keeps_waiting():
    ep, vad, asr = make([("我想问一下。", "zh"), ("我想问一下，嗯……", "zh"), ("我想问一下，嗯，这个怎么退货？", "zh")])
    vad.ready = [seg(0, 1000)]
    assert isinstance((await ep.accept(silence()))[0], Hold)
    vad.speaking = True
    await ep.accept(silence())
    vad.speaking = False
    vad.ready = [seg(1600, 400)]
    out = await ep.accept(silence())
    assert isinstance(out[0], Hold)  # 只多了语气词：继续等，不调用判定
    vad.speaking = True
    await ep.accept(silence())
    vad.speaking = False
    ep._judge = TurnJudge(FakeModel(prob=0.9))
    vad.ready = [seg(2600, 1200)]
    out = await ep.accept(silence())
    assert isinstance(out[0], Commit) and out[0].text.endswith("怎么退货？")
    assert len(asr.calls) == 3


async def test_short_resume_without_segment_returns_to_hold():
    ep, vad, _ = make([("我想订两碗。", "zh")])
    vad.ready = [seg(0, 1200)]
    await ep.accept(silence())
    vad.speaking = True
    await ep.accept(silence())
    vad.speaking = False  # VAD 抖动：没有产出语音段
    out = await ep.accept(silence())
    assert isinstance(out[0], Hold) and ep.holding


async def test_zero_hold_restores_old_behavior():
    ep, vad, _ = make([("Let's move on to the.", "en")], profile=EndpointProfile(500, 0, 12.0))
    vad.ready = [seg(0, 1000)]
    out = await ep.accept(silence())
    assert isinstance(out[0], Commit) and out[0].reason == "no-hold"


async def test_asr_error_discards_with_error():
    class Boom:
        async def transcribe(self, samples, lang_hint=None):
            raise RuntimeError("down")

    ep = Endpointer(FakeVad(ready=[seg(0, 800)]), Boom(), TurnJudge(None), PROFILE)
    out = await ep.accept(silence())
    assert isinstance(out[0], Discard) and out[0].error is not None


async def test_current_audio_includes_held():
    ep, vad, _ = make([("我想订两碗。", "zh")])
    vad.ready = [seg(0, 1000)]
    await ep.accept(silence())
    vad.speaking = True
    vad.cur = seg(1500, 300)
    assert len(ep.current_audio()) == (1000 + 120 + 300) * 16
