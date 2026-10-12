"""豆包同声传译 2.0 引擎（tasks 12.3）：官方 proto 编解码往返 + 模拟服务按文档的事件序列回放。

事件序列取自《同声传译2.0-API接入文档》：StartSession(100) → SessionStarted(150)；TaskRequest(200) 音频；
SourceSubtitleStart/Response/End(650/651/652)、TranslationSubtitleStart/Response/End(653/654/655)、
TTSSentenceStart/TTSResponse/TTSSentenceEnd(350/352/351)、UsageResponse(154)、AudioMuted(250)；
FinishSession(102) → SessionFinished(152)；失败 SessionFailed(153)。
"""

import asyncio

import pytest

from app.glossary.repository import Glossary, Term
from app.interpret import doubao_ast as dba
from app.interpret.doubao_ast import DoubaoAstEngine, finish_request, headers_of, probe, start_request, task_request
from app.interpret.engine import EngineError
from app.interpret.s2s import SILENCE_FLUSH
from app.interpret.vendor.doubao_pb.common.events_pb2 import Type
from app.interpret.vendor.doubao_pb.products.understanding.ast.ast_service_pb2 import (
    TranslateRequest,
    TranslateResponse,
)
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

FRAME = b"\x01\x00" * 640
GLOSSARY = Glossary(3, "AI", "zh", "en", (Term(1, 3, "大模型", "LLM"),))


def resp(
    event: int,
    text: str = "",
    data: bytes = b"",
    start: int = 0,
    end: int = 0,
    status: int = 20000000,
    message: str = "",
) -> bytes:
    r = TranslateResponse(event=event, text=text, data=data, start_time=start, end_time=end)
    r.response_meta.SessionID = "srv"
    r.response_meta.StatusCode = status
    r.response_meta.Message = message
    return r.SerializeToString()


def tts(n: int) -> bytes:
    return resp(Type.TTSResponse, data=bytes([n]) * 640)


STARTED = resp(Type.SessionStarted)
FINISHED = resp(Type.SessionFinished)

# 两句话；第 1 句的译文与译音在第 2 句原文开始之后才结束（同声），按第 k 句对齐
SCRIPT = [
    (0.0, resp(Type.SourceSubtitleStart, start=120)),
    (0.01, resp(Type.SourceSubtitleResponse, text="大家")),
    (0.01, resp(Type.SourceSubtitleResponse, text="好")),
    (0.01, resp(Type.SourceSubtitleEnd, text="大家好。", start=120, end=980)),
    (0.01, resp(Type.TranslationSubtitleStart, start=120)),
    (0.01, resp(Type.TranslationSubtitleResponse, text="Hello")),
    (0.01, resp(Type.SourceSubtitleStart, start=1500)),
    (0.01, resp(Type.SourceSubtitleResponse, text="我们讨论大模型")),
    (0.01, resp(Type.TranslationSubtitleResponse, text=" everyone.")),
    (0.01, resp(Type.TranslationSubtitleEnd, text="Hello everyone.", start=120, end=980)),
    (0.01, resp(Type.TTSSentenceStart, start=120)),
    (0.0, tts(1)),
    (0.0, tts(2)),
    (0.01, resp(Type.TTSSentenceEnd, start=120, end=980)),
    (0.01, resp(Type.SourceSubtitleEnd, text="我们讨论大模型。", start=1500, end=2900)),
    (0.01, resp(Type.TranslationSubtitleStart, start=1500)),
    (0.01, resp(Type.TranslationSubtitleResponse, text="We discuss LLM.")),
    (0.01, resp(Type.TranslationSubtitleEnd, text="We discuss LLM.", start=1500, end=2900)),
    (0.01, resp(Type.AudioMuted)),
    (0.01, resp(Type.TTSSentenceStart, start=1500)),
    (0.0, tts(3)),
    (0.01, resp(Type.TTSSentenceEnd, data=bytes([4]) * 320, start=1500, end=2900)),
]
ON_FINISH = [resp(Type.UsageResponse), FINISHED]


def mock(**kw) -> MockUpstream:
    kw.setdefault("ready", [STARTED])
    kw.setdefault("on_finish", [FINISHED])
    kw.setdefault("close_after_finish", True)
    return MockUpstream(
        decode=TranslateRequest.FromString,
        is_audio=lambda m: m.event == Type.TaskRequest,
        is_finish=lambda m: m.event == Type.FinishSession,
        **kw,
    )


def cfg_of(m: MockUpstream, **extra):
    return s2s_config("VOLCENGINE", f"ws://127.0.0.1:{m.port}/api/v4/ast/v2/translate", "doubao-ast-2.0", **extra)


def engine_of(m: MockUpstream, cfg: dict, extra: dict | None = None, **kw):
    return make_s2s_engine(DoubaoAstEngine, cfg_of(m, **(extra or {})), cfg, key="volc-access-token", **kw)


def sent_audio(messages) -> int:
    return sum(len(m.source_audio.binary_data) for m in messages if m.event == Type.TaskRequest)


@pytest.fixture(autouse=True)
def _fast(monkeypatch):
    fast_timers(monkeypatch)


# ---------------- protobuf 编解码 ----------------


def test_protobuf_round_trip():
    start = TranslateRequest.FromString(start_request("sid-1", "zh", "en", {"大模型": "LLM"}))
    assert start.event == Type.StartSession == 100
    assert start.request_meta.SessionID == "sid-1"
    assert (start.request.mode, start.request.source_language, start.request.target_language) == ("s2s", "zh", "en")
    sa = start.source_audio
    assert (sa.format, sa.codec, sa.rate, sa.bits, sa.channel) == ("wav", "raw", 16000, 16, 1)
    assert (start.target_audio.format, start.target_audio.rate) == ("pcm", 16000)  # 避开 24 kHz float32
    assert dict(start.request.corpus.glossary_list) == {"大模型": "LLM"}

    task = TranslateRequest.FromString(task_request("sid-1", b"\x01\x02"))
    assert task.event == Type.TaskRequest == 200 and task.source_audio.binary_data == b"\x01\x02"
    finish = TranslateRequest.FromString(finish_request("sid-1"))
    assert finish.event == Type.FinishSession == 102 and finish.request_meta.SessionID == "sid-1"

    parsed = dba.parse_response(resp(Type.TTSResponse, data=b"\x00\x01", text="x"))
    assert parsed.event == Type.TTSResponse == 352 and parsed.data == b"\x00\x01"
    assert dba.parse_response("not-bytes") is None and dba.parse_response(b"\xff\xff\xff") is None
    failed = dba.parse_response(resp(Type.SessionFailed, status=45000001, message="invalid language"))
    assert dba._failure(failed) == "invalid language（45000001）"


def test_headers_new_and_legacy_console():
    legacy = headers_of(model_config(params={"extra": {"appId": "123456"}}), "token")
    assert legacy["X-Api-App-Key"] == "123456" and legacy["X-Api-Access-Key"] == "token"
    assert legacy["X-Api-Resource-Id"] == "volc.service_type.10053" and "X-Api-Key" not in legacy
    new = headers_of(model_config(), "api-key")
    assert new["X-Api-Key"] == "api-key" and "X-Api-App-Key" not in new and new["X-Api-Connect-Id"]


@pytest.mark.parametrize(
    ("cfg", "fragment"),
    [
        ({"mode": "LISTEN", "targetLangs": ["en"]}, "发言语言"),  # 源语种自动识别不支持
        ({"mode": "LISTEN", "sourceLangs": ["ko"], "targetLangs": ["zh"]}, "仅支持"),
        ({"mode": "LISTEN", "sourceLangs": ["ja"], "targetLangs": ["fr"]}, "中文或英文"),
        ({"mode": "CONVERSE", "sourceLangs": ["ja", "de"], "converseRouting": "ptt"}, "中文或英文"),
        ({"mode": "ROOM", "sourceLangs": ["ru"], "targetLangs": ["en"]}, "仅支持"),
    ],
)
async def test_language_constraints(cfg, fragment):
    engine, _ = make_s2s_engine(DoubaoAstEngine, s2s_config("VOLCENGINE", "", "m"), cfg)
    with pytest.raises(EngineError) as ei:
        await engine.start()
    assert ei.value.error.code == "A0410" and fragment in ei.value.message


# ---------------- 回放 ----------------


async def test_replay_listen_maps_events():
    m = mock(script=SCRIPT, on_finish=ON_FINISH)
    async with m.running():
        engine, events = engine_of(
            m,
            {"mode": "LISTEN", "sourceLangs": ["zh"], "targetLangs": ["en"], "glossaryIds": [3]},
            glossaries={3: GLOSSARY},
        )
        await engine.start()
        assert events.types() == ["ready"]
        for _ in range(10):
            await engine.feed(FRAME)
        await wait_for(lambda: len(events.of("metrics")) == 2)
        await engine.finish()
        await engine.close()

    conn = m.connections[0]
    assert conn["path"] == "/api/v4/ast/v2/translate"
    assert conn["headers"]["X-Api-Key"] == "volc-access-token"
    start = conn["messages"][0]
    assert start.event == Type.StartSession and start.request.source_language == "zh"
    assert dict(start.request.corpus.glossary_list) == {"大模型": "LLM"}  # 术语库
    session_ids = {msg.request_meta.SessionID for msg in conn["messages"]}
    assert len(session_ids) == 1  # 同一会话
    assert sent_audio(conn["messages"]) == len(FRAME) * 10
    assert conn["messages"][-1].event == Type.FinishSession

    finals = [
        (e["utteranceId"], e["text"], e["lang"], e["startedMs"], e["endedMs"]) for e in events.of("transcript.final")
    ]
    assert finals == [(1, "大家好。", "zh", 120, 980), (2, "我们讨论大模型。", "zh", 1500, 2900)]
    assert [e["text"] for e in events.of("transcript.partial") if e["utteranceId"] == 1] == ["大家", "大家好"]
    translations = [(e["utteranceId"], e["lang"], e["text"]) for e in events.of("translation.final")]
    assert translations == [(1, "en", "Hello everyone."), (2, "en", "We discuss LLM.")]
    assert "".join(e["delta"] for e in events.of("translation.delta") if e["utteranceId"] == 1) == "Hello everyone."
    assert_audio_sequence(events.events, [1, 2], 16000)  # 请求 16 kHz PCM 输出
    assert [len(audio_chunks(events.events, u)) for u in (1, 2)] == [2, 2]
    metrics = events.of("metrics")
    assert [x["utteranceId"] for x in metrics] == [1, 2]
    assert all(x["e2eMs"] is not None and x["mtMs"] is not None for x in metrics)
    assert not events.of("error")


async def test_legacy_headers_and_room_alignment():
    m = mock(script=SCRIPT, on_finish=ON_FINISH)
    async with m.running():
        engine, events = engine_of(
            m, {"mode": "ROOM", "sourceLangs": ["zh"], "targetLangs": ["en", "ja", "ko"]}, extra={"appId": "app-1"}
        )
        await engine.start()
        await engine.feed(FRAME * 3)
        await wait_for(lambda: len(events.of("metrics")) == 2)
        await engine.finish()
    assert len(m.connections) == 2  # ko 不在豆包语种内：跳过并发非致命 A0410
    assert [(e["code"], e["fatal"]) for e in events.of("error")] == [("A0410", False)]
    assert {c["headers"]["X-Api-App-Key"] for c in m.connections} == {"app-1"}
    assert sorted(c["messages"][0].request.target_language for c in m.connections) == ["en", "ja"]
    assert [e["utteranceId"] for e in events.of("transcript.final")] == [1, 2]
    pairs = sorted((e["utteranceId"], e["lang"]) for e in events.of("translation.final"))
    assert pairs == [(1, "en"), (1, "ja"), (2, "en"), (2, "ja")]


async def test_converse_ptt_routes_audio():
    m = mock()
    async with m.running():
        engine, _ = engine_of(m, {"mode": "CONVERSE", "sourceLangs": ["zh", "en"], "converseRouting": "ptt"})
        await engine.start()
        await engine.control({"type": "ptt", "side": "A"})
        await engine.feed(FRAME * 3)
        await engine.control({"type": "ptt", "side": None})
        await engine.finish()
    by_target = {c["messages"][0].request.target_language: c for c in m.connections}
    assert by_target["en"]["messages"][0].request.source_language == "zh"
    assert by_target["zh"]["messages"][0].request.source_language == "en"
    assert sent_audio(by_target["zh"]["messages"]) == 0
    assert sent_audio(by_target["en"]["messages"]) == len(FRAME) * 3 + len(SILENCE_FLUSH)


# ---------------- 失败与断线 ----------------


async def test_session_failed_on_start_is_not_retried():
    m = mock(reject_setup=resp(Type.SessionFailed, status=45000001, message="unsupported language pair"))
    async with m.running():
        engine, _ = engine_of(m, {"mode": "LISTEN", "sourceLangs": ["zh"], "targetLangs": ["en"]})
        with pytest.raises(EngineError) as ei:
            await engine.start()
        assert ei.value.error.code == "C0174" and "unsupported language pair" in ei.value.message
        assert len(m.connections) == 1
        with pytest.raises(EngineError) as ei:
            await probe(cfg_of(m), "k")
        assert "45000001" in ei.value.message


async def test_probe_ok_and_auth_failure():
    m = mock()
    async with m.running():
        assert await probe(cfg_of(m, appId="app-9"), "tok") == "会话已建立"
    assert m.connections[0]["headers"]["X-Api-Access-Key"] == "tok"
    start = m.messages()[0]
    assert (start.request.source_language, start.request.target_language) == ("zh", "en")

    m = mock(http_status=403)
    async with m.running():
        with pytest.raises(EngineError) as ei:
            await probe(cfg_of(m), "bad")
        assert ei.value.error.code == "C0121"


async def test_session_failed_midway_reconnects_once():
    m = mock(ready=[STARTED, resp(Type.SessionFailed, status=55000031, message="server busy")])
    async with m.running():
        engine, events = engine_of(m, {"mode": "LISTEN", "sourceLangs": ["zh"], "targetLangs": ["en"]})
        await engine.start()
        await asyncio.wait_for(engine.fatal.wait(), 5)
        await engine.close()
    errors = [(e["code"], e["fatal"]) for e in events.of("error")]
    # 每次 SessionFailed 发一条非致命错误；第一次断开重建，第二次致命
    assert errors[-1] == ("C0174", True) and errors.count(("C0174", False)) >= 2
    assert any("server busy" in e["message"] for e in events.of("error"))
    assert len(m.connections) == 2


async def test_missing_config():
    engine, _ = make_s2s_engine(DoubaoAstEngine, None, {"mode": "LISTEN", "sourceLangs": ["en"], "targetLangs": ["zh"]})
    with pytest.raises(EngineError) as ei:
        await engine.start()
    assert ei.value.error.code == "C0173"
