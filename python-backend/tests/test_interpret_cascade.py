"""级联同传引擎（tasks 5.2 / 5.3）：路由、翻译上下文、并行多目标、TTS 降级与音频顺序；
同传提示词、发言流级上下文、低温度、开头标签过滤与发言流重建恢复（improve-prompts-and-context-memory 1.x / 2.1 / 5.2）。

识别部分用脚本化 ASR 直接驱动句末处理（_finalize）；VAD + 本地 SenseVoice 的真实链路见 test_interpret_ws.py。
"""

import asyncio
import base64
from collections.abc import AsyncIterator
from dataclasses import dataclass, field

import numpy as np
import pytest

from app.glossary.repository import Glossary, Term
from app.interpret.cascade import CascadeEngine
from app.interpret.engine import StreamConfig
from app.llm.base import ChatChunk, ChatRequest, LLMError, LLMErrorKind, Usage
from app.speech.endpointing import Endpointer, TurnJudge
from app.speech.vad import SpeechSegment
from tests.fakes import resolved
from tests.speech_fakes import VAD_READY, Collector, FakeASR, FakeTTS, StubRegistry, engine_deps, target_of

needs_vad = pytest.mark.skipif(not VAD_READY, reason="silero_vad.onnx 未下载")


@dataclass
class TargetLLM:
    """按提示词中的目标语言返回 "[目标]原文"；delays 可为每个目标设置首包延迟，prefix 模拟模型多输出的开头标签。"""

    delays: dict[str, float] = field(default_factory=dict)
    prefix: str = ""
    error: LLMError | None = None
    model: str = "fake-mt"
    requests: list[ChatRequest] = field(default_factory=list)

    async def chat(self, req):  # pragma: no cover - 级联只用流式
        raise NotImplementedError

    async def stream(self, req: ChatRequest) -> AsyncIterator[ChatChunk]:
        self.requests.append(req)
        if self.error is not None:
            raise self.error
        target = target_of(req.messages[0].content)
        await asyncio.sleep(self.delays.get(target, 0))
        text = f"{self.prefix}[{target}]{req.messages[-1].content}"
        for i in range(0, len(text), 4):
            yield ChatChunk(delta=text[i : i + 4], model=self.model)
        yield ChatChunk(model=self.model, usage=Usage(10, 5), latency_ms=1, done=True)

    async def close(self) -> None:
        pass


def make_engine(cfg: dict, asr: list[tuple[str, str | None]], *, tts=None, llm=None, glossaries=None, detect="en"):
    config = StreamConfig.model_validate({"type": "config", **cfg})
    out = Collector()
    llm = llm or TargetLLM()
    engine = CascadeEngine(config, out, engine_deps(StubRegistry(llm=llm), glossaries, detect_lang=detect))
    engine._asr = FakeASR(list(asr))
    engine._llm = resolved(llm)
    engine._tts = tts if config.tts else None
    engine._glossaries = glossaries or {}
    return engine, out, llm


async def say(engine: CascadeEngine, side: str | None = None, start_ms: int = 0, ms: int = 1500) -> None:
    await engine._finalize(SpeechSegment(start_ms * 16, np.zeros(ms * 16, dtype=np.float32)), side)


async def settle(engine: CascadeEngine) -> None:
    while engine._tasks:
        await asyncio.gather(*list(engine._tasks))


def by_uid(out: Collector, uid: int) -> list[dict]:
    return [e for e in out.events if e.get("utteranceId") == uid]


async def test_listen_same_language_only_transcript():
    engine, out, llm = make_engine({"mode": "LISTEN", "targetLangs": ["zh"]}, [("大家好", "zh")], tts=FakeTTS())
    await say(engine, start_ms=200, ms=1000)
    await settle(engine)
    assert out.types() == ["transcript.final", "metrics"]
    final, metrics = out.events
    assert final == {
        "type": "transcript.final",
        "utteranceId": 1,
        "text": "大家好",
        "lang": "zh",
        "startedMs": 200,
        "endedMs": 1200,
    }
    assert metrics["asrMs"] == 5 and metrics["e2eMs"] is None and metrics["mtMs"] is None
    assert llm.requests == []


async def test_listen_full_sequence_with_terms():
    glossary = Glossary(3, "AI", "zh", "en", (Term(1, 3, "大模型", "LLM"),))
    tts = FakeTTS(chunks=3, chunk_bytes=5000)
    engine, out, llm = make_engine(
        {"mode": "LISTEN", "targetLangs": ["en"], "glossaryIds": [3], "domainHint": "技术发布会"},
        [("大模型正在改变翻译行业", "zh")],
        tts=tts,
        glossaries={3: glossary},
    )
    await say(engine)
    await settle(engine)
    types = out.types()
    assert types[0] == "transcript.final" and types[-1] == "metrics"
    first_final = types.index("translation.final")
    assert set(types[1:first_final]) == {"translation.delta"}
    assert types[first_final + 1 :] == ["audio", "audio", "audio", "metrics"]  # 首包、段尾包、终止包
    deltas = "".join(e["delta"] for e in out.of("translation.delta"))
    final = out.of("translation.final")[0]
    assert deltas == final["text"] == "[en]大模型正在改变翻译行业"
    assert final["ttsFallback"] is False and final["lang"] == "en"
    audio = out.of("audio")
    assert [(a["seq"], a["seg"], a["segLast"], a["last"], len(base64.b64decode(a["data"]))) for a in audio] == [
        (0, 0, False, False, 5000),  # 首包立即发出
        (1, 0, True, False, 10000),
        (2, 1, False, True, 0),  # 终止包
    ]
    assert audio[0]["format"] == "mp3" and audio[0]["sampleRate"] == 24000
    metrics = out.of("metrics")[0]
    assert metrics["e2eMs"] is not None and metrics["mtFirstMs"] is not None and metrics["ttsFirstMs"] is not None
    req = llm.requests[0]
    system = req.messages[0].content
    assert "| 大模型 | LLM |" in system and "同声传译员" in system and "技术发布会" in system
    assert req.max_tokens == 300 and req.temperature == 0.3
    assert tts.calls == [("[en]大模型正在改变翻译行业", "en-female")]


async def test_context_keeps_recent_six_sentences():
    sentences = [(f"第{i}句话", "zh") for i in range(1, 10)]
    engine, out, llm = make_engine({"mode": "LISTEN", "targetLangs": ["en"], "tts": False}, sentences)
    for _ in sentences:
        await say(engine)
        await settle(engine)
    system = llm.requests[-1].messages[0].content
    assert "## 最近的发言" in system
    # 第 9 句只带第 3–8 句（含已回填的译文），不含自己
    assert all(f"- [中文] 第{i}句话 ｜ 英语译文：[en]第{i}句话" in system for i in range(3, 9))
    assert "第1句话" not in system and "第2句话" not in system and "第9句话" not in system
    assert system.rstrip().endswith("最后提醒：只输出用户消息中这句原话的英语译文。")
    assert all(e["ttsFallback"] is False for e in out.of("translation.final"))
    assert out.of("audio") == []


async def test_context_drops_earliest_over_char_limit():
    sentences = [("长" * 400 + str(i), "zh") for i in range(1, 6)]
    engine, _, llm = make_engine({"mode": "LISTEN", "targetLangs": ["en"], "tts": False}, sentences)
    for _ in sentences:
        await say(engine)
        await settle(engine)
    system = llm.requests[-1].messages[0].content
    # 每句原文 401 字 + 译文 405 字：1500 字符以内只能放下最近 1 句
    assert f"- [中文] {'长' * 400}4 ｜" in system and f"{'长' * 400}3" not in system


async def test_converse_answer_sees_the_question_from_other_side():
    # improve-prompts-and-context-memory D2：上下文不再按目标语言分桶，B 的回答能看到 A 的提问
    engine, _, llm = make_engine(
        {"mode": "CONVERSE", "sourceLangs": ["zh", "en"], "targetLangs": ["zh", "en"], "tts": False},
        [("这个报价包含运费吗", "zh"), ("No, that's extra", "en")],
    )
    for _ in range(2):
        await say(engine)
        await settle(engine)
    answer = llm.requests[-1]
    assert answer.messages[-1].content == "No, that's extra"
    system = answer.messages[0].content
    assert target_of(system) == "zh"
    # A 的原话就是目标语言（中文）：只显示原话、不附译文
    assert "- [中文] 这个报价包含运费吗\n" in system


async def test_temperature_falls_back_to_model_params_when_unset():
    engine, _, llm = make_engine({"mode": "LISTEN", "targetLangs": ["en"], "tts": False}, [("你好", "zh")])
    engine.deps.settings = engine.deps.settings.model_copy(update={"interpret_mt_temperature": None})
    engine._llm = resolved(llm, params={"temperature": 0.9})
    await say(engine)
    await settle(engine)
    assert llm.requests[0].temperature == 0.9


async def test_leading_label_is_stripped_from_deltas_final_and_speech():
    tts = FakeTTS(chunks=1, chunk_bytes=10)
    engine, out, _ = make_engine(
        {"mode": "LISTEN", "targetLangs": ["en"]}, [("你好", "zh")], tts=tts, llm=TargetLLM(prefix="Translation: ")
    )
    await say(engine)
    await settle(engine)
    deltas = "".join(e["delta"] for e in out.of("translation.delta"))
    assert deltas == out.of("translation.final")[0]["text"] == "[en]你好"
    assert [t for t, _ in tts.calls] == ["[en]你好"]


async def test_rebuilt_stream_restores_recent_utterances_from_config():
    # improve-prompts-and-context-memory D5：发言流重建时 config.history 进入上下文（只取 role=user 的条目）
    history = [
        {"role": "user", "lang": "zh", "text": "我妹妹刚换了工作", "translations": {"en": "My sister changed jobs."}},
        {"role": "assistant", "lang": "en", "text": "不应出现"},
    ]
    engine, _, llm = make_engine(
        {"mode": "LISTEN", "targetLangs": ["en"], "tts": False, "history": history}, [("他说新公司挺好的", "zh")]
    )
    await say(engine)
    await settle(engine)
    system = llm.requests[0].messages[0].content
    assert "- [中文] 我妹妹刚换了工作 ｜ 英语译文：My sister changed jobs." in system
    assert "不应出现" not in system


async def test_converse_auto_routing():
    engine, out, _ = make_engine(
        {"mode": "CONVERSE", "sourceLangs": ["zh", "en"], "targetLangs": ["zh", "en"], "tts": False},
        [("你好", "zh"), ("Nice to meet you", "en"), ("Hola amigos", None)],
        detect="en",
    )
    for _ in range(3):
        await say(engine)
        await settle(engine)
    finals = [(e["utteranceId"], e["lang"]) for e in out.of("transcript.final")]
    translations = [(e["utteranceId"], e["lang"]) for e in out.of("translation.final")]
    assert finals == [(1, "zh"), (2, "en"), (3, "en")]  # 第 3 句语种不在 A/B 中：lingua 在 A/B 中判定
    assert translations == [(1, "en"), (2, "zh"), (3, "zh")]


async def test_converse_ptt_side_overrides_detection():
    engine, out, _ = make_engine(
        {"mode": "CONVERSE", "sourceLangs": ["zh", "en"], "converseRouting": "ptt", "tts": False},
        [("hello", "zh")],
    )
    await say(engine, side="B")
    await settle(engine)
    assert engine._asr.calls[0][1] == "en"  # 按键一侧作为识别提示
    assert out.of("transcript.final")[0]["lang"] == "en"
    assert out.of("translation.final")[0]["lang"] == "zh"


async def test_room_parallel_targets_and_target_update():
    llm = TargetLLM(delays={"en": 0.05})
    engine, out, _ = make_engine(
        {"mode": "ROOM", "sourceLangs": ["zh"], "targetLangs": ["en", "ja", "zh"]},
        [("大家好", "zh"), ("再见", "zh")],
        tts=FakeTTS(chunks=1),
        llm=llm,
    )
    await say(engine)
    await settle(engine)
    first = by_uid(out, 1)
    assert sorted(e["lang"] for e in first if e["type"] == "translation.final") == ["en", "ja"]
    assert sorted(e["lang"] for e in first if e["type"] == "audio" and e["data"]) == ["en", "ja"]
    assert first[-1]["type"] == "metrics"  # 两个目标都结束后才发 metrics
    await engine.control({"type": "targets", "targetLangs": ["ko", "zh"]})
    await say(engine)
    await settle(engine)
    assert [e["lang"] for e in by_uid(out, 2) if e["type"] == "translation.final"] == ["ko"]


async def test_tts_failure_is_non_fatal_and_marks_fallback():
    engine, out, _ = make_engine({"mode": "LISTEN", "targetLangs": ["en"]}, [("你好", "zh")], tts=FakeTTS(fail=True))
    await say(engine)
    await settle(engine)
    errors = out.of("error")
    assert errors and errors[0]["code"] == "C0172" and errors[0]["fatal"] is False and "403" in errors[0]["message"]
    # 定稿先于合成发出；合成在出声前失败后补发一次带降级标记的同文定稿
    finals = [(e["text"], e["ttsFallback"]) for e in out.of("translation.final")]
    assert finals == [("[en]你好", False), ("[en]你好", True)]
    assert out.of("audio") == []
    assert out.of("metrics")[0]["e2eMs"] is not None
    assert not engine.fatal.is_set()


async def test_tts_unavailable_marks_fallback():
    engine, out, _ = make_engine({"mode": "LISTEN", "targetLangs": ["en"]}, [("你好", "zh")])
    assert engine._tts is None and engine._tts_wanted
    await say(engine)
    await settle(engine)
    assert out.of("translation.final")[0]["ttsFallback"] is True


async def test_llm_failure_reports_error_and_still_emits_metrics():
    llm = TargetLLM(error=LLMError(LLMErrorKind.RATE_LIMIT))
    engine, out, _ = make_engine({"mode": "LISTEN", "targetLangs": ["en"]}, [("你好", "zh")], tts=FakeTTS(), llm=llm)
    await say(engine)
    await settle(engine)
    assert out.types() == ["transcript.final", "error", "metrics"]
    assert out.of("error")[0]["code"] == "C0123" and out.of("error")[0]["fatal"] is False


@dataclass
class SlowFirstTTS(FakeTTS):
    """第一句合成慢、第二句快：用于验证 audio 仍按 utteranceId 顺序发出。"""

    async def stream(self, text: str, voice: str, rate: float = 1.0) -> AsyncIterator[bytes]:
        slow = "第一句" in text
        for i in range(2):
            await asyncio.sleep(0.08 if slow else 0.001)
            yield bytes([i]) * 100


async def test_audio_order_follows_utterance_ids():
    engine, out, _ = make_engine(
        {"mode": "LISTEN", "targetLangs": ["en"]}, [("第一句", "zh"), ("第二句", "zh")], tts=SlowFirstTTS()
    )
    await say(engine)
    await say(engine, start_ms=2000)
    await settle(engine)
    audio = [(e["utteranceId"], e["seq"], e["last"]) for e in out.of("audio")]
    assert audio == [(1, 0, False), (1, 1, False), (1, 2, True), (2, 0, False), (2, 1, False), (2, 2, True)]
    finals = [e["utteranceId"] for e in out.of("translation.final")]
    assert finals == [1, 2]  # 定稿不等合成（第一句合成慢也不推迟其定稿），音频仍按句序发出
    assert [e["utteranceId"] for e in out.of("metrics")] == [1, 2]


async def test_empty_recognition_is_skipped():
    engine, out, _ = make_engine({"mode": "LISTEN", "targetLangs": ["en"]}, [("", None), ("好", "zh")])
    await say(engine)
    await say(engine)
    await settle(engine)
    assert [e["utteranceId"] for e in out.of("transcript.final")] == [1]


@pytest.mark.parametrize("muted_first", [True, False])
async def test_mute_drops_audio(muted_first):
    engine, _, _ = make_engine({"mode": "LISTEN", "targetLangs": ["en"]}, [])
    if muted_first:
        await engine.control({"type": "mute", "muted": True})
    await engine.feed(b"\x00\x00" * 640)
    assert engine._queue.qsize() == (1 if muted_first else 1)
    if not muted_first:
        await engine.control({"type": "mute", "muted": True})
        await engine.feed(b"\x00\x00" * 640)
        assert engine._queue.qsize() == 2  # 音频帧 + 静音时的强制断句


# ---------------- 分段流水线（improve-speech-playback-latency 2.4） ----------------


@dataclass
class SlowTailLLM(TargetLLM):
    """译文分两个分句流式输出，两句之间停顿 tail_delay 秒。"""

    tail_delay: float = 0.2

    async def stream(self, req: ChatRequest) -> AsyncIterator[ChatChunk]:
        self.requests.append(req)
        yield ChatChunk(delta="If the error rate exceeds one in a thousand, ", model=self.model)
        await asyncio.sleep(self.tail_delay)
        yield ChatChunk(delta="we will roll back immediately.", model=self.model)
        yield ChatChunk(model=self.model, usage=Usage(10, 5), latency_ms=1, done=True)


async def test_long_translation_speaks_first_clause_before_translation_done():
    tts = FakeTTS(chunks=2, chunk_bytes=100)
    engine, out, _ = make_engine(
        {"mode": "LISTEN", "targetLangs": ["en"]},
        [("如果错误率超过千分之一，就立即回滚。", "zh")],
        tts=tts,
        llm=SlowTailLLM(),
    )
    await say(engine)
    await asyncio.sleep(0.1)  # 第二个分句尚未生成
    assert out.of("translation.final") == []
    first_audio = out.of("audio")
    assert first_audio and first_audio[0]["seg"] == 0  # 第一个分句已在合成并下发
    await settle(engine)
    assert [c[0] for c in tts.calls] == [
        "If the error rate exceeds one in a thousand,",
        "we will roll back immediately.",
    ]
    segs = [(e["seg"], e["segLast"]) for e in out.of("audio") if e["data"]]
    assert segs == [(0, False), (0, True), (1, False), (1, True)]


@dataclass
class SlowTTS(FakeTTS):
    first_delay: float = 0.15

    async def stream(self, text: str, voice: str, rate: float = 1.0) -> AsyncIterator[bytes]:
        await asyncio.sleep(self.first_delay)
        yield b"" * 100


async def test_translation_final_does_not_wait_for_tts():
    engine, out, _ = make_engine({"mode": "LISTEN", "targetLangs": ["en"]}, [("你好", "zh")], tts=SlowTTS())
    await say(engine)
    await asyncio.sleep(0.05)
    assert out.of("translation.final") and out.of("audio") == []  # 定稿已发出、首包尚未合成
    await settle(engine)
    assert out.of("audio") and out.of("translation.final")[0]["ttsFallback"] is False
    assert out.of("metrics")[0]["ttsFirstMs"] >= 100


# ---------------- 响应速度档位与识别让路（improve-speech-playback-latency 2.5 / 2.6） ----------------


def test_latency_mode_profiles():
    balanced, _, _ = make_engine({"mode": "LISTEN", "targetLangs": ["en"]}, [])
    fast, _, _ = make_engine({"mode": "LISTEN", "targetLangs": ["en"], "latencyMode": "fast"}, [])
    assert balanced.cfg.latency_mode == "balanced"
    assert (balanced._vad_silence_ms, balanced._seg_first_min, balanced._partial_interval) == (500, 8, 700 * 16)
    assert (fast._vad_silence_ms, fast._seg_first_min, fast._partial_interval) == (300, 4, 500 * 16)


@needs_vad
def test_fast_mode_vad_silence():
    from app.speech.vad import VadSegmenter

    assert VadSegmenter(min_silence_ms=300)._cfg.silero_vad.min_silence_duration == pytest.approx(0.3)


class _SpeakingVad:
    speaking = True

    def current(self):
        return SpeechSegment(0, np.zeros(16000, dtype=np.float32))


async def test_partial_yields_during_trailing_silence(monkeypatch):
    from app.speech.asr import AsrResult, LocalSenseVoiceASR

    engine, out, _ = make_engine({"mode": "LISTEN", "targetLangs": ["en"]}, [])
    asr = LocalSenseVoiceASR()
    calls = []

    async def fake_transcribe(samples, hint=None):
        calls.append(len(samples))
        return AsrResult(text="你好", lang="zh", duration_ms=1000, latency_ms=5, engine="local-sensevoice")

    monkeypatch.setattr(asr, "transcribe", fake_transcribe)
    engine._asr = asr
    engine._ep = Endpointer(_SpeakingVad(), asr, TurnJudge(None), engine._profile)
    frame = 640  # 40 ms
    loud = np.full(frame, 0.2, dtype=np.float32)
    quiet = np.zeros(frame, dtype=np.float32)
    for _ in range(18):  # 720 ms 说话：超过 partial 间隔，触发一次
        engine._track_level(loud)
        engine._maybe_partial(frame)
    await asyncio.sleep(0)
    assert len(calls) == 1
    await engine._partial_task
    for _ in range(18):  # 720 ms 尾部静音：期间即使达到间隔也不再发起 partial
        engine._track_level(quiet)
        engine._maybe_partial(frame)
    await asyncio.sleep(0)
    assert len(calls) == 1 and engine._trailing_quiet()
    for _ in range(3):  # 重新开口：120 ms 后不再"尾部静音"，下一次间隔照常触发
        engine._track_level(loud)
        engine._maybe_partial(frame)
    await asyncio.sleep(0)
    assert len(calls) == 2


# ---------------- 两段式断句接入（improve-speech-endpointing-and-live-ux 2.1） ----------------


def with_endpointer(engine: CascadeEngine, prob: float = 0.2):
    """用假 VAD + 假判定模型的 Endpointer 替换真实断句（ASR 沿用 make_engine 的脚本化识别）。"""
    from tests.test_endpointing import FakeModel, FakeVad

    vad = FakeVad()
    engine._ep = Endpointer(vad, engine._asr, TurnJudge(FakeModel(prob=prob)), engine._profile)
    return vad


def frame(ms: int = 40) -> np.ndarray:
    return np.zeros(ms * 16, dtype=np.float32)


async def test_pause_merged_translated_once():
    from tests.test_endpointing import seg

    engine, out, llm = make_engine(
        {"mode": "LISTEN", "targetLangs": ["en"]},
        [("大家好，今天我们讨论新版本的。", "zh"), ("大家好，今天我们讨论新版本的发布计划。", "zh")],
    )
    vad = with_endpointer(engine, prob=0.5)  # "的" 结尾：模型须 ≥ 0.99 才算说完
    vad.ready = [seg(0, 2000)]
    await engine._apply(await engine._ep.accept(frame()), None)
    hold = out.of("transcript.partial")
    assert hold and hold[-1]["hold"] is True and hold[-1]["utteranceId"] == 1
    vad.speaking = True
    await engine._apply(await engine._ep.accept(frame()), None)
    vad.speaking = False
    vad.ready = [seg(2900, 900)]
    await engine._apply(await engine._ep.accept(frame()), None)
    await settle(engine)
    finals = out.of("transcript.final")
    assert len(finals) == 1
    assert finals[0]["utteranceId"] == 1 and finals[0]["text"].endswith("发布计划。")
    assert (finals[0]["startedMs"], finals[0]["endedMs"]) == (0, 3800)
    assert len(llm.requests) == 1  # 只翻译一次（完整的一句）
    metrics = out.of("metrics")[0]
    assert metrics["holdMs"] >= 0
    assert "transcript.discard" not in out.types()


async def test_filler_only_discarded_after_partial():
    from tests.test_endpointing import seg

    engine, out, llm = make_engine({"mode": "LISTEN", "targetLangs": ["en"]}, [("嗯……", "zh")])
    vad = with_endpointer(engine)
    vad.ready = [seg(0, 600)]
    await engine._apply(await engine._ep.accept(frame()), None)
    assert out.of("transcript.partial")[-1]["hold"] is True
    for _ in range(20):  # 800 ms 静音：超过 700 ms 续说等待
        await engine._apply(await engine._ep.accept(frame()), None)
    await settle(engine)
    assert out.types()[-1] == "transcript.discard"
    assert out.of("transcript.discard")[0]["utteranceId"] == 1
    assert out.of("transcript.final") == [] and llm.requests == []
    assert list(engine._recent) == []  # 被丢弃的语句不进入上下文


async def test_hold_expire_backstop_via_queue():
    from tests.test_endpointing import seg

    engine, out, _ = make_engine({"mode": "LISTEN", "targetLangs": ["zh"]}, [("我想订两碗。", "zh")])
    engine._profile = type(engine._profile)(500, 50, 12.0)  # 等待 50 ms，兜底 350 ms
    vad = with_endpointer(engine)
    engine._ep.profile = engine._profile
    vad.ready = [seg(0, 1200)]
    engine._worker = asyncio.create_task(engine._run())
    await engine.feed(b"\0" * 1280)
    await asyncio.sleep(0.5)  # 之后没有音频帧（如门控）：由墙钟兜底定稿，不必等 finish 的 flush
    assert [e["text"] for e in out.of("transcript.final")] == ["我想订两碗。"]
    await engine.finish()
    assert len(out.of("transcript.final")) == 1
