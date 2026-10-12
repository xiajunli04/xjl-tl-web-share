"""E6 三端链路验证（improve-speech-endpointing-and-live-ux 7.5）：经 Spring 对外接口（登录 → 创建会话 → /ws/interpret）
以实时速度推送 E6 音频，检查断句与撤回事件经 Spring 改写后的顺序、让位控制帧，以及落库结果。

前置：Python（8000）与 Spring（18080）已启动，已运行 scripts.endpoint_eval data 生成 evaluation/data/speech_pause/。
    uv run python -m eval.multimodal.e6_chain
场景：
1. 收听（目标 en）只说"嗯……"：期望出现 hold 的 partial（或直接无事件）后 transcript.discard，
   没有 transcript.final，不落库
2. 收听（目标 en）句中停顿 900 ms：记录定稿数、holdMs，落库的指标带 holdMs
3. AI 对话（zh / en）：AI 回复开始后立即发 interrupt{yield:true}，期望该回复 transcript.discard（role=assistant），
   历史中没有该回复；用户没有再开口，约 3 s 后服务端为原句重新回复（新的 utteranceId）
输出：控制台逐项结果，并写 results/multimodal/e6_chain.json
"""

from __future__ import annotations

import asyncio
import json
import time
import wave
from pathlib import Path

from eval.client import PlatformClient
from eval.config import EVAL_ROOT

PAUSE = EVAL_ROOT / "data" / "speech_pause"
OUT = EVAL_ROOT / "results" / "multimodal" / "e6_chain.json"
FRAME = 1280


def pcm(path: Path) -> bytes:
    with wave.open(str(path)) as w:
        return w.readframes(w.getnframes())


async def session(
    client: PlatformClient, body: dict, audio: bytes, *, tail_s: float = 3.0, wait_s: float = 8.0, on_event=None
) -> tuple[dict, list[dict]]:
    import websockets

    vo = client.request("POST", "/api/interpret/sessions", json=body)
    url = client.base_url.replace("http", "ws", 1) + "/ws/interpret?ticket=" + vo["wsTicket"]
    events: list[dict] = []
    async with websockets.connect(url, open_timeout=15, max_size=None) as ws:

        async def reader():
            async for raw in ws:
                if isinstance(raw, str):
                    e = json.loads(raw)
                    events.append(e)
                    if on_event is not None:
                        await on_event(ws, e)

        task = asyncio.create_task(reader())
        frames = [audio[i : i + FRAME] for i in range(0, len(audio), FRAME)] + [b"\0" * FRAME] * int(tail_s / 0.04)
        t0 = time.perf_counter()
        for n, f in enumerate(frames):
            await ws.send(f)
            await asyncio.sleep(max(0.0, t0 + (n + 1) * 0.04 - time.perf_counter()))
        await asyncio.sleep(wait_s)
        task.cancel()
    client.request("POST", f"/api/interpret/sessions/{vo['sessionId']}/end")
    return vo, events


def segments(client: PlatformClient, sid: int) -> list[dict]:
    time.sleep(1.5)
    return client.request("GET", f"/api/interpret/sessions/{sid}/segments", params={"page": 1, "pageSize": 100})[
        "records"
    ]


def kinds(events: list[dict]) -> list[str]:
    out = []
    for e in events:
        t = e["type"]
        if t in ("transcript.partial", "transcript.final", "transcript.discard", "reply.interrupted"):
            tag = t + ("(hold)" if e.get("hold") else "") + ("[ai]" if e.get("role") == "assistant" else "")
            if not out or out[-1] != tag:
                out.append(tag)
    return out


async def main_async() -> dict:
    results: dict = {}
    with PlatformClient() as c:
        c.login()
        base = {"engine": "cascade", "tts": True, "headphone": False, "gender": "female"}

        # 1. 只有语气词
        vo, ev = await session(c, {**base, "mode": "LISTEN", "languages": ["en"]}, pcm(PAUSE / "fillers" / "zh.wav"))
        segs = segments(c, vo["sessionId"])
        results["filler_only"] = {
            "events": kinds(ev),
            "finals": [e["text"] for e in ev if e["type"] == "transcript.final"],
            "discards": [e["utteranceId"] for e in ev if e["type"] == "transcript.discard"],
            "segments": len(segs),
            "pass": not any(e["type"] == "transcript.final" for e in ev) and not segs,
        }

        # 2. 句中停顿 900 ms
        vo, ev = await session(
            c, {**base, "mode": "LISTEN", "languages": ["en"]}, pcm(PAUSE / "audio" / "zh-06-v1-900.wav")
        )
        segs = segments(c, vo["sessionId"])
        results["pause_900"] = {
            "events": kinds(ev),
            "finals": [e["text"] for e in ev if e["type"] == "transcript.final"],
            "holdMs": [e.get("holdMs") for e in ev if e["type"] == "metrics"],
            "segments": [{"text": s["sourceText"], "metrics": s.get("metrics")} for s in segs],
            "pass": bool(segs) and all("holdMs" in (s.get("metrics") or {}) for s in segs),
        }

        # 3. AI 对话：回复开始后让位
        state = {"sent": False, "reply": None}

        async def yield_on_reply(ws, e):
            if (
                not state["sent"]
                and e.get("role") == "assistant"
                and e["type"] == "transcript.partial"
                and state["reply"] is None
            ):
                # 跳过开场白：只针对用户句之后的回复
                if any_user[0]:
                    state["reply"] = e["utteranceId"]
                    state["sent"] = True
                    await ws.send(json.dumps({"type": "interrupt", "yield": True}))
            if e["type"] == "transcript.final" and e.get("role") != "assistant":
                any_user[0] = True

        any_user = [False]
        body = {**base, "mode": "CHAT", "languages": ["zh", "en"], "chatScenario": "free"}
        vo, ev = await session(
            c, body, pcm(PAUSE / "audio" / "zh-02-v0.wav"), tail_s=6.0, wait_s=16.0, on_event=yield_on_reply
        )
        segs = segments(c, vo["sessionId"])
        withdrawn = state["reply"]
        results["chat_yield"] = {
            "events": kinds(ev),
            "withdrawn": withdrawn,
            "discardRole": next(
                (e.get("role") for e in ev if e["type"] == "transcript.discard" and e["utteranceId"] == withdrawn), None
            ),
            "eventsAfterDiscard": [
                e["type"]
                for e in ev[next((i for i, e in enumerate(ev) if e["type"] == "transcript.discard"), len(ev)) + 1 :]
                if e.get("utteranceId") == withdrawn
            ],
            "segmentSpeakers": [s["speakerParticipant"] for s in segs],
            "replies": [e["text"] for e in ev if e["type"] == "transcript.final" and e.get("role") == "assistant"],
        }
        r = results["chat_yield"]
        ai_after = [
            e["utteranceId"]
            for e in ev[next((i for i, e in enumerate(ev) if e["type"] == "transcript.discard"), len(ev)) + 1 :]
            if e.get("role") == "assistant" and e["type"] == "transcript.final"
        ]
        r["resumedReply"] = ai_after[0] if ai_after else None
        r["pass"] = (
            withdrawn is not None
            and r["discardRole"] == "assistant"
            and not r["eventsAfterDiscard"]
            and r["resumedReply"] not in (None, withdrawn)
            and "p1" in r["segmentSpeakers"]
        )
    OUT.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    return results


def main() -> int:
    results = asyncio.run(main_async())
    for name, r in results.items():
        print(f"[{'通过' if r['pass'] else '未通过'}] {name}: {json.dumps(r, ensure_ascii=False)}")
    return 0 if all(r["pass"] for r in results.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
