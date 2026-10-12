"""AI 对话断线续聊、对话记忆与双向对话问答指代的真实联调（improve-prompts-and-context-memory 7.1）。

经 Spring 对外接口走完整链路（REST 建会话 → /ws/interpret 推流 → Spring 转发 Python → 真实 ASR / LLM）：
1. 以 free 场景（zh → en）开始 AI 对话，先收开场白；
2. 按实时速度推送脚本中的几句中文语音（edge-tts 合成并缓存），每句等 AI 回复完成；
3. 模拟刷新页面：直接关闭 WS，重取票据后在宽限期内重连，再问一句依赖前文的话；
4. 检查：重连后没有新的开场白；AI 的回复用上了第 1 句中的信息；浏览器始终没有收到 memory 事件。

双向对话（--scenario converse）：A 用中文问"这个报价包含运费吗"，B 用英文答 "No, that's extra."，
检查 B 这句的中文译文结合了 A 的提问（运费另算、额外收费一类，而不是译成"那是多余的"）。

结果写入 results/prompt/manual/。用法：
    uv run python -m eval.multimodal.chat_resume_smoke --base-url http://localhost:18090 [--model-config-id 2]
        [--origin http://localhost:3000] [--scenario chat|converse|all]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import tempfile
import time
from pathlib import Path
from typing import Any

from eval.client import PlatformClient
from eval.config import RESULTS_DIR
from eval.multimodal.speech_dataset import _synth_one, _to_wav, read_pcm16

FRAME_BYTES = 1280  # 40 ms @ 16 kHz PCM16
VOICE = "zh-CN-XiaoxiaoNeural"
VOICE_EN = "en-US-JennyNeural"
OUT = RESULTS_DIR / "prompt" / "manual"
BEFORE = ["我叫小林，下个月要去大阪出差。", "大阪有什么好吃的推荐吗？", "那里的地铁方便吗？"]
AFTER = "你还记得我叫什么、下个月要去哪个城市吗？"


async def wav_of(text: str, idx: str, voice: str = VOICE) -> bytes:
    audio = OUT / "audio"
    audio.mkdir(parents=True, exist_ok=True)
    wav = audio / f"{idx}.wav"
    if not wav.exists():
        with tempfile.TemporaryDirectory() as tmp:
            mp3 = Path(tmp) / "a.mp3"
            await _synth_one(text, voice, mp3)
            _to_wav(mp3, wav)
    return read_pcm16(wav)


class Socket:
    def __init__(self, ws: Any):
        self.ws = ws
        self.events: list[dict] = []

    async def next(self, pred, timeout: float) -> dict | None:
        deadline = time.monotonic() + timeout
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                return None
            try:
                raw = await asyncio.wait_for(self.ws.recv(), left)
            except TimeoutError:
                return None
            if isinstance(raw, bytes):
                continue
            ev = json.loads(raw)
            self.events.append(ev)
            if pred(ev):
                return ev

    async def speak(self, pcm: bytes) -> None:
        silence = b"\x00\x00" * 16000  # 1 s 静音，让 VAD 判定句末
        data = pcm + silence
        for i in range(0, len(data), FRAME_BYTES):
            await self.ws.send(data[i : i + FRAME_BYTES])
            await asyncio.sleep(0.04)

    async def reply(self, timeout: float = 90) -> dict | None:
        """等一条 AI 回复的 transcript.final（role=assistant）及其 metrics。"""
        final = await self.next(lambda e: e.get("type") == "transcript.final" and e.get("role") == "assistant", timeout)
        if final is not None:
            uid = final["utteranceId"]
            await self.next(lambda e: e.get("type") == "metrics" and e.get("utteranceId") == uid, 30)
        return final


async def run(base_url: str, model_config_id: int | None, origin: str) -> dict:
    import websockets

    client = PlatformClient(base_url=base_url)
    client.login()
    req = {"mode": "CHAT", "engine": "cascade", "languages": ["zh", "en"], "chatScenario": "free", "tts": False}
    if model_config_id:
        req["modelConfigId"] = model_config_id
    vo = client.request("POST", "/api/interpret/sessions", json=req)
    sid = vo["sessionId"]
    ws_base = base_url.replace("http", "ws", 1) + "/ws/interpret?ticket="
    record: dict[str, Any] = {"sessionId": sid, "turns": []}
    try:
        async with websockets.connect(ws_base + vo["wsTicket"], origin=origin, max_size=None) as raw:
            s = Socket(raw)
            await s.next(lambda e: e.get("type") == "ready", 15)
            await s.speak(b"\x00\x00" * 1600)  # 首帧音频建立发言流，触发开场白
            greeting = await s.reply()
            record["greeting"] = greeting and greeting["text"]
            for i, text in enumerate(BEFORE, 1):
                await s.speak(await wav_of(text, f"before{i}"))
                user = await s.next(lambda e: e.get("type") == "transcript.final" and e.get("role") is None, 60)
                reply = await s.reply()
                record["turns"].append({"say": text, "asr": user and user["text"], "reply": reply and reply["text"]})
            first_memory = [e for e in s.events if e.get("type") == "memory"]
        # 模拟刷新页面：连接已关闭；宽限期内重取票据并重连
        await asyncio.sleep(2)
        again = client.request("POST", f"/api/interpret/sessions/{sid}/ticket")
        async with websockets.connect(ws_base + again["wsTicket"], origin=origin, max_size=None) as raw:
            s2 = Socket(raw)
            await s2.next(lambda e: e.get("type") == "ready", 15)
            await s2.speak(b"\x00\x00" * 1600)
            regreet = await s2.next(lambda e: e.get("type") == "transcript.final" and e.get("role") == "assistant", 8)
            await s2.speak(await wav_of(AFTER, "after"))
            user = await s2.next(lambda e: e.get("type") == "transcript.final" and e.get("role") is None, 60)
            reply = await s2.reply()
            record["resume"] = {
                "say": AFTER,
                "asr": user and user["text"],
                "reply": reply and reply["text"],
                "greetedAgain": regreet is not None,
                "memoryEventsToBrowser": len(first_memory) + len([e for e in s2.events if e.get("type") == "memory"]),
            }
    finally:
        client.request("POST", f"/api/interpret/sessions/{sid}/end")
        client.close()
    text = (record["resume"]["reply"] or "").lower()
    record["checks"] = {
        "noGreetingAfterReconnect": not record["resume"]["greetedAgain"],
        "remembersName": "lin" in text or "小林" in text,
        "remembersCity": "osaka" in text or "大阪" in text,
        "noMemoryEventToBrowser": record["resume"]["memoryEventsToBrowser"] == 0,
    }
    return record


async def run_converse(base_url: str, model_config_id: int | None, origin: str) -> dict:
    import websockets

    client = PlatformClient(base_url=base_url)
    client.login()
    req = {"mode": "CONVERSE", "engine": "cascade", "languages": ["zh", "en"], "tts": False}
    if model_config_id:
        req["modelConfigId"] = model_config_id
    vo = client.request("POST", "/api/interpret/sessions", json=req)
    sid = vo["sessionId"]
    lines = [("这个报价包含运费吗？", "zh", "en", VOICE), ("No, that's extra.", "en", "zh", VOICE_EN)]
    record: dict[str, Any] = {"sessionId": sid, "lines": []}
    try:
        url = base_url.replace("http", "ws", 1) + "/ws/interpret?ticket=" + vo["wsTicket"]
        async with websockets.connect(url, origin=origin, max_size=None) as raw:
            s = Socket(raw)
            await s.next(lambda e: e.get("type") == "ready", 15)
            for i, (text, _src, tgt, voice) in enumerate(lines, 1):
                await s.speak(await wav_of(text, f"converse{i}", voice))
                user = await s.next(lambda e: e.get("type") == "transcript.final", 60)
                tr = await s.next(lambda e, t=tgt: e.get("type") == "translation.final" and e.get("lang") == t, 60)
                record["lines"].append(
                    {
                        "say": text,
                        "asr": user and user["text"],
                        "lang": user and user["lang"],
                        "translation": tr and tr["text"],
                    }
                )
    finally:
        client.request("POST", f"/api/interpret/sessions/{sid}/end")
        client.close()
    answer = record["lines"][-1]["translation"] or ""
    # 结合提问应译成"运费另算 / 额外收费"一类，而不是脱离语境的"那是多余的"
    record["checks"] = {"answerUsesQuestionContext": any(k in answer for k in ("运费", "另", "收费", "费用"))}
    return record


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--base-url", default="http://localhost:18090")
    p.add_argument("--model-config-id", type=int, default=None)
    p.add_argument("--origin", default="http://localhost:3000", help="须在 Spring 的 WEB_ORIGIN 内")
    p.add_argument("--scenario", choices=["chat", "converse", "all"], default="all")
    a = p.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    runs = {"chat": (run, "chat_resume.json"), "converse": (run_converse, "converse_context.json")}
    for name, (fn, file) in runs.items():
        if a.scenario not in (name, "all"):
            continue
        record = asyncio.run(fn(a.base_url, a.model_config_id, a.origin))
        (OUT / file).write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(record, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
