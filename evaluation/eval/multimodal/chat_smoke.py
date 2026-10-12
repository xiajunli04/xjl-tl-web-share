"""AI 对话（CHAT）真实联调冒烟（add-ai-avatar-and-landing 3.5）。

直连 Python 内部 WS（令牌取自 .env 的 INTERNAL_TOKEN），以 restaurant 场景开始对话：
先收开场白，再按实时速度推送一段中文 WAV（默认 data/speech/audio/zh-01.wav），收集 AI 回复、中文字幕、音频与 metrics。

用法：
    uv run python -m eval.multimodal.chat_smoke [--ws ws://localhost:8000/internal/interpret/stream] [--wav 路径]
        [--engine cascade|realtime-chat] [--latency-mode balanced|fast] [--runs N]

延迟统计（improve-speech-playback-latency 0.3，均以用户语音最后一帧送出的时刻为起点）：
- replyFirstAudioMs：AI 回复的首个 audio 分包到达；
- replyFirstPlayableMs：首个“可开始播放”的音频到达——pcm16 为首包；mp3 为首个 segLast/last 分包
  （旧协议下 mp3 要等整条 track 结束才可播，新协议下按段）。
多次运行（--runs）时输出各项中位数。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import time
import wave
from pathlib import Path

from eval.config import EVAL_ROOT

FRAME_BYTES = 1280  # 40 ms @ 16 kHz PCM16


def _token() -> str:
    for line in (EVAL_ROOT.parent / ".env").read_text(encoding="utf-8").splitlines():
        if line.startswith("INTERNAL_TOKEN="):
            return line.split("=", 1)[1].strip()
    raise SystemExit(".env 中没有 INTERNAL_TOKEN")


def _pcm(path: Path) -> bytes:
    with wave.open(str(path), "rb") as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2, "需要 16 kHz 单声道 PCM16"
        return w.readframes(w.getnframes())


async def run(
    ws_url: str, wav: Path, model_config_id: int | None, engine: str = "cascade", latency_mode: str | None = None
) -> dict:
    import websockets

    config = {
        "type": "config",
        "streamId": "chat-smoke",
        "mode": "CHAT",
        "engine": engine,
        "sourceLangs": ["zh", "en"],
        "targetLangs": [],
        "modelConfigId": model_config_id,
        "tts": True,
        "chat": {"scenario": "restaurant", "myLang": "zh", "aiLang": "en", "persona": "Lumi", "greet": True},
    }
    if latency_mode:
        config["latencyMode"] = latency_mode
    events: list[dict] = []
    t_start = time.perf_counter()

    def log(ev: dict) -> None:
        ev["_t"] = round(time.perf_counter() - t_start, 2)
        events.append(ev)
        if ev["type"] != "audio" and ev["type"] != "transcript.partial":
            brief = {k: v for k, v in ev.items() if k not in ("data",)}
            print(json.dumps(brief, ensure_ascii=False))

    async with websockets.connect(ws_url, additional_headers={"X-Internal-Token": _token()}, max_size=None) as ws:
        await ws.send(json.dumps(config))

        async def reader() -> None:
            async for raw in ws:
                log(json.loads(raw))

        task = asyncio.create_task(reader())

        async def wait_metrics(n: int, timeout: float = 60) -> None:
            deadline = time.perf_counter() + timeout
            while sum(1 for e in events if e["type"] == "metrics" and e.get("role") == "assistant") < n:
                if time.perf_counter() > deadline:
                    raise TimeoutError(f"等待第 {n} 条 AI 回复超时")
                await asyncio.sleep(0.1)

        await wait_metrics(1)  # 开场白
        speech = _pcm(wav)
        pcm = speech + b"\x00" * int(16000 * 2 * 1.2)  # 句后补 1.2 s 静音让 VAD 判句末
        speech_end: float | None = None
        for i in range(0, len(pcm), FRAME_BYTES):
            await ws.send(pcm[i : i + FRAME_BYTES])
            if speech_end is None and i + FRAME_BYTES >= len(speech):
                speech_end = round(time.perf_counter() - t_start, 2)
            await asyncio.sleep(0.04)
        await wait_metrics(2)
        await ws.send(json.dumps({"type": "end"}))
        await asyncio.sleep(0.5)
        task.cancel()

    def summary(uid: int) -> dict:
        evs = [e for e in events if e.get("utteranceId") == uid]
        return {
            "text": next((e["text"] for e in evs if e["type"] == "transcript.final"), None),
            "subtitle": next((e["text"] for e in evs if e["type"] == "translation.final"), None),
            "audioChunks": sum(1 for e in evs if e["type"] == "audio"),
            "metrics": next(({k: e.get(k) for k in ("asrMs", "mtFirstMs", "ttsFirstMs", "e2eMs")}
                             for e in evs if e["type"] == "metrics"), None),
            "roles": sorted({e.get("role", "user") for e in evs}),
        }

    uids = sorted({e["utteranceId"] for e in events if "utteranceId" in e})
    result: dict = {str(u): summary(u) for u in uids}
    result["latency"] = _reply_latency(events, speech_end)
    return result


def _reply_latency(events: list[dict], speech_end: float | None) -> dict:
    """用户说完后第一条 AI 回复的首包与首个可播放音频时间（毫秒）。"""
    if speech_end is None:
        return {}
    reply_uids = [
        e["utteranceId"] for e in events
        if e.get("role") == "assistant" and e["type"] == "transcript.final" and e["_t"] >= speech_end
    ]
    if not reply_uids:
        return {}
    audio = [e for e in events if e["type"] == "audio" and e.get("utteranceId") == reply_uids[0]]
    if not audio:
        return {}
    first = audio[0]
    if first.get("format") == "pcm16":
        playable = first
    else:
        playable = next((e for e in audio if e.get("segLast") or e.get("last")), audio[-1])
    return {
        "replyFirstAudioMs": round((first["_t"] - speech_end) * 1000),
        "replyFirstPlayableMs": round((playable["_t"] - speech_end) * 1000),
    }


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--ws", default=None)
    p.add_argument("--wav", default=str(EVAL_ROOT / "data" / "speech" / "audio" / "zh-01.wav"))
    p.add_argument("--engine", default="cascade", choices=["cascade", "realtime-chat"])
    p.add_argument("--latency-mode", default=None, choices=["balanced", "fast"])
    p.add_argument("--runs", type=int, default=1)
    args = p.parse_args()
    import tomllib

    cfg = tomllib.loads((EVAL_ROOT / "config.toml").read_text(encoding="utf-8")).get("speech", {})
    ws_url = args.ws or cfg.get("ws_url", "ws://localhost:8000/internal/interpret/stream")
    model_id = cfg.get("mt_model_config_id") if args.engine == "cascade" else None
    runs = []
    for i in range(args.runs):
        result = asyncio.run(run(ws_url, Path(args.wav), model_id, args.engine, args.latency_mode))
        print(f"\n=== 第 {i + 1} 次汇总 ===")
        print(json.dumps(result, ensure_ascii=False, indent=2))
        runs.append(result)
    if args.runs > 1:
        print("\n=== 中位数 ===")
        print(json.dumps(_medians(runs), ensure_ascii=False, indent=2))


def _medians(runs: list[dict]) -> dict:
    """各次运行的延迟中位数：回复首包/可播放，以及用户说完后那条回复的 metrics（ttsFirstMs、e2eMs 等）。"""
    samples: dict[str, list[float]] = {}
    for r in runs:
        for k, v in r.get("latency", {}).items():
            samples.setdefault(k, []).append(v)
        replies = [v for k, v in r.items() if k != "latency" and "assistant" in v.get("roles", [])]
        if len(replies) >= 2 and replies[1]["metrics"]:  # 第 1 条为开场白
            for k, v in replies[1]["metrics"].items():
                if v is not None:
                    samples.setdefault(f"reply.{k}", []).append(v)
    return {k: statistics.median(v) for k, v in samples.items()}


if __name__ == "__main__":
    main()
