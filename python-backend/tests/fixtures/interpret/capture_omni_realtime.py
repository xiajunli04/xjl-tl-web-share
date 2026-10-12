"""抓取百炼 Omni Realtime 的真实事件序列（improve-speech-playback-latency 4.1）。

用法（密钥取自仓库根目录 .env 的 TEST_DASHSCOPE_API_KEY，不写入输出）：
    uv run python tests/fixtures/interpret/capture_omni_realtime.py [模型名 ...]

流程：session.update → response.create（开场白）→ 推送一句中文 + 静音（服务端 VAD 判句末）→ 等回复开始后
response.cancel（打断）→ 再推送一句 → 等回复完成 → 结束。事件写入 omni_realtime_events.jsonl，
音频 delta 只记录字节数。
"""

import asyncio
import base64
import json
import sys
import time
import wave
from pathlib import Path

from websockets.asyncio.client import connect

HERE = Path(__file__).parent
ROOT = HERE.parents[2].parent
URL = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model={model}"
WAV = ROOT / "evaluation" / "data" / "speech" / "audio" / "zh-03.wav"
WAV2 = ROOT / "evaluation" / "data" / "speech" / "audio" / "zh-02.wav"


def _key() -> str:
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        if line.startswith("TEST_DASHSCOPE_API_KEY="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("缺少 TEST_DASHSCOPE_API_KEY")


def _pcm(path: Path) -> bytes:
    with wave.open(str(path), "rb") as w:
        return w.readframes(w.getnframes())


async def capture(model: str) -> list[dict]:
    events: list[dict] = []
    t0 = time.perf_counter()

    def log(direction: str, ev: dict) -> None:
        ev = dict(ev)
        if isinstance(ev.get("delta"), str) and ev["type"].endswith("audio.delta"):
            ev["delta"] = f"<{len(base64.b64decode(ev['delta']))} bytes>"
        if ev.get("type") == "input_audio_buffer.append":
            return
        ev["_dir"], ev["_t"] = direction, round(time.perf_counter() - t0, 3)
        events.append(ev)
        brief = {k: v for k, v in ev.items() if k not in ("session",)}
        print(json.dumps(brief, ensure_ascii=False)[:220])

    async with connect(
        URL.format(model=model), additional_headers={"Authorization": f"Bearer {_key()}"}, max_size=None
    ) as ws:

        async def send(ev: dict) -> None:
            log("send", ev)
            await ws.send(json.dumps(ev))

        async def append(pcm: bytes) -> None:
            for i in range(0, len(pcm), 3200):
                await ws.send(
                    json.dumps(
                        {"type": "input_audio_buffer.append", "audio": base64.b64encode(pcm[i : i + 3200]).decode()}
                    )
                )
                await asyncio.sleep(0.1)

        done = asyncio.Event()
        responses: list[str] = []

        async def reader() -> None:
            async for raw in ws:
                ev = json.loads(raw)
                log("recv", ev)
                if ev["type"] == "response.created":
                    responses.append(ev["response"]["id"])
                if ev["type"] == "response.done":
                    done.set()
                if ev["type"] == "error":
                    done.set()

        task = asyncio.create_task(reader())
        await send(
            {
                "type": "session.update",
                "session": {
                    "modalities": ["text", "audio"],
                    "voice": "Cherry",
                    "input_audio_format": "pcm16",
                    "output_audio_format": "pcm24",
                    "instructions": "你是餐厅服务员 Lumi，始终只用英语回复，口语化，1–3 句。",
                    "input_audio_transcription": {"model": "gummy-realtime-v1"},
                    "turn_detection": {"type": "server_vad", "threshold": 0.5, "silence_duration_ms": 500},
                },
            }
        )
        await asyncio.sleep(1.0)
        if any(e["type"] == "error" for e in events):
            task.cancel()
            return events
        # 1) 开场白
        done.clear()
        await send({"type": "response.create", "response": {"instructions": "先开口欢迎客人，一句话。"}})
        await asyncio.wait_for(done.wait(), 30)
        # 2) 一句中文 + 静音 → 服务端 VAD → 自动回复；回复开始出音频后打断
        done.clear()
        n = len(responses)
        await append(_pcm(WAV) + b"\x00" * 32000)
        for _ in range(200):
            if len(responses) > n and any(e["type"] == "response.audio.delta" for e in events[-20:]):
                break
            await asyncio.sleep(0.05)
        await send({"type": "response.cancel"})
        await asyncio.sleep(1.5)
        # 3) 再说一句，等完整回复
        done.clear()
        await append(_pcm(WAV2) + b"\x00" * 32000)
        await asyncio.wait_for(done.wait(), 30)
        await asyncio.sleep(0.5)
        task.cancel()
    return events


async def main() -> None:
    models = sys.argv[1:] or ["qwen3-omni-flash-realtime"]
    for model in models:
        print(f"===== {model}")
        try:
            events = await capture(model)
        except Exception as e:  # noqa: BLE001
            print(f"失败：{type(e).__name__}: {e}")
            continue
        out = HERE / "omni_realtime_events.jsonl"
        if not any(e["type"] == "error" for e in events if e["_dir"] == "recv"):
            out.write_text("\n".join(json.dumps(e, ensure_ascii=False) for e in events) + "\n", encoding="utf-8")
            print(f"已写入 {out}（{len(events)} 条）")
            return


if __name__ == "__main__":
    asyncio.run(main())
