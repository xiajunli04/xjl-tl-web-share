"""AI 对话实时语音模型引擎（improve-speech-playback-latency 4.3–4.6）。

模拟上游按 2026-10-06 百炼 qwen3-omni-flash-realtime 真实联调抓取的事件序列回放
（tests/fixtures/interpret/omni_realtime_events.jsonl）：开场白、一轮对话、客户端打断、服务端自动取消、断线重连。
"""

import asyncio
import base64
import contextlib
import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from websockets.asyncio.server import serve

from app.api.internal.interpret import engine_class
from app.interpret.engine import StreamConfig
from app.interpret.realtime_chat import ADAPTERS, RealtimeChatEngine
from app.llm.base import ChatResult, Usage
from app.repositories.model_config import ModelConfig
from tests.fakes import resolved
from tests.speech_fakes import Collector, StubRegistry, engine_deps

FIXTURE = Path(__file__).parent / "fixtures" / "interpret" / "omni_realtime_events.jsonl"
GREETING = "Hi there, welcome to Lumi's Kitchen! What can I get you?"
REPLY = "Sure, no problem. Rolling back right away is a good call. Anything else?"
AUDIO = b"\x01\x02" * 2400  # 100 ms PCM16 24 kHz


def _evs(kind: str, **fields) -> dict:
    return {"type": kind, **fields}


def reply_script(rid: str, item: str, text: str, chunks: int = 3, words_per_delta: int = 3) -> list[dict]:
    words = text.split(" ")
    deltas = [" ".join(words[i : i + words_per_delta]) + " " for i in range(0, len(words), words_per_delta)]
    out = [_evs("response.created", response={"id": rid, "status": "in_progress"})]
    out += [_evs("response.audio_transcript.delta", response_id=rid, item_id=item, delta=d) for d in deltas]
    out += [
        _evs("response.audio.delta", response_id=rid, item_id=item, delta=base64.b64encode(AUDIO).decode())
        for _ in range(chunks)
    ]
    out += [
        _evs("response.audio_transcript.done", response_id=rid, item_id=item, transcript=text),
        _evs("response.audio.done", response_id=rid, item_id=item),
        _evs("response.done", response={"id": rid, "status": "completed"}),
    ]
    return out


def user_turn(item: str, text: str) -> list[dict]:
    return [
        _evs("input_audio_buffer.speech_started", item_id=item, audio_start_ms=0),
        _evs("input_audio_buffer.speech_stopped", item_id=item, audio_end_ms=3400),
        _evs("input_audio_buffer.committed", item_id=item),
    ]


def user_transcript(item: str, text: str) -> dict:
    return _evs("conversation.item.input_audio_transcription.completed", item_id=item, transcript=text, language="zh")


@dataclass
class MockOmni:
    """模拟上游：session.update → session.updated；response.create → 开场白；累计 appends_per_turn 包音频后回放一轮。"""

    turns: list[list[dict]] = field(default_factory=list)
    appends_per_turn: int = 2
    delay: float = 0.005
    drop_after_greeting: set[int] = field(default_factory=set)  # 第 n 次连接（从 1 开始）在开场白后断开
    connections: list[dict[str, Any]] = field(default_factory=list)
    port: int = 0

    async def handler(self, ws) -> None:
        conn = {"headers": ws.request.headers, "path": ws.request.path, "messages": []}
        self.connections.append(conn)
        n = len(self.connections)
        cancel = asyncio.Event()
        playing: list[asyncio.Task] = []

        async def play(events: list[dict]) -> None:
            for ev in events:
                if cancel.is_set() and ev["type"].startswith("response."):
                    rid = next((e["response"]["id"] for e in events if e["type"] == "response.created"), None)
                    await ws.send(json.dumps(_evs("response.done", response={"id": rid, "status": "cancelled"})))
                    return
                await asyncio.sleep(self.delay)
                await ws.send(json.dumps(ev))

        appends = 0
        turn = 0
        async for raw in ws:
            msg = json.loads(raw)
            conn["messages"].append(msg)
            kind = msg["type"]
            if kind == "session.update":
                await ws.send(json.dumps(_evs("session.created")))
                await ws.send(json.dumps(_evs("session.updated", session=msg["session"])))
            elif kind == "response.create":
                cancel.clear()
                await play(reply_script("resp_greet", "item_greet", GREETING))
                if n in self.drop_after_greeting:
                    await ws.close()
                    return
            elif kind == "response.cancel":
                cancel.set()
            elif kind == "input_audio_buffer.append":
                appends += 1
                if appends % self.appends_per_turn == 0 and turn < len(self.turns):
                    cancel.clear()
                    playing.append(asyncio.create_task(play(self.turns[turn])))
                    turn += 1
        for t in playing:
            t.cancel()

    @contextlib.asynccontextmanager
    async def running(self):
        async with serve(self.handler, "127.0.0.1", 0) as server:
            self.port = server.sockets[0].getsockname()[1]
            yield self

    def sent(self, n: int = 0, kind: str | None = None) -> list[dict]:
        return [m for m in self.connections[n]["messages"] if kind is None or m["type"] == kind]


@dataclass
class SubtitleLLM:
    model: str = "fake-mt"
    requests: list = field(default_factory=list)

    async def chat(self, req):
        self.requests.append(req)
        await asyncio.sleep(0.01)
        return ChatResult(content=f"[zh]{req.messages[-1].content}", model=self.model, usage=Usage(1, 1), latency_ms=1)

    async def stream(self, req):  # pragma: no cover
        raise NotImplementedError

    async def close(self) -> None:
        pass


def rc_config(port: int, provider: str = "DASHSCOPE") -> ModelConfig:
    return ModelConfig(
        id=9,
        name="omni",
        provider=provider,
        base_url=f"ws://127.0.0.1:{port}/api-ws/v1/realtime",
        model_name="qwen3-omni-flash-realtime",
        api_key_cipher="",
        is_default=True,
        enabled=True,
        updated_at=datetime.now(UTC),
        params={},
        capability="REALTIME_CHAT",
    )


def make_engine(
    mock: MockOmni, *, my="zh", ai="en", greet=True, provider="DASHSCOPE", llm=True, history=None, memory=None
):
    cfg = StreamConfig.model_validate(
        {
            "type": "config",
            "streamId": "rt",
            "mode": "CHAT",
            "engine": "realtime-chat",
            "sourceLangs": [my, ai],
            "chat": {"scenario": "restaurant", "myLang": my, "aiLang": ai, "greet": greet, "memory": memory},
            "history": history or [],
        }
    )
    registry = StubRegistry(configs={"REALTIME_CHAT": (rc_config(mock.port, provider), "sk-rt")})
    registry.llm = SubtitleLLM() if llm else None
    out = Collector()
    return RealtimeChatEngine(cfg, out, engine_deps(registry)), out


async def wait_for(cond, timeout: float = 5.0) -> None:
    async with asyncio.timeout(timeout):
        while not cond():
            await asyncio.sleep(0.01)


def of_uid(out: Collector, uid: int) -> list[dict]:
    return [e for e in out.events if e.get("utteranceId") == uid]


async def feed_turn(engine: RealtimeChatEngine, frames: int = 6) -> None:
    for _ in range(frames):
        await engine.feed(b"\x00\x00" * 640)  # 40 ms PCM16 16 kHz


# ---------------- 夹具与注册 ----------------


def test_fixture_is_real_capture():
    events = [json.loads(line) for line in FIXTURE.read_text(encoding="utf-8").splitlines()]
    kinds = {e["type"] for e in events}
    assert {"session.updated", "response.audio.delta", "input_audio_buffer.speech_stopped"} <= kinds
    assert any(e["type"] == "response.done" and e["response"]["status"] == "cancelled" for e in events)
    session = next(e for e in events if e["type"] == "session.updated")["session"]
    assert session["output_audio_format"] == "pcm24" and session["turn_detection"]["interrupt_response"] is True


def test_engine_class_for_chat_modes():
    base = {"type": "config", "mode": "CHAT", "chat": {"myLang": "zh", "aiLang": "en"}}
    assert engine_class(StreamConfig.model_validate({**base, "engine": "realtime-chat"})) is RealtimeChatEngine
    assert engine_class(StreamConfig.model_validate({**base, "engine": "cascade"})).__name__ == "CascadeChatEngine"


# ---------------- 开场白与一轮对话 ----------------


async def test_greeting_and_one_turn():
    mock = MockOmni(
        turns=[
            user_turn("item_u1", "")
            + reply_script("resp_1", "item_a1", REPLY)
            + [user_transcript("item_u1", "我想立即回滚")]
        ]
    )
    async with mock.running():
        engine, out = make_engine(mock)
        await engine.start()
        session = mock.sent(0, "session.update")[0]["session"]
        assert session["voice"] == "Cherry" and session["output_audio_format"] == "pcm24"
        assert "服务员" in session["instructions"] and "英语" in session["instructions"]
        await wait_for(lambda: mock.sent(0, "response.create"))  # 开场白
        await wait_for(lambda: any(e["type"] == "metrics" and e.get("utteranceId") == 1 for e in out.events))
        greet = of_uid(out, 1)
        assert all(e.get("role") == "assistant" for e in greet)
        assert next(e for e in greet if e["type"] == "transcript.final")["text"] == GREETING
        audio = [e for e in greet if e["type"] == "audio"]
        assert audio[0]["format"] == "pcm16" and audio[0]["sampleRate"] == 24000 and audio[-1]["last"] is True
        subtitle = next(e for e in greet if e["type"] == "translation.final")
        assert subtitle["lang"] == "zh" and subtitle["text"].startswith("[zh]Hi there")
        sub_req = engine._llm.client.requests[0]
        assert "字幕译者" in sub_req.messages[0].content and sub_req.temperature == 0.3

        await feed_turn(engine)
        await wait_for(lambda: any(e["type"] == "metrics" and e.get("utteranceId") == 3 for e in out.events))
        user = of_uid(out, 2)
        assert [e["type"] for e in user] == ["transcript.final", "metrics"]
        assert user[0]["text"] == "我想立即回滚" and user[0]["lang"] == "zh" and "role" not in user[0]
        assert user[1]["asrMs"] is not None
        reply = of_uid(out, 3)
        assert next(e for e in reply if e["type"] == "transcript.final")["text"] == REPLY
        metrics = reply[-1]
        assert metrics["type"] == "metrics" and metrics["e2eMs"] is not None and metrics["ttsFirstMs"] is not None
        appended = mock.sent(0, "input_audio_buffer.append")
        assert appended and len(base64.b64decode(appended[0]["audio"])) >= 3200  # 攒满约 100 ms 一包、16 kHz 原样上行
        await engine.finish()
        await engine.close()
    assert [m.role for m in engine._dialog] == ["assistant", "user", "assistant"]


async def test_same_language_has_no_subtitles():
    mock = MockOmni()
    async with mock.running():
        engine, out = make_engine(mock, my="en", ai="en")
        await engine.start()
        await wait_for(lambda: out.of("metrics"))
        await engine.close()
    assert out.of("translation.delta", "translation.final") == []


# ---------------- 打断 ----------------


async def test_client_interrupt_cancels_upstream():
    mock = MockOmni(turns=[user_turn("item_u1", "") + reply_script("resp_1", "item_a1", REPLY, chunks=40)], delay=0.02)
    async with mock.running():
        engine, out = make_engine(mock, greet=False)
        await engine.start()
        await feed_turn(engine)
        await wait_for(lambda: any(e["type"] == "audio" for e in out.events))
        await engine.control({"type": "interrupt"})
        cut = len(out.events)
        await wait_for(lambda: mock.sent(0, "response.cancel"))
        await asyncio.sleep(0.2)
        await engine.close()
    interrupted = out.of("reply.interrupted")
    assert len(interrupted) == 1 and interrupted[0]["role"] == "assistant" and interrupted[0]["text"]
    assert not [e for e in out.events[cut:] if e["type"] == "audio"]  # 打断后不再下发该回复的音频
    assert engine._dialog[-1].content.endswith("…")


async def test_server_side_cancel_maps_to_interrupted():
    """戴耳机插话：服务端检测到新的说话后自动取消回复（response.done cancelled）。"""
    turn = user_turn("item_u1", "") + reply_script("resp_1", "item_a1", REPLY)
    turn = turn[:-3] + [_evs("response.done", response={"id": "resp_1", "status": "cancelled"})]
    mock = MockOmni(turns=[turn])
    async with mock.running():
        engine, out = make_engine(mock, greet=False)
        await engine.start()
        await feed_turn(engine)
        await wait_for(lambda: out.of("reply.interrupted"))
        await engine.close()
    assert out.of("reply.interrupted")[0]["utteranceId"] == 2
    assert not mock.sent(0, "response.cancel")  # 服务端已取消，不必再发


# ---------------- 断线重连 ----------------


async def test_upstream_drop_reconnects_with_history():
    mock = MockOmni(drop_after_greeting={1})
    async with mock.running():
        engine, out = make_engine(mock, memory="用户信息：小林")
        await engine.start()
        await wait_for(lambda: len(mock.connections) == 2 and mock.sent(1, "session.update") and out.of("error"))
        errors = out.of("error")
        assert errors[0]["code"] == "C0174" and errors[0]["fatal"] is False
        instructions = mock.sent(1, "session.update")[0]["session"]["instructions"]
        # 重连的 instructions 同时带对话记忆摘要与尚未并入摘要的对话（improve-prompts-and-context-memory 3.3）
        assert "此前的对话" in instructions and GREETING in instructions
        assert "## 对话记忆" in instructions and "用户信息：小林" in instructions
        assert not engine.fatal.is_set()
        await engine.close()


async def test_rebuilt_stream_restores_history_without_greeting():
    # improve-prompts-and-context-memory 5.2：发言流重建（greet=false）时首次建立的上游会话就带上历史与摘要
    history = [
        {"role": "user", "lang": "zh", "text": "我朋友对花生过敏"},
        {"role": "assistant", "lang": "en", "text": "Noted, no peanuts for your friend."},
    ]
    mock = MockOmni()
    async with mock.running():
        engine, out = make_engine(mock, greet=False, history=history, memory="用户信息：两位顾客")
        await engine.start()
        instructions = mock.sent(0, "session.update")[0]["session"]["instructions"]
        assert "我朋友对花生过敏" in instructions and "Noted, no peanuts" in instructions
        assert "用户信息：两位顾客" in instructions
        await asyncio.sleep(0.2)
        assert not mock.sent(0, "response.create")  # 不重复开场白
        await engine.close()
    assert [m.content for m in engine._dialog] == ["我朋友对花生过敏", "Noted, no peanuts for your friend."]
    assert engine._user_before(1) == "我朋友对花生过敏"


async def test_memory_compression_emits_event_and_falls_back_without_model():
    # improve-prompts-and-context-memory 4.3：有对话模型时后台压缩并发 memory；没有时只保留最近 24 轮
    mock = MockOmni()
    engine, out = make_engine(mock)
    engine._llm = resolved(SubtitleLLM())
    for i in range(1, 17):
        engine._remember(2 * i - 1, "user", f"u{i}")
        engine._remember(2 * i, "assistant", f"a{i}")
    await asyncio.gather(*list(engine._tasks))
    memory = out.of("memory")
    assert len(memory) == 1 and memory[0]["turns"] == 4 and memory[0]["summary"].startswith("[zh]")
    assert engine._memory.summary == memory[0]["summary"] and engine._dialog[0].content == "u5"

    bare, out2 = make_engine(mock, llm=False)
    for i in range(1, 31):
        bare._remember(2 * i - 1, "user", f"u{i}")
        bare._remember(2 * i, "assistant", f"a{i}")
    assert not bare._tasks and not out2.of("memory")
    assert len(bare._dialog) == 48 and bare._dialog[0].content == "u7"


async def test_second_drop_is_fatal():
    mock = MockOmni(drop_after_greeting={1, 2})
    async with mock.running():
        engine, out = make_engine(mock)
        await engine.start()
        await wait_for(lambda: len(mock.connections) == 2 and mock.sent(1, "session.update"))
        await wait_for(lambda: engine._reconnected and engine._ws is not None and engine._ws.state.name == "OPEN")
        await engine._greet()  # 重连后的会话再次断开
        await wait_for(lambda: engine.fatal.is_set())
        await engine.close()
    assert out.of("error")[-1]["fatal"] is True and "平台级联" in out.of("error")[-1]["message"]


# ---------------- 配置与适配器 ----------------


async def test_unavailable_without_config():
    engine = RealtimeChatEngine(
        StreamConfig.model_validate(
            {"type": "config", "mode": "CHAT", "engine": "realtime-chat", "chat": {"myLang": "zh", "aiLang": "en"}}
        ),
        Collector(),
        engine_deps(StubRegistry()),
    )
    from app.interpret.engine import EngineError

    with pytest.raises(EngineError) as ei:
        await engine.start()
    assert ei.value.error.code == "C0173"


async def test_openai_adapter_resamples_and_headers():
    mock = MockOmni()
    async with mock.running():
        engine, out = make_engine(mock, provider="OPENAI_COMPATIBLE", greet=False)
        await engine.start()
        await feed_turn(engine, frames=5)  # 200 ms @16 kHz → 24 kHz 后 9600 字节
        await engine.finish()
        await engine.close()
    conn = mock.connections[0]
    assert conn["headers"]["OpenAI-Beta"] == "realtime=v1" and conn["path"].endswith(
        "/realtime?model=qwen3-omni-flash-realtime"
    )
    session = mock.sent(0, "session.update")[0]["session"]
    assert session["voice"] == "alloy" and session["output_audio_format"] == "pcm16"
    total = sum(len(base64.b64decode(m["audio"])) for m in mock.sent(0, "input_audio_buffer.append"))
    assert total == 9600
    assert ADAPTERS["OPENAI_COMPATIBLE"].input_rate == 24000


# ---------------- 上游断句参数（improve-speech-endpointing-and-live-ux 2.3 / D8） ----------------


def test_turn_detection_by_provider_and_override():
    from app.interpret.realtime_chat import ADAPTERS
    from app.speech.engines import DASHSCOPE, OPENAI_COMPATIBLE
    from tests.speech_fakes import model_config

    dash, oai = ADAPTERS[DASHSCOPE], ADAPTERS[OPENAI_COMPATIBLE]
    flash = model_config(provider=DASHSCOPE, model_name="qwen3-omni-flash-realtime", capability="REALTIME_CHAT")
    assert dash.session("i", "Cherry", flash)["turn_detection"] == {
        "type": "server_vad",
        "threshold": 0.5,
        "silence_duration_ms": 800,
    }
    plus = model_config(provider=DASHSCOPE, model_name="qwen3.5-omni-plus-realtime", capability="REALTIME_CHAT")
    assert dash.session("i", "Cherry", plus)["turn_detection"] == {"type": "semantic_vad"}
    forced = model_config(
        provider=DASHSCOPE,
        model_name="qwen3.5-omni-plus-realtime",
        capability="REALTIME_CHAT",
        params={"extra": {"turnDetection": "server"}},
    )
    assert dash.session("i", "Cherry", forced)["turn_detection"]["type"] == "server_vad"
    gpt = model_config(provider=OPENAI_COMPATIBLE, model_name="gpt-realtime", capability="REALTIME_CHAT")
    assert oai.session("i", "alloy", gpt)["turn_detection"] == {"type": "semantic_vad", "eagerness": "low"}
