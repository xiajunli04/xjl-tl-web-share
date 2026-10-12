"""分段语音合成流水线（improve-speech-playback-latency 2.3）。"""

import asyncio
import base64
from collections.abc import AsyncIterator

from app.interpret.engine import AudioSequencer
from app.interpret.pipeline import AUDIO_CHUNK_BYTES, SpeechPipeline
from app.speech.tts import tts_failed
from tests.speech_fakes import Collector


class ScriptTTS:
    """按文本给出（每包延迟, 包数, 包大小）；fail 中的文本合成失败。"""

    format = "mp3"

    def __init__(self, plan: dict[str, tuple[float, int, int]], fail: set[str] = frozenset(), fail_after_first=False):
        self.plan, self.fail, self.fail_after_first = plan, fail, fail_after_first
        self.active = 0
        self.peak = 0
        self.started: list[str] = []

    async def stream(self, text: str, voice: str, rate: float = 1.0) -> AsyncIterator[bytes]:
        self.started.append(text)
        self.active += 1
        self.peak = max(self.peak, self.active)
        try:
            delay, n, size = self.plan[text]
            if text in self.fail and not self.fail_after_first:
                await asyncio.sleep(delay)
                raise tts_failed("Edge 语音合成失败（HTTP 403）", 403)
            for _ in range(n):
                await asyncio.sleep(delay)
                yield bytes([ord(text[0]) % 256]) * size
                if text in self.fail and self.fail_after_first:
                    raise tts_failed("中断")
        finally:
            self.active -= 1


def _audio(out: Collector):
    return [
        (
            e["seg"],
            e["segLast"],
            e["last"],
            (base64.b64decode(e["data"])[:1] or b"").decode() or "",
            len(base64.b64decode(e["data"])),
        )
        for e in out.of("audio")
    ]


def _pipeline(tts, out, **kw):
    seq = AudioSequencer(out)
    seq.open(1, ["en"])
    return seq, SpeechPipeline(tts, seq, 1, "en", "v", **kw)


async def test_segments_delivered_in_order_and_first_chunk_immediate():
    tts = ScriptTTS({"A": (0.05, 3, 100), "B": (0.001, 2, 100), "C": (0.001, 1, 100)})
    out = Collector()
    first_ms = []
    seq, pipe = _pipeline(tts, out, on_first_audio=first_ms.append)
    for t in "ABC":
        pipe.add(t)
    await asyncio.sleep(0.06)
    assert _audio(out) == [(0, False, False, "A", 100)]  # A 的首包已发出，B 虽已合成完也要排在 A 之后
    await pipe.close()
    seq.end(1, "en")
    assert _audio(out) == [
        (0, False, False, "A", 100),
        (0, True, False, "A", 200),  # 后续合并、段尾标记
        (1, False, False, "B", 100),
        (1, True, False, "B", 100),
        (2, False, False, "C", 100),
        (2, True, False, "", 0),  # 段尾缓冲已空：空段尾标记
        (3, False, True, "", 0),  # 终止包
    ]
    assert len(first_ms) == 1 and tts.peak == 2  # 最多 2 路并发


async def test_coalesces_to_chunk_size():
    tts = ScriptTTS({"A": (0.001, 5, AUDIO_CHUNK_BYTES // 2)})
    out = Collector()
    seq, pipe = _pipeline(tts, out)
    pipe.add("A")
    await pipe.close()
    sizes = [n for *_, n in _audio(out)]
    assert sizes == [AUDIO_CHUNK_BYTES // 2, AUDIO_CHUNK_BYTES, AUDIO_CHUNK_BYTES]  # 段尾落在最后一包数据上


async def test_failure_before_any_audio_cancels_rest():
    tts = ScriptTTS({"A": (0.03, 1, 10), "B": (0.001, 1, 10)}, fail={"A"})
    out = Collector()
    errors = []
    seq, pipe = _pipeline(tts, out, on_error=lambda m, before: errors.append((m, before)))
    pipe.add("A")
    pipe.add("B")  # B 先合成完、已缓存，但 A 失败时整句放弃
    await pipe.close()
    pipe.add("C")  # 失败后不再接收新段
    seq.end(1, "en")
    assert out.of("audio") == [] and errors == [("Edge 语音合成失败（HTTP 403）", True)]
    assert pipe.failed and "C" not in tts.started


async def test_failure_after_audio_keeps_played_part():
    tts = ScriptTTS({"A": (0.001, 2, 10), "B": (0.001, 2, 10)}, fail={"B"}, fail_after_first=True)
    out = Collector()
    errors = []
    seq, pipe = _pipeline(tts, out, concurrency=1, on_error=lambda m, before: errors.append(before))
    pipe.add("A")
    pipe.add("B")
    await pipe.close()
    assert [d for _, _, _, d, _ in _audio(out)][:2] == ["A", "A"] and errors == [False]


async def test_cancel_stops_audio():
    tts = ScriptTTS({"A": (0.02, 5, 10)})
    out = Collector()
    seq, pipe = _pipeline(tts, out)
    pipe.add("A")
    await asyncio.sleep(0.03)
    await pipe.cancel()
    n = len(out.of("audio"))
    await asyncio.sleep(0.05)
    assert n >= 1 and len(out.of("audio")) == n
