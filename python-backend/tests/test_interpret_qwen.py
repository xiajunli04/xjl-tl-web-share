"""百炼同传引擎（tasks 5.4）：用真实联调抓取的事件序列在 pytest 内的模拟服务（websockets.serve）上回放。

夹具 tests/fixtures/interpret/qwen_livetranslate_events.jsonl：2026-10-04 用 qwen3.8-livetranslate-flash-realtime
真实联调一句 6.3 s 普通话 → 英文（热词 大模型→LLM），音频 delta 截断为前 960 字节。
"""

import asyncio
import base64
import contextlib
import json
from pathlib import Path

import pytest
from websockets.asyncio.server import serve

from app.glossary.repository import Glossary, Term
from app.interpret import qwen_livetranslate as qwen
from app.interpret.engine import EngineError, StreamConfig
from app.interpret.qwen_livetranslate import QwenLiveTranslateEngine, build_session, probe, realtime_url
from tests.speech_fakes import Collector, StubRegistry, engine_deps, model_config

FIXTURE = Path(__file__).parent / "fixtures" / "interpret" / "qwen_livetranslate_events.jsonl"
EVENTS = [json.loads(line) for line in FIXTURE.read_text(encoding="utf-8").splitlines()]
CLIENT_UPDATE = EVENTS[0]
SERVER_EVENTS = [e for e in EVENTS if e.get("_dir") != "client"]
SETUP_TYPES = ("session.created", "session.updated")
GLOSSARY = Glossary(3, "AI", "zh", "en", (Term(1, 3, "大模型", "LLM"),))


def _clean(ev: dict) -> str:
    return json.dumps({k: v for k, v in ev.items() if not k.startswith("_") and k != "delta_len"}, ensure_ascii=False)


class MockQwen:
    """按夹具回放的模拟百炼实时同传服务。

    replay=True：收到首包音频后按夹具的相对时间（乘以 time_scale）回放全部服务端事件；
    drop：在第几次连接（从 1 开始）完成 session.updated 后立即断开；error_on_update：会话配置阶段返回 error。
    """

    def __init__(
        self,
        *,
        replay: bool = True,
        time_scale: float = 0.03,
        drop: set[int] | None = None,
        error_on_update: str | None = None,
    ):
        self.replay = replay
        self.time_scale = time_scale
        self.drop = drop or set()
        self.error_on_update = error_on_update
        self.connections: list[dict] = []
        self.port = 0

    async def handler(self, ws) -> None:
        conn = {"auth": ws.request.headers.get("Authorization"), "path": ws.request.path, "messages": []}
        self.connections.append(conn)
        n = len(self.connections)
        update = json.loads(await ws.recv())
        conn["messages"].append(update)
        if self.error_on_update:
            await ws.send(
                json.dumps({"type": "error", "error": {"code": "InvalidParameter", "message": self.error_on_update}})
            )
            return
        for ev in SERVER_EVENTS:
            if ev["type"] in SETUP_TYPES:
                await ws.send(_clean(ev))
        if n in self.drop:
            await ws.close()
            return
        finished = asyncio.Event()
        first_audio = asyncio.Event()

        async def receive() -> None:
            with contextlib.suppress(Exception):
                async for raw in ws:
                    msg = json.loads(raw)
                    conn["messages"].append(msg)
                    if msg["type"] == "input_audio_buffer.append":
                        first_audio.set()
                    elif msg["type"] == "session.finish":
                        finished.set()

        reader = asyncio.create_task(receive())
        try:
            if self.replay:
                await asyncio.wait_for(first_audio.wait(), 5)
                prev = None
                for ev in SERVER_EVENTS:
                    if ev["type"] in (*SETUP_TYPES, "session.finished"):
                        continue
                    if prev is not None:
                        await asyncio.sleep(max(0.0, ev["_t"] - prev) * self.time_scale)
                    prev = ev["_t"]
                    await ws.send(_clean(ev))
            await asyncio.wait_for(finished.wait(), 10)
            await ws.send(json.dumps({"type": "session.finished"}))
        finally:
            reader.cancel()

    @contextlib.asynccontextmanager
    async def running(self):
        async with serve(self.handler, "127.0.0.1", 0) as server:
            self.port = server.sockets[0].getsockname()[1]
            yield self

    def config(self, model: str = "qwen3.8-livetranslate-flash-realtime", **extra):
        return model_config(
            provider="DASHSCOPE",
            base_url=f"ws://127.0.0.1:{self.port}/api-ws/v1/realtime",
            model_name=model,
            capability="REALTIME_TRANSLATE",
            params={"extra": extra} if extra else {},
        )


def make_engine(mock: MockQwen, cfg: dict, glossaries: dict | None = None, **extra):
    config = StreamConfig.model_validate({"type": "config", "engine": "qwen-livetranslate", **cfg})
    out = Collector()
    registry = StubRegistry(configs={"REALTIME_TRANSLATE": (mock.config(**extra), "sk-dashscope-test")})
    return QwenLiveTranslateEngine(config, out, engine_deps(registry, glossaries, detect_lang="zh")), out


async def wait_for(predicate, timeout: float = 5.0) -> None:
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(0.01)


AUDIO_FRAME = b"\x01\x00" * 640  # 40 ms


# ---------------- 会话参数 ----------------


def test_build_session_versions_and_voice():
    s38 = build_session("qwen3.8-livetranslate-flash-realtime", "en", "Tina", {"大模型": "LLM"})
    assert s38 == CLIENT_UPDATE["session"]  # 与真实联调发送的 session.update 完全一致
    s35 = build_session("qwen3.5-livetranslate-flash-realtime", "ja", "Cherry")
    assert s35["modalities"] == ["text", "audio"] and "output_modalities" not in s35
    assert s35["input_audio_format"] == "pcm" and s35["output_audio_format"] == "pcm"
    assert s35["voice"] == "Cherry" and s35["translation"] == {"language": "ja"}
    assert qwen.voice_of(model_config()) == "Tina"
    assert qwen.voice_of(model_config(params={"extra": {"voice": "Ethan"}})) == "Ethan"


def test_realtime_url():
    cfg = model_config(base_url="wss://dashscope.aliyuncs.com/api-ws/v1/realtime/", model_name="m1")
    assert realtime_url(cfg) == "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=m1"
    assert realtime_url(model_config(base_url="https://x.test/rt?a=1", model_name="m")) == "wss://x.test/rt?a=1&model=m"
    assert realtime_url(model_config(base_url="", model_name="m")).startswith(qwen.DEFAULT_URL)


# ---------------- 回放 ----------------


async def test_replay_listen_maps_events():
    mock = MockQwen()
    async with mock.running():
        engine, out = make_engine(mock, {"mode": "LISTEN", "targetLangs": ["en"], "glossaryIds": [3]}, {3: GLOSSARY})
        await engine.start()
        assert out.types() == ["ready"]
        for _ in range(10):
            await engine.feed(AUDIO_FRAME)
        await wait_for(lambda: len(out.of("metrics")) == 3)
        await engine.finish()
        await engine.close()

    conn = mock.connections[0]
    assert conn["auth"] == "Bearer sk-dashscope-test"
    assert conn["path"] == "/api-ws/v1/realtime?model=qwen3.8-livetranslate-flash-realtime"
    update = conn["messages"][0]
    assert update["type"] == "session.update" and update["session"] == CLIENT_UPDATE["session"]  # 含热词
    appends = [m for m in conn["messages"] if m["type"] == "input_audio_buffer.append"]
    assert sum(len(base64.b64decode(m["audio"])) for m in appends) == len(AUDIO_FRAME) * 10
    assert conn["messages"][-1]["type"] == "session.finish"

    finals = out.of("transcript.final")
    assert [(e["utteranceId"], e["text"], e["lang"]) for e in finals] == [
        (1, "大家好", "zh"),
        (2, "今天我们讨论大模型 在翻译中的应用", "zh"),
        (3, "这个方案下周上线", "zh"),
    ]
    assert (finals[0]["startedMs"], finals[0]["endedMs"]) == (24, 1100)
    partials = [e["text"] for e in out.of("transcript.partial") if e["utteranceId"] == 2]
    assert partials[0] == "今天我们" and partials[-1] == "今天我们讨论大模型 在翻译中的应用"
    translations = [(e["utteranceId"], e["lang"], e["text"]) for e in out.of("translation.final")]
    assert translations[0] == (1, "en", "Hello everyone.")
    assert "LLM" in translations[1][2]  # 热词生效
    assert translations[2] == (3, "en", "This solution will be launched next week.")
    for uid, _, text in translations:
        deltas = "".join(e["delta"] for e in out.of("translation.delta") if e["utteranceId"] == uid)
        assert deltas.strip() == text
    audio = out.of("audio")
    assert (
        len([a for a in audio if a["data"]]) == 27
        and {a["format"] for a in audio} == {"pcm16"}
        and {a["sampleRate"] for a in audio} == {24000}
    )
    for uid in (1, 2, 3):
        mine = [a for a in audio if a["utteranceId"] == uid]
        assert [a["seq"] for a in mine] == list(range(len(mine)))
        assert [a["last"] for a in mine] == [False] * (len(mine) - 1) + [True]
    assert [e["utteranceId"] for e in out.of("audio")] == sorted(e["utteranceId"] for e in out.of("audio"))
    metrics = out.of("metrics")
    assert [m["utteranceId"] for m in metrics] == [1, 2, 3]
    assert all(m["e2eMs"] is not None and m["e2eMs"] >= 0 and m["mtMs"] is not None for m in metrics)
    # 每句事件顺序：final 之后才有 metrics
    types = [e["type"] for e in out.events if e.get("utteranceId") == 2]
    assert types.index("transcript.final") < types.index("translation.final") < types.index("metrics")
    assert not out.of("error")


async def test_replay_room_aligns_sessions():
    mock = MockQwen(time_scale=0.01)
    async with mock.running():
        engine, out = make_engine(mock, {"mode": "ROOM", "sourceLangs": ["zh"], "targetLangs": ["en", "ja", "zh"]})
        await engine.start()
        for _ in range(5):
            await engine.feed(AUDIO_FRAME)
        await wait_for(lambda: len(out.of("translation.final")) == 6)
        await wait_for(lambda: len(out.of("metrics")) == 3)
        await engine.finish()
    assert len(mock.connections) == 2
    langs = sorted(c["messages"][0]["session"]["translation"]["language"] for c in mock.connections)
    assert langs == ["en", "ja"]  # 每个目标语言一个上游会话，去掉发言人自己的语言
    assert [e["utteranceId"] for e in out.of("transcript.final")] == [1, 2, 3]  # 原文只发一次
    pairs = sorted((e["utteranceId"], e["lang"]) for e in out.of("translation.final"))
    assert pairs == [(1, "en"), (1, "ja"), (2, "en"), (2, "ja"), (3, "en"), (3, "ja")]
    assert all(c["messages"][0]["session"].get("translation", {}).get("corpus") is None for c in mock.connections)


async def test_single_member_room_emits_source_only_then_switches_to_translation():
    """单人会议室：用占位目标建立上游会话，只发原文与指标；有人加入后改为正常翻译会话。"""
    mock = MockQwen(time_scale=0.01)
    async with mock.running():
        engine, out = make_engine(mock, {"mode": "ROOM", "sourceLangs": ["zh"], "targetLangs": ["zh"]})
        await engine.start()
        for _ in range(5):
            await engine.feed(AUDIO_FRAME)
        await wait_for(lambda: len(out.of("metrics")) == 3)
        assert [e["text"] for e in out.of("transcript.final")][0] == "大家好"
        assert not out.of("translation.delta") and not out.of("translation.final") and not out.of("audio")
        assert all(m["e2eMs"] == m["asrMs"] for m in out.of("metrics"))
        assert mock.connections[0]["messages"][0]["session"]["translation"]["language"] == "en"  # 占位目标

        await engine.control({"type": "targets", "targetLangs": ["ja"]})
        await wait_for(lambda: len(mock.connections) == 2)
        await engine.finish()
    assert mock.connections[1]["messages"][0]["session"]["translation"]["language"] == "ja"
    assert not out.of("error")


async def test_converse_requires_ptt_and_routes_by_side():
    mock = MockQwen(replay=False)
    async with mock.running():
        engine, _ = make_engine(mock, {"mode": "CONVERSE", "sourceLangs": ["zh", "en"], "converseRouting": "auto"})
        with pytest.raises(EngineError) as ei:
            await engine.start()
        assert ei.value.error.code == "A0410" and "按键" in ei.value.message

        engine, out = make_engine(mock, {"mode": "CONVERSE", "sourceLangs": ["zh", "en"], "converseRouting": "ptt"})
        await engine.start()
        await engine.feed(AUDIO_FRAME * 3)  # 未按键：不送音频
        await engine.control({"type": "ptt", "side": "A"})  # A=zh → 送往目标 en 的会话
        await engine.feed(AUDIO_FRAME * 3)
        await engine.control({"type": "ptt", "side": None})  # 松开：补静音促使断句
        await engine.finish()

    by_target = {c["messages"][0]["session"]["translation"]["language"]: c for c in mock.connections}
    assert set(by_target) == {"zh", "en"}

    def audio_bytes(conn):
        return sum(
            len(base64.b64decode(m["audio"])) for m in conn["messages"] if m["type"] == "input_audio_buffer.append"
        )

    assert audio_bytes(by_target["zh"]) == 0
    assert audio_bytes(by_target["en"]) == len(AUDIO_FRAME) * 3 + len(qwen.SILENCE_FLUSH)


async def test_connect_retries_with_backoff(monkeypatch):
    mock = MockQwen(replay=False)
    attempts = []
    real_connect = qwen.connect

    def flaky(*args, **kwargs):
        attempts.append(1)
        if len(attempts) <= 2:
            raise ConnectionResetError("[WinError 64] 指定的网络名不再可用。")
        return real_connect(*args, **kwargs)

    monkeypatch.setattr(qwen, "connect", flaky)
    monkeypatch.setattr(qwen, "BACKOFF_BASE_SECONDS", 0)
    async with mock.running():
        engine, out = make_engine(mock, {"mode": "LISTEN", "targetLangs": ["en"]})
        await engine.start()
        assert len(attempts) == 3 and out.types() == ["ready"]
        await engine.finish()

        attempts.clear()
        monkeypatch.setattr(qwen, "connect", lambda *a, **k: (_ for _ in ()).throw(OSError("reset")))
        engine, _ = make_engine(mock, {"mode": "LISTEN", "targetLangs": ["en"]})
        with pytest.raises(EngineError) as ei:
            await engine.start()
        assert ei.value.error.code == "C0174"


async def test_session_error_is_not_retried():
    mock = MockQwen(error_on_update="Voice 'Chelsie' is not supported.")
    async with mock.running():
        engine, _ = make_engine(mock, {"mode": "LISTEN", "targetLangs": ["en"]})
        with pytest.raises(EngineError) as ei:
            await engine.start()
        assert ei.value.error.code == "C0174" and "Chelsie" in ei.value.message
        assert len(mock.connections) == 1
        with pytest.raises(EngineError):
            await probe(mock.config(), "k")


async def test_upstream_drop_reconnects_once_then_fatal():
    mock = MockQwen(replay=False, drop={1, 2})
    async with mock.running():
        engine, out = make_engine(mock, {"mode": "LISTEN", "targetLangs": ["en"]})
        await engine.start()
        await asyncio.wait_for(engine.fatal.wait(), 5)
        await engine.close()
    errors = out.of("error")
    assert [(e["code"], e["fatal"]) for e in errors] == [("C0174", False), ("C0174", True)]
    assert len(mock.connections) == 2


async def test_upstream_drop_recovers():
    mock = MockQwen(replay=False, drop={1})
    async with mock.running():
        engine, out = make_engine(mock, {"mode": "LISTEN", "targetLangs": ["en"]})
        await engine.start()
        await wait_for(lambda: len(mock.connections) == 2)
        await asyncio.sleep(0.05)
        await engine.feed(AUDIO_FRAME * 3)
        await engine.finish()
    assert [(e["code"], e["fatal"]) for e in out.of("error")] == [("C0174", False)]
    assert not engine.fatal.is_set()
    assert any(m["type"] == "input_audio_buffer.append" for m in mock.connections[1]["messages"])


async def test_probe_ok():
    mock = MockQwen(replay=False)
    async with mock.running():
        assert await probe(mock.config(voice="Ethan"), "sk-probe") == "会话已建立"
    conn = mock.connections[0]
    assert conn["auth"] == "Bearer sk-probe" and conn["messages"][0]["session"]["voice"] == "Ethan"
