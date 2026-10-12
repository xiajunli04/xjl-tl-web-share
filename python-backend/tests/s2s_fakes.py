"""可选 S2S 同传引擎的协议级模拟上游（pytest 内的 websockets.serve），供 OpenAI / Gemini / 豆包测试共用。

MockUpstream 的一次连接：
1. 收到首帧（会话配置）后：reject_setup 不为空时按其拒绝（发送错误帧或以关闭帧拒绝）；否则发出 ready 帧
2. drop 中的第 n 次连接（从 1 开始）在就绪后立即断开
3. 收到首包音频后按 script 回放 [(延迟秒, 帧)]；收到结束消息后发出 on_finish 帧，close_after_finish 时随后断开
http_status 不为空时在握手阶段直接返回该 HTTP 状态（模拟密钥无效）。
"""

import asyncio
import contextlib
from collections.abc import Callable
from http import HTTPStatus
from typing import Any

from websockets.asyncio.server import serve

from app.core.config import get_settings
from app.interpret.engine import StreamConfig
from tests.speech_fakes import Collector, StubRegistry, engine_deps, model_config

Frame = str | bytes


class MockUpstream:
    def __init__(
        self,
        *,
        decode: Callable[[Frame], Any],
        is_audio: Callable[[Any], bool],
        is_finish: Callable[[Any], bool],
        ready: list[Frame],
        script: list[tuple[float, Frame]] | None = None,
        on_finish: list[Frame] | None = None,
        close_after_finish: bool = False,
        drop: set[int] | None = None,
        reject_setup: Frame | tuple[int, str] | None = None,
        http_status: int | None = None,
    ):
        self.decode = decode
        self.is_audio = is_audio
        self.is_finish = is_finish
        self.ready = ready
        self.script = script or []
        self.on_finish = on_finish or []
        self.close_after_finish = close_after_finish
        self.drop = drop or set()
        self.reject_setup = reject_setup
        self.http_status = http_status
        self.connections: list[dict[str, Any]] = []
        self.port = 0

    def _process_request(self, connection, request):
        if self.http_status is not None:
            self.connections.append({"headers": request.headers, "path": request.path, "messages": []})
            return connection.respond(HTTPStatus(self.http_status), "rejected\n")
        return None

    async def handler(self, ws) -> None:
        conn: dict[str, Any] = {"headers": ws.request.headers, "path": ws.request.path, "messages": []}
        self.connections.append(conn)
        n = len(self.connections)
        conn["messages"].append(self.decode(await ws.recv()))
        if self.reject_setup is not None:
            if isinstance(self.reject_setup, tuple):
                await ws.close(*self.reject_setup)
            else:
                await ws.send(self.reject_setup)
                await asyncio.sleep(0.05)
            return
        for frame in self.ready:
            await ws.send(frame)
        if n in self.drop:
            await ws.close()
            return
        finished = asyncio.Event()
        first_audio = asyncio.Event()

        async def receive() -> None:
            with contextlib.suppress(Exception):
                async for raw in ws:
                    msg = self.decode(raw)
                    conn["messages"].append(msg)
                    if self.is_audio(msg):
                        first_audio.set()
                    if self.is_finish(msg):
                        finished.set()

        reader = asyncio.create_task(receive())
        try:
            if self.script:
                if not await _until(first_audio, ws, 5):
                    return
                for delay, frame in self.script:
                    if delay:
                        await asyncio.sleep(delay)
                    await ws.send(frame)
            if not await _until(finished, ws, 10):
                return
            for frame in self.on_finish:
                await ws.send(frame)
            if self.close_after_finish:
                await ws.close()
            else:
                await asyncio.wait_for(ws.wait_closed(), 10)
        except Exception:  # noqa: BLE001 - 客户端提前断开
            pass
        finally:
            reader.cancel()

    @contextlib.asynccontextmanager
    async def running(self):
        async with serve(self.handler, "127.0.0.1", 0, process_request=self._process_request) as server:
            self.port = server.sockets[0].getsockname()[1]
            yield self

    def messages(self, n: int = 0) -> list[Any]:
        return self.connections[n]["messages"]


async def _until(flag: asyncio.Event, ws, timeout: float) -> bool:
    """等到 flag 置位（返回 True）或连接关闭 / 超时（返回 False）。"""
    waiter = asyncio.create_task(flag.wait())
    closed = asyncio.create_task(ws.wait_closed())
    await asyncio.wait({waiter, closed}, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
    waiter.cancel()
    closed.cancel()
    return flag.is_set()


def s2s_config(provider: str, base_url: str, model_name: str, **extra: Any):
    return model_config(
        provider=provider,
        base_url=base_url,
        model_name=model_name,
        capability="REALTIME_TRANSLATE",
        params={"extra": extra} if extra else {},
    )


def make_s2s_engine(engine_cls, cfg_model, cfg: dict, key: str = "sk-test", glossaries=None, detect_lang="zh"):
    config = StreamConfig.model_validate({"type": "config", "engine": engine_cls.id, **cfg})
    out = Collector()
    registry = StubRegistry(configs={"REALTIME_TRANSLATE": (cfg_model, key)} if cfg_model is not None else {})
    return engine_cls(config, out, engine_deps(registry, glossaries, detect_lang=detect_lang)), out


async def wait_for(predicate, timeout: float = 5.0) -> None:
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(0.01)


def fast_timers(monkeypatch, **overrides: float) -> None:
    """缩短切句 / 结束判定的计时，加快测试。"""
    from app.interpret import s2s

    values = {
        "TICK_SECONDS": 0.02,
        "INPUT_SILENCE_SECONDS": 0.25,
        "OUTPUT_SILENCE_SECONDS": 0.25,
        "OUTPUT_WAIT_SECONDS": 1.0,
        "FINISH_IDLE_SECONDS": 0.3,
        "FINISH_QUIET_SECONDS": 0.6,
        "BACKOFF_BASE_SECONDS": 0.0,
        "FINISH_TIMEOUT_SECONDS": 3.0,
    }
    values.update(overrides)
    for name, value in values.items():
        monkeypatch.setattr(s2s, name, value)
    assert get_settings().interpret_upstream_retries >= 1


def audio_chunks(events: list[dict], uid: int) -> list[dict]:
    """该句带数据的音频分包（不含 data 为空的终止包）。"""
    return [e for e in events if e["type"] == "audio" and e["utteranceId"] == uid and e["data"]]


def assert_audio_sequence(events: list[dict], uids: list[int], sample_rate: int) -> None:
    audio = [e for e in events if e["type"] == "audio"]
    assert audio, "没有 audio 事件"
    assert {a["format"] for a in audio} == {"pcm16"} and {a["sampleRate"] for a in audio} == {sample_rate}
    for uid in uids:
        assert audio_chunks(events, uid), f"utterance {uid} 没有音频"
        mine = [a for a in audio if a["utteranceId"] == uid]
        assert [a["seq"] for a in mine] == list(range(len(mine)))
        assert [a["last"] for a in mine] == [False] * (len(mine) - 1) + [True]
        assert mine[-1]["data"] == ""  # 终止包（improve-speech-playback-latency D3）
    order = [a["utteranceId"] for a in audio]
    assert order == sorted(order)  # 不同句的音频按 utteranceId 顺序发出
