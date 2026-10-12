"""OpenAI gpt-realtime-translate 引擎（tasks 12.1）：模拟服务按官方事件序列回放。

事件字段取自官方 translation server events 参考的示例（session.created / session.updated /
session.input_transcript.delta / session.output_transcript.delta /
session.output_audio.delta{delta, sample_rate, channels, format, elapsed_ms} /
session.closed / error）。
"""

import asyncio
import base64
import json

import pytest

from app.interpret import openai_realtime as oai
from app.interpret.engine import EngineError
from app.interpret.openai_realtime import OpenAIRealtimeTranslateEngine, build_session, probe, realtime_url
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

MODEL = "gpt-realtime-translate"
FRAME = b"\x01\x00" * 640  # 40 ms PCM16 16 kHz


def ev(type_: str, **fields) -> str:
    return json.dumps({"event_id": f"event_{type_}", "type": type_, **fields}, ensure_ascii=False)


def created(lang: str = "fr") -> str:
    session = {
        "id": "sess_123",
        "type": "translation",
        "model": MODEL,
        "expires_at": 1714857600,
        "audio": {
            "input": {"transcription": {"model": "gpt-realtime-whisper"}, "noise_reduction": {"type": "near_field"}},
            "output": {"language": lang},
        },
    }
    return ev("session.created", session=session)


def updated() -> str:
    return created().replace("session.created", "session.updated")


def src(text: str, ms: int) -> str:
    return ev("session.input_transcript.delta", delta=text, elapsed_ms=ms)


def out(text: str, ms: int) -> str:
    return ev("session.output_transcript.delta", delta=text, elapsed_ms=ms)


def audio(n: int, ms: int) -> str:
    data = base64.b64encode(bytes([n]) * 960).decode()
    return ev("session.output_audio.delta", delta=data, sample_rate=24000, channels=1, format="pcm16", elapsed_ms=ms)


# 三句话：第 1 句以句末标点切分、译音按 elapsed_ms 归属；第 2 句由输入静默切分、译文由输出静默定稿；
# 第 3 句的句号在 session.close 之后才冲刷出来
SCRIPT = [
    (0.0, src("大家", 400)),
    (0.02, src("好。", 800)),
    (0.02, out("Hello", 1000)),
    (0.0, audio(1, 1000)),
    (0.02, out(" everyone.", 1200)),
    (0.0, audio(2, 1200)),
    (0.02, src("今天我们讨论大模型", 1400)),
    (0.0, audio(3, 1400)),  # 越过第 1 句译文定稿帧 → 第 1 句译音结束，本包归第 2 句
    (0.02, out("Today we discuss large models", 1600)),
    (0.0, audio(4, 1600)),
    (0.6, src("这个方案下周上线", 2600)),  # 停顿超过输入 / 输出静默阈值：第 2 句定稿并结束
    (0.02, out("This plan launches next week.", 2800)),
    (0.0, audio(5, 2800)),
]
ON_FINISH = [src("。", 3000), audio(6, 3000), ev("session.closed")]


def is_audio(msg) -> bool:
    return msg.get("type") == "session.input_audio_buffer.append"


def mock(**kw) -> MockUpstream:
    kw.setdefault("ready", [created(), updated()])
    kw.setdefault("on_finish", [ev("session.closed")])
    kw.setdefault("close_after_finish", True)
    return MockUpstream(
        decode=json.loads, is_audio=is_audio, is_finish=lambda m: m.get("type") == "session.close", **kw
    )


def cfg_of(m: MockUpstream, **extra):
    return s2s_config("OPENAI_COMPATIBLE", f"http://127.0.0.1:{m.port}/v1", MODEL, **extra)


def engine_of(m: MockUpstream, cfg: dict, **kw):
    return make_s2s_engine(OpenAIRealtimeTranslateEngine, cfg_of(m), cfg, key="sk-openai-test", **kw)


def appended_bytes(messages) -> int:
    return sum(len(base64.b64decode(m["audio"])) for m in messages if is_audio(m))


@pytest.fixture(autouse=True)
def _fast(monkeypatch):
    fast_timers(monkeypatch)


# ---------------- 地址与会话参数 ----------------


def test_realtime_url_from_base_url():
    def url(base: str) -> str:
        return realtime_url(model_config(base_url=base, model_name=MODEL))

    assert url("https://api.openai.com/v1") == f"wss://api.openai.com/v1/realtime/translations?model={MODEL}"
    assert url("https://api.openai.com/v1/") == f"wss://api.openai.com/v1/realtime/translations?model={MODEL}"
    assert url("https://api.openai.com") == f"wss://api.openai.com/v1/realtime/translations?model={MODEL}"
    assert url("https://proxy.test/openai/v1") == f"wss://proxy.test/openai/v1/realtime/translations?model={MODEL}"
    assert url("wss://x.test/v1/realtime/translations") == f"wss://x.test/v1/realtime/translations?model={MODEL}"
    assert url("").startswith("wss://api.openai.com/v1/realtime/translations?model=")


def test_build_session():
    assert build_session("es") == {
        "audio": {
            "input": {"transcription": {"model": "gpt-realtime-whisper"}, "noise_reduction": {"type": "near_field"}},
            "output": {"language": "es"},
        }
    }
    assert build_session("en", "zh", "whisper-x")["audio"]["input"]["transcription"] == {
        "model": "whisper-x",
        "language": "zh",
    }
    assert oai.transcription_model_of(model_config(params={"extra": {"transcriptionModel": "m2"}})) == "m2"


# ---------------- 回放 ----------------


async def test_replay_listen_segments_and_maps_events():
    m = mock(script=SCRIPT, on_finish=ON_FINISH)
    async with m.running():
        engine, events = engine_of(m, {"mode": "LISTEN", "targetLangs": ["en"]})
        await engine.start()
        assert events.types() == ["ready"]
        for _ in range(10):
            await engine.feed(FRAME)
        await wait_for(lambda: len(events.of("metrics")) == 2)
        await asyncio.sleep(0.1)
        await engine.finish()
        await engine.close()

    conn = m.connections[0]
    assert conn["path"] == f"/v1/realtime/translations?model={MODEL}"
    assert conn["headers"]["Authorization"] == "Bearer sk-openai-test"
    update = conn["messages"][0]
    assert update == {"type": "session.update", "session": build_session("en")}
    # 16 kHz → 24 kHz 重采样：上行字节数为输入的 1.5 倍
    assert appended_bytes(conn["messages"]) == len(FRAME) * 10 * 3 // 2
    assert conn["messages"][-1] == {"type": "session.close"}

    finals = [(e["utteranceId"], e["text"], e["lang"]) for e in events.of("transcript.final")]
    assert finals == [(1, "大家好。", "zh"), (2, "今天我们讨论大模型", "zh"), (3, "这个方案下周上线。", "zh")]
    assert [e["text"] for e in events.of("transcript.partial") if e["utteranceId"] == 1] == ["大家", "大家好。"]
    assert events.of("transcript.final")[0]["startedMs"] == 400 and events.of("transcript.final")[0]["endedMs"] == 800
    translations = [(e["utteranceId"], e["lang"], e["text"]) for e in events.of("translation.final")]
    assert translations == [
        (1, "en", "Hello everyone."),
        (2, "en", "Today we discuss large models"),
        (3, "en", "This plan launches next week."),
    ]
    for uid, _, text in translations:
        assert "".join(e["delta"] for e in events.of("translation.delta") if e["utteranceId"] == uid) == text
    assert_audio_sequence(events.events, [1, 2, 3], 24000)
    # 按 elapsed_ms 归属：1000/1200 → 第 1 句，1400/1600 → 第 2 句，2800/3000 → 第 3 句
    assert [base64.b64decode(a["data"])[0] for a in audio_chunks(events.events, 1)] == [1, 2]
    assert [base64.b64decode(a["data"])[0] for a in audio_chunks(events.events, 2)] == [3, 4]
    assert [base64.b64decode(a["data"])[0] for a in audio_chunks(events.events, 3)] == [5, 6]
    metrics = events.of("metrics")
    assert [x["utteranceId"] for x in metrics] == [1, 2, 3]
    assert all(x["e2eMs"] is not None and x["mtMs"] is not None and x["asrMs"] is None for x in metrics)
    types = [e["type"] for e in events.events if e.get("utteranceId") == 2]
    assert types.index("transcript.final") < types.index("translation.final") < types.index("metrics")
    assert not events.of("error")


async def test_room_aligns_sessions_by_utterance():
    m = mock(script=SCRIPT, on_finish=ON_FINISH)
    async with m.running():
        engine, events = engine_of(m, {"mode": "ROOM", "sourceLangs": ["zh"], "targetLangs": ["en", "ja", "zh"]})
        await engine.start()
        for _ in range(5):
            await engine.feed(FRAME)
        await wait_for(lambda: len(events.of("translation.final")) == 4)
        await engine.finish()
    assert len(m.connections) == 2
    langs = sorted(c["messages"][0]["session"]["audio"]["output"]["language"] for c in m.connections)
    assert langs == ["en", "ja"]  # 每个目标一个会话，去掉发言人自己的语言
    # 声明了发言语言：作为输入转写的语种提示
    assert {c["messages"][0]["session"]["audio"]["input"]["transcription"]["language"] for c in m.connections} == {"zh"}
    assert [e["utteranceId"] for e in events.of("transcript.final")] == [1, 2, 3]  # 原文只发一次
    pairs = sorted((e["utteranceId"], e["lang"]) for e in events.of("translation.final"))
    assert pairs == [(u, lang) for u in (1, 2, 3) for lang in ("en", "ja")]
    assert [x["utteranceId"] for x in events.of("metrics")] == [1, 2, 3]  # 指标只由主会话发出


async def test_single_member_room_forwards_source_only():
    m = mock(script=SCRIPT, on_finish=ON_FINISH)
    async with m.running():
        engine, events = engine_of(m, {"mode": "ROOM", "sourceLangs": ["zh"], "targetLangs": ["zh"]})
        await engine.start()
        await engine.feed(FRAME * 3)
        await wait_for(lambda: len(events.of("metrics")) == 2)
        await engine.finish()
    assert m.messages()[0]["session"]["audio"]["output"]["language"] == "en"  # 占位目标
    assert [e["text"] for e in events.of("transcript.final")] == [
        "大家好。",
        "今天我们讨论大模型",
        "这个方案下周上线。",
    ]
    assert not events.of("translation.delta", "translation.final", "audio")
    assert len(events.of("metrics")) == 3


async def test_converse_requires_ptt_and_routes_by_side():
    m = mock()
    async with m.running():
        engine, _ = engine_of(m, {"mode": "CONVERSE", "sourceLangs": ["zh", "en"], "converseRouting": "auto"})
        with pytest.raises(EngineError) as ei:
            await engine.start()
        assert ei.value.error.code == "A0410" and "按键" in ei.value.message

        engine, _ = engine_of(m, {"mode": "CONVERSE", "sourceLangs": ["zh", "en"], "converseRouting": "ptt"})
        await engine.start()
        await engine.feed(FRAME * 3)  # 未按键：不送音频
        await engine.control({"type": "ptt", "side": "A"})  # A=zh → 目标 en 的会话
        await engine.feed(FRAME * 3)
        await engine.control({"type": "ptt", "side": None})  # 松开：补静音促使断句
        await engine.finish()
    by_target = {c["messages"][0]["session"]["audio"]["output"]["language"]: c for c in m.connections}
    assert set(by_target) == {"zh", "en"}
    assert appended_bytes(by_target["zh"]["messages"]) == 0
    assert appended_bytes(by_target["en"]["messages"]) == (len(FRAME) * 3 + len(oai_silence())) * 3 // 2
    # 双向对话：源语种为另一侧语言
    assert by_target["en"]["messages"][0]["session"]["audio"]["input"]["transcription"]["language"] == "zh"


def oai_silence() -> bytes:
    from app.interpret.s2s import SILENCE_FLUSH

    return SILENCE_FLUSH


async def test_unsupported_target_and_missing_config():
    engine, _ = make_s2s_engine(OpenAIRealtimeTranslateEngine, None, {"mode": "LISTEN", "targetLangs": ["ar"]})
    with pytest.raises(EngineError) as ei:
        await engine.start()
    assert ei.value.error.code == "A0410" and "ar" in ei.value.message

    engine, _ = make_s2s_engine(OpenAIRealtimeTranslateEngine, None, {"mode": "LISTEN", "targetLangs": ["en"]})
    with pytest.raises(EngineError) as ei:
        await engine.start()
    assert ei.value.error.code == "C0173"

    dashscope = s2s_config("DASHSCOPE", "wss://x.test", "qwen3.8-livetranslate-flash-realtime")
    engine, _ = make_s2s_engine(OpenAIRealtimeTranslateEngine, dashscope, {"mode": "LISTEN", "targetLangs": ["en"]})
    with pytest.raises(EngineError) as ei:
        await engine.start()
    assert ei.value.error.code == "C0173" and "OPENAI_COMPATIBLE" in ei.value.message


# ---------------- 断线与错误 ----------------


async def test_upstream_drop_reconnects_once_then_fatal():
    m = mock(drop={1, 2})
    async with m.running():
        engine, events = engine_of(m, {"mode": "LISTEN", "targetLangs": ["en"]})
        await engine.start()
        await asyncio.wait_for(engine.fatal.wait(), 5)
        await engine.close()
    assert [(e["code"], e["fatal"]) for e in events.of("error")] == [("C0174", False), ("C0174", True)]
    assert len(m.connections) == 2


async def test_upstream_drop_recovers_and_flushes_open_utterance():
    m = mock(drop={1}, ready=[created(), updated(), src("你好", 100)])
    async with m.running():
        engine, events = engine_of(m, {"mode": "LISTEN", "targetLangs": ["en"]})
        await engine.start()
        await wait_for(lambda: len(m.connections) == 2)
        await asyncio.sleep(0.05)
        await engine.feed(FRAME * 3)
        await engine.finish()
    assert [(e["code"], e["fatal"]) for e in events.of("error")] == [("C0174", False)]
    assert not engine.fatal.is_set()
    assert appended_bytes(m.messages(1)) > 0
    # 断开前未定稿的原文在重建时收尾；新连接上的原文另起一句
    assert [(e["utteranceId"], e["text"]) for e in events.of("transcript.final")] == [(1, "你好"), (2, "你好")]


async def test_connect_retries_network_errors(monkeypatch):
    from app.interpret import s2s

    m = mock()
    attempts = []
    real_connect = s2s.connect

    def flaky(*args, **kwargs):
        attempts.append(1)
        if len(attempts) <= 2:
            raise ConnectionResetError("[WinError 64] 指定的网络名不再可用。")
        return real_connect(*args, **kwargs)

    monkeypatch.setattr(s2s, "connect", flaky)
    async with m.running():
        engine, events = engine_of(m, {"mode": "LISTEN", "targetLangs": ["en"]})
        await engine.start()
        assert len(attempts) == 3 and events.types() == ["ready"]
        await engine.finish()

        monkeypatch.setattr(s2s, "connect", lambda *a, **k: (_ for _ in ()).throw(OSError("reset")))
        engine, _ = engine_of(m, {"mode": "LISTEN", "targetLangs": ["en"]})
        with pytest.raises(EngineError) as ei:
            await engine.start()
        assert ei.value.error.code == "C0174"


async def test_session_error_event_is_not_retried():
    m = mock(reject_setup=ev("error", error={"type": "invalid_request_error", "message": "Unsupported language: xx"}))
    async with m.running():
        engine, _ = engine_of(m, {"mode": "LISTEN", "targetLangs": ["en"]})
        with pytest.raises(EngineError) as ei:
            await engine.start()
        assert ei.value.error.code == "C0174" and "Unsupported language" in ei.value.message
        assert len(m.connections) == 1
        with pytest.raises(EngineError) as ei:
            await probe(cfg_of(m), "sk")
        assert ei.value.error.code == "C0174"


async def test_probe_ok_and_http_auth_failure():
    m = mock()
    async with m.running():
        assert await probe(cfg_of(m), "sk-probe") == "会话已建立"
    assert m.connections[0]["headers"]["Authorization"] == "Bearer sk-probe"
    assert m.messages()[0]["session"]["audio"]["output"]["language"] == "en"

    m = mock(http_status=401)
    async with m.running():
        with pytest.raises(EngineError) as ei:
            await probe(cfg_of(m), "sk-bad")
        assert ei.value.error.code == "C0121" and "401" in ei.value.message
        assert len(m.connections) == 1  # 鉴权失败不重试
