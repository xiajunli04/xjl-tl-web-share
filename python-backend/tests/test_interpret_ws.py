"""WS /internal/interpret/stream（tasks 5.5）：鉴权、首帧校验、并发上限与级联端到端。

端到端用真实 Silero VAD + 本地 SenseVoice 识别样本音频（按实时速度推流），LLM 与 TTS 用替身。
TestClient 在独立线程的事件循环中运行应用；Windows 上指定 SelectorEventLoop 以便 psycopg 异步连接可用。
"""

import asyncio
import json
import time

import numpy as np
import pytest
from starlette.testclient import TestClient

from app.core.config import get_settings
from app.main import create_app
from tests.conftest import INTERNAL_TOKEN
from tests.fakes import FakeLLM, use_fake_llm
from tests.respx_bridge import make_http_client
from tests.speech_fakes import MODELS_READY, ZH_LLM, FakeTTS, read_pcm

pytestmark = pytest.mark.usefixtures("db_admin")

URL = "/internal/interpret/stream"
HEADERS = {"X-Internal-Token": INTERNAL_TOKEN}
FRAME_BYTES = 1280  # 40 ms


@pytest.fixture
def ws_client(fake_embedding):
    app = create_app(get_settings(), llm_http_client_factory=make_http_client, embedding=fake_embedding)
    with TestClient(app, backend_options={"loop_factory": asyncio.SelectorEventLoop}) as client:
        yield app, client


def collect(ws) -> tuple[list[dict], int]:
    """读取事件直到服务端关闭，返回（事件列表, 关闭码）。"""
    events = []
    while True:
        msg = ws.receive()
        if msg["type"] == "websocket.close":
            return events, msg.get("code", 1000)
        if msg.get("text"):
            events.append(json.loads(msg["text"]))


def config(**kw) -> dict:
    return {
        "type": "config",
        "streamId": "s-1-p1",
        "sessionId": 1,
        "userId": 5,
        "mode": "LISTEN",
        "engine": "cascade",
        "sourceLangs": ["auto"],
        "targetLangs": ["en"],
        **kw,
    }


def test_rejects_bad_token(ws_client):
    _, client = ws_client
    with client.websocket_connect(URL, headers={"X-Internal-Token": "nope"}) as ws:
        events, code = collect(ws)
    assert events == [] and code == 4401


@pytest.mark.parametrize(
    ("first", "fragment"),
    [
        ("hello", "合法 JSON"),
        (json.dumps({"type": "targets"}), "type=config"),
        (json.dumps(config(engine="azure-live-interpreter")), "不支持的同传引擎"),
        (json.dumps(config(mode="CONVERSE", sourceLangs=["zh", "zh"])), "不能相同"),
        (json.dumps(config(mode="SING")), "mode"),
        (json.dumps(config(latencyMode="turbo")), "latencyMode"),
        (json.dumps(config(engine="realtime-chat")), "只用于 AI 对话"),
        (
            json.dumps(
                config(mode="CHAT", engine="qwen-livetranslate", chat={"myLang": "zh", "aiLang": "en"}, targetLangs=[])
            ),
            "平台级联或实时语音模型",
        ),
    ],
)
def test_rejects_invalid_config(ws_client, first, fragment):
    _, client = ws_client
    with client.websocket_connect(URL, headers=HEADERS) as ws:
        ws.send_text(first)
        events, code = collect(ws)
    assert code == 4400
    assert events[0]["type"] == "error" and events[0]["code"] == "A0410" and events[0]["fatal"] is True
    assert fragment in events[0]["message"]


def test_rejects_when_streams_exhausted(ws_client, monkeypatch):
    app, client = ws_client
    monkeypatch.setattr(app.state.settings, "interpret_max_streams", 0)
    with client.websocket_connect(URL, headers=HEADERS) as ws:
        events, code = collect(ws)
    assert code == 1011 and events == [
        {"type": "error", "code": "A0212", "message": events[0]["message"], "fatal": True}
    ]


def test_engine_start_failure_is_fatal(ws_client):
    """没有对话模型（或本地模型缺失）时启动失败：error(fatal) 后关闭码 1011。"""
    _, client = ws_client
    with client.websocket_connect(URL, headers=HEADERS) as ws:
        ws.send_json(config())
        events, code = collect(ws)
    assert code == 1011
    assert events[-1]["type"] == "error" and events[-1]["fatal"] is True
    assert events[-1]["code"] in ("C0130", "C0173")


def test_qwen_without_config_is_unavailable(ws_client):
    _, client = ws_client
    with client.websocket_connect(URL, headers=HEADERS) as ws:
        ws.send_json(config(engine="qwen-livetranslate"))
        events, code = collect(ws)
    assert code == 1011 and events[-1]["code"] == "C0173"


@pytest.mark.skipif(not MODELS_READY, reason="本地语音模型未下载（设置 SPEECH_MODEL_DIR）")
def test_config_with_history_starts_stream(ws_client, monkeypatch):
    """improve-prompts-and-context-memory 5.2：重建发言流的 config 带 history 时照常建流。"""
    app, client = ws_client
    use_fake_llm(app, monkeypatch, FakeLLM(translations=["ok"]))
    history = [{"role": "user", "lang": "zh", "text": "大家好", "translations": {"en": "Hello everyone"}}]
    with client.websocket_connect(URL, headers=HEADERS) as ws:
        ws.send_json(config(asrEngine="local-sensevoice", tts=False, history=history))
        assert ws.receive_json()["type"] == "ready"
        ws.send_json({"type": "end"})
        events, code = collect(ws)
    assert code == 1000 and events[-1]["type"] == "ended" and "error" not in [e["type"] for e in events]


def test_cascade_end_to_end(ws_client, monkeypatch):
    app, client = ws_client
    fake = FakeLLM(translations=["Large models are changing the translation industry."], chunk_size=8)
    use_fake_llm(app, monkeypatch, fake)
    tts = FakeTTS(chunks=2, chunk_bytes=6000)

    async def _resolve_tts(engine_id, model_config_id, registry):
        return tts

    monkeypatch.setattr("app.interpret.cascade.resolve_tts", _resolve_tts)
    silence = np.zeros(16000, dtype="<i2").tobytes()
    audio = silence[: 16000 * 2 * 3 // 10] + read_pcm(ZH_LLM) + silence + silence[: 16000 * 2 * 2 // 10]
    with client.websocket_connect(URL, headers=HEADERS) as ws:
        ws.send_json(config(asrEngine="local-sensevoice", ttsEngine="edge-tts"))
        ready = ws.receive_json()
        assert ready == {"type": "ready", "engine": "cascade", "sourceLangs": ["auto"], "targetLangs": ["en"]}
        for i in range(0, len(audio), FRAME_BYTES):  # 按实时速度推流
            ws.send_bytes(audio[i : i + FRAME_BYTES])
            time.sleep(0.04)
        ws.send_json({"type": "end"})
        events, code = collect(ws)

    assert code == 1000
    types = [e["type"] for e in events]
    assert types[-1] == "ended" and events[-1]["reason"] == "user_end"
    assert "error" not in types
    partials = [e for e in events if e["type"] == "transcript.partial"]
    assert partials and {e["utteranceId"] for e in partials} == {1}
    final = next(e for e in events if e["type"] == "transcript.final")
    assert final["utteranceId"] == 1 and "大模型" in final["text"] and final["lang"] == "zh"
    assert 100 <= final["startedMs"] <= 500 and final["endedMs"] - final["startedMs"] > 1500
    tr_final = next(e for e in events if e["type"] == "translation.final")
    assert tr_final == {
        "type": "translation.final",
        "utteranceId": 1,
        "lang": "en",
        "text": "Large models are changing the translation industry.",
        "ttsFallback": False,
    }
    audio_events = [e for e in events if e["type"] == "audio"]
    assert [(a["seq"], a["last"], bool(a["data"])) for a in audio_events] == [
        (0, False, True),
        (1, False, True),
        (2, True, False),
    ]
    metrics = next(e for e in events if e["type"] == "metrics")
    assert metrics["utteranceId"] == 1 and metrics["e2eMs"] is not None and metrics["asrMs"] is not None
    # 契约中一句话的事件顺序：partial → final → delta → translation.final → audio → metrics
    order = [
        types.index(t)
        for t in (
            "transcript.partial",
            "transcript.final",
            "translation.delta",
            "translation.final",
            "audio",
            "metrics",
            "ended",
        )
    ]
    assert order == sorted(order)
    assert fake.calls[0][1].max_tokens == 300
