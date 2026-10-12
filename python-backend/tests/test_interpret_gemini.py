"""Gemini 3.5 Live Translate 引擎（tasks 12.2）：模拟服务按官方文档的消息结构回放。

消息结构取自 Live Translate 文档与 Live API 参考：setup → setupComplete；realtimeInput.audio；
serverContent.inputTranscription{text, languageCode} / outputTranscription{text, languageCode} /
modelTurn.parts[].inlineData{data, mimeType: audio/pcm;rate=24000} / turnComplete；配置非法时以关闭帧拒绝。
"""

import asyncio
import base64
import json

import pytest

from app.interpret.engine import EngineError
from app.interpret.gemini_live_translate import (
    DEFAULT_URL,
    GeminiLiveTranslateEngine,
    build_setup,
    live_url,
    platform_code,
    probe,
)
from app.interpret.s2s import SILENCE_FLUSH
from tests.s2s_fakes import (
    MockUpstream,
    assert_audio_sequence,
    audio_chunks,
    fast_timers,
    make_s2s_engine,
    s2s_config,
    wait_for,
)
from tests.speech_fakes import model_config

MODEL = "gemini-3.5-live-translate-preview"
WS_PATH = "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
FRAME = b"\x01\x00" * 640


def content(**fields) -> bytes:
    return json.dumps({"serverContent": fields}, ensure_ascii=False).encode()  # 服务端以二进制帧发送 JSON


def src(text: str) -> bytes:
    return content(inputTranscription={"text": text, "languageCode": "zh-Hans"})


def out(text: str) -> bytes:
    return content(outputTranscription={"text": text, "languageCode": "en"})


def audio(n: int) -> bytes:
    data = base64.b64encode(bytes([n]) * 960).decode()
    return content(modelTurn={"parts": [{"inlineData": {"data": data, "mimeType": "audio/pcm;rate=24000"}}]})


TURN = content(turnComplete=True)
SETUP_COMPLETE = json.dumps({"setupComplete": {}}).encode()

# 第 1 句以 turnComplete 为界；第 2 句原文由输入静默定稿、译文出现句末标点即定稿，随后 turnComplete
SCRIPT = [
    (0.0, src("大家好")),
    (0.02, out("Hello")),
    (0.0, audio(1)),
    (0.02, out(" everyone.")),
    (0.0, audio(2)),
    (0.02, TURN),
    (0.02, src("今天讨论大模型")),
    (0.4, out("Today we discuss LLMs.")),
    (0.0, audio(3)),
    (0.02, audio(4)),
    (0.02, TURN),
]


def mock(**kw) -> MockUpstream:
    kw.setdefault("ready", [SETUP_COMPLETE])
    return MockUpstream(
        decode=json.loads,
        is_audio=lambda m: "audio" in (m.get("realtimeInput") or {}),
        is_finish=lambda m: bool((m.get("realtimeInput") or {}).get("audioStreamEnd")),
        **kw,
    )


def cfg_of(m: MockUpstream):
    return s2s_config("GOOGLE", f"ws://127.0.0.1:{m.port}{WS_PATH}", MODEL)


def engine_of(m: MockUpstream, cfg: dict, **kw):
    return make_s2s_engine(GeminiLiveTranslateEngine, cfg_of(m), cfg, key="AIza-test", **kw)


def sent_audio(messages) -> list[dict]:
    return [m["realtimeInput"]["audio"] for m in messages if "audio" in (m.get("realtimeInput") or {})]


@pytest.fixture(autouse=True)
def _fast(monkeypatch):
    fast_timers(monkeypatch)


# ---------------- 地址与 setup ----------------


def test_live_url_and_setup():
    cfg = model_config(base_url="", model_name=MODEL)
    assert live_url(cfg, "k/1") == f"{DEFAULT_URL}?key=k%2F1"
    rest = model_config(base_url="https://generativelanguage.googleapis.com/v1beta", model_name=MODEL)
    assert live_url(rest, "k") == f"{DEFAULT_URL}?key=k"  # 只给 REST 地址时补 WS 路径
    assert build_setup(MODEL, "zh") == {
        "setup": {
            "model": f"models/{MODEL}",
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "translationConfig": {"targetLanguageCode": "zh-Hans", "echoTargetLanguage": False},
            },
            "inputAudioTranscription": {},
            "outputAudioTranscription": {},
        }
    }
    assert (
        build_setup(f"models/{MODEL}", "pt")["setup"]["generationConfig"]["translationConfig"]["targetLanguageCode"]
        == "pt-BR"
    )
    assert [platform_code(c) for c in ("zh-Hans", "zh-Hant", "pt-BR", "en", "hi", None)] == [
        "zh",
        "zh",
        "pt",
        "en",
        None,
        None,
    ]


# ---------------- 回放 ----------------


async def test_replay_listen_turns_and_silence():
    m = mock(script=SCRIPT)
    async with m.running():
        # lingua 判定为 en，但厂商报告的 languageCode=zh-Hans 优先
        engine, events = engine_of(m, {"mode": "LISTEN", "targetLangs": ["en"]}, detect_lang="en")
        await engine.start()
        assert events.types() == ["ready"]
        for _ in range(10):
            await engine.feed(FRAME)
        await wait_for(lambda: len(events.of("metrics")) == 2)
        await engine.finish()
        await engine.close()

    conn = m.connections[0]
    assert conn["path"] == f"{WS_PATH}?key=AIza-test"
    assert conn["messages"][0] == build_setup(MODEL, "en")
    chunks = sent_audio(conn["messages"])
    assert {c["mimeType"] for c in chunks} == {"audio/pcm;rate=16000"}
    assert sum(len(base64.b64decode(c["data"])) for c in chunks) == len(FRAME) * 10  # 16 kHz 直接上行
    assert conn["messages"][-1] == {"realtimeInput": {"audioStreamEnd": True}}

    finals = [(e["utteranceId"], e["text"], e["lang"]) for e in events.of("transcript.final")]
    assert finals == [(1, "大家好", "zh"), (2, "今天讨论大模型", "zh")]
    translations = [(e["utteranceId"], e["lang"], e["text"]) for e in events.of("translation.final")]
    assert translations == [(1, "en", "Hello everyone."), (2, "en", "Today we discuss LLMs.")]
    assert "".join(e["delta"] for e in events.of("translation.delta") if e["utteranceId"] == 1) == "Hello everyone."
    assert_audio_sequence(events.events, [1, 2], 24000)
    assert [len(audio_chunks(events.events, u)) for u in (1, 2)] == [2, 2]
    metrics = events.of("metrics")
    assert [x["utteranceId"] for x in metrics] == [1, 2]
    assert metrics[1]["e2eMs"] is not None and metrics[1]["mtMs"] is not None
    assert not events.of("error")


async def test_room_multi_target_language_codes():
    m = mock(script=SCRIPT)
    async with m.running():
        engine, events = engine_of(m, {"mode": "ROOM", "sourceLangs": ["en"], "targetLangs": ["zh", "pt", "en"]})
        await engine.start()
        await engine.feed(FRAME * 3)
        await wait_for(lambda: len(events.of("metrics")) == 2)
        await engine.finish()
    codes = sorted(
        c["messages"][0]["setup"]["generationConfig"]["translationConfig"]["targetLanguageCode"] for c in m.connections
    )
    assert codes == ["pt-BR", "zh-Hans"]
    assert [e["utteranceId"] for e in events.of("transcript.final")] == [1, 2]
    assert {e["lang"] for e in events.of("transcript.final")} == {"en"}  # 会议室以声明的发言语言为准
    pairs = sorted((e["utteranceId"], e["lang"]) for e in events.of("translation.final"))
    assert pairs == [(1, "pt"), (1, "zh"), (2, "pt"), (2, "zh")]


async def test_converse_ptt_routes_audio():
    m = mock()
    async with m.running():
        engine, _ = engine_of(m, {"mode": "CONVERSE", "sourceLangs": ["ja", "en"], "converseRouting": "ptt"})
        await engine.start()
        await engine.control({"type": "ptt", "side": "B"})  # B=en → 目标 ja 的会话
        await engine.feed(FRAME * 3)
        await engine.control({"type": "ptt", "side": None})
        await engine.finish()
    by_target = {
        c["messages"][0]["setup"]["generationConfig"]["translationConfig"]["targetLanguageCode"]: c
        for c in m.connections
    }
    assert set(by_target) == {"ja", "en"}
    assert sent_audio(by_target["en"]["messages"]) == []
    total = sum(len(base64.b64decode(c["data"])) for c in sent_audio(by_target["ja"]["messages"]))
    assert total == len(FRAME) * 3 + len(SILENCE_FLUSH)


async def test_setup_rejected_by_close_frame_is_not_retried():
    m = mock(reject_setup=(1007, "Request contains an invalid argument."))
    async with m.running():
        engine, _ = engine_of(m, {"mode": "LISTEN", "targetLangs": ["en"]})
        with pytest.raises(EngineError) as ei:
            await engine.start()
        assert ei.value.error.code == "C0174" and "1007" in ei.value.message and "invalid argument" in ei.value.message
        assert len(m.connections) == 1
        with pytest.raises(EngineError):
            await probe(cfg_of(m), "k")


async def test_upstream_drop_reconnects_once_then_fatal():
    m = mock(drop={1, 2})
    async with m.running():
        engine, events = engine_of(m, {"mode": "LISTEN", "targetLangs": ["en"]})
        await engine.start()
        await asyncio.wait_for(engine.fatal.wait(), 5)
        await engine.close()
    assert [(e["code"], e["fatal"]) for e in events.of("error")] == [("C0174", False), ("C0174", True)]
    assert len(m.connections) == 2


async def test_probe_ok_and_missing_config():
    m = mock()
    async with m.running():
        assert await probe(cfg_of(m), "AIza-probe") == "会话已建立"
    assert m.connections[0]["path"].endswith("?key=AIza-probe")
    assert "setup" in m.messages()[0]

    engine, _ = make_s2s_engine(GeminiLiveTranslateEngine, None, {"mode": "LISTEN", "targetLangs": ["th"]})
    with pytest.raises(EngineError) as ei:
        await engine.start()
    assert ei.value.error.code == "C0173"  # 平台 15 语种都支持，缺的是配置
