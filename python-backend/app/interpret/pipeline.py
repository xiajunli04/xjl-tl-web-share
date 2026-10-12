"""分段语音合成流水线（improve-speech-playback-latency D4 / D5）。

一个实例对应一句话的一个目标语种（级联同传的一句译文、AI 对话的一条回复）：
- add(text)：追加一段（按加入顺序编号），立即开始合成；同时进行的合成最多 concurrency 路
- 段按序交给 AudioSequencer：当前段（游标）的分包边到边推，后面的段先缓存，前一段结束后再推；
  每段首包立即推，之后合并到 AUDIO_CHUNK_BYTES 再推，段结束时把剩余部分标 segLast
- 某段合成失败：不再开始后续段，回调 on_error(message, before_audio)；before_audio 为 True 表示整句还没有任何音频
  （调用方据此让前端改用浏览器朗读）
- close()：不再追加，等所有段完成；cancel()：打断，取消进行中的合成且不再推任何音频
"""

import asyncio
import contextlib
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field

from app.core.errors import BizException

from .engine import AudioSequencer

log = logging.getLogger("app.interpret.pipeline")

AUDIO_CHUNK_BYTES = 8192  # 每段首包立即发出，之后合并到该大小再发（减少事件数）
DEFAULT_CONCURRENCY = 2


@dataclass
class _Seg:
    text: str
    buffered: list[bytes] = field(default_factory=list)  # 未轮到时缓存的分包
    pending: bytes = b""  # 已轮到、待合并发出的数据
    pushed_any: bool = False
    done: bool = False


class SpeechPipeline:
    def __init__(
        self,
        tts,
        sequencer: AudioSequencer,
        uid: int,
        lang: str,
        voice: str,
        *,
        rate: float = 1.0,
        concurrency: int = DEFAULT_CONCURRENCY,
        first_timeout: float = 15.0,
        on_first_audio: Callable[[int], None] | None = None,
        on_error: Callable[[str, bool], None] | None = None,
    ):
        self._tts = tts
        self._seq = sequencer
        self._uid = uid
        self._lang = lang
        self._voice = voice
        self._rate = rate
        self._sem = asyncio.Semaphore(max(1, concurrency))
        self._first_timeout = first_timeout
        self._on_first_audio = on_first_audio
        self._on_error = on_error
        self._segs: list[_Seg] = []
        self._tasks: list[asyncio.Task] = []
        self._cursor = 0
        self._failed = False
        self._cancelled = False
        self._any_audio = False

    @property
    def failed(self) -> bool:
        return self._failed

    @property
    def fallback_needed(self) -> bool:
        """合成失败且整句没有任何音频：调用方应改由浏览器朗读整句。"""
        return self._failed and not self._any_audio

    @property
    def segments(self) -> int:
        return len(self._segs)

    def add(self, text: str) -> None:
        text = text.strip()
        if not text or self._failed or self._cancelled:
            return
        idx = len(self._segs)
        self._segs.append(_Seg(text))
        self._tasks.append(asyncio.create_task(self._synth(idx)))

    async def close(self) -> None:
        """等所有已加入的段合成并推送完毕。"""
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)

    async def cancel(self) -> None:
        self._cancelled = True
        pending = [t for t in self._tasks if not t.done()]
        for t in pending:
            t.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

    # ---------------- 合成 ----------------

    async def _synth(self, idx: int) -> None:
        async with self._sem:
            if self._failed or self._cancelled:
                self._finish(idx)
                return
            seg = self._segs[idx]
            start = time.perf_counter()
            stream = self._tts.stream(seg.text, self._voice, self._rate)
            try:
                first = await asyncio.wait_for(anext(stream), timeout=self._first_timeout)
                if idx == 0 and self._on_first_audio is not None:
                    self._on_first_audio(int((time.perf_counter() - start) * 1000))
                self._chunk(idx, first)
                async for chunk in stream:
                    self._chunk(idx, chunk)
            except asyncio.CancelledError:
                raise
            except StopAsyncIteration:
                self._fail("语音合成未返回音频")
            except Exception as e:  # noqa: BLE001 - 合成失败非致命
                self._fail(e.message if isinstance(e, BizException) else "语音合成失败")
            finally:
                with contextlib.suppress(Exception):
                    await stream.aclose()
            self._finish(idx)

    def _fail(self, message: str) -> None:
        if self._failed or self._cancelled:
            return
        self._failed = True
        before_audio = not self._any_audio
        log.info("分段合成失败 uid=%s lang=%s before_audio=%s: %s", self._uid, self._lang, before_audio, message)
        if before_audio:
            # 整句还没出声：放弃其余段（含已缓存的后续段），由调用方整句降级为浏览器朗读，避免只播半句
            self._cancelled = True
            current = asyncio.current_task()
            for t in self._tasks:
                if t is not current and not t.done():
                    t.cancel()
        if self._on_error is not None:
            self._on_error(message, before_audio)

    # ---------------- 按序推送 ----------------

    def _chunk(self, idx: int, data: bytes) -> None:
        if self._cancelled or not data:
            return
        seg = self._segs[idx]
        if idx != self._cursor:
            seg.buffered.append(data)
            return
        self._deliver(seg, data)

    def _deliver(self, seg: _Seg, data: bytes) -> None:
        if not seg.pushed_any:
            seg.pushed_any = True
            self._any_audio = True
            self._seq.push(self._uid, self._lang, data)
            return
        # 已攒够一包时先发出旧数据、新数据留作下一包：段尾总落在有数据的包上（segLast 不必单独发空包）
        if len(seg.pending) >= AUDIO_CHUNK_BYTES:
            self._seq.push(self._uid, self._lang, seg.pending)
            seg.pending = data
        else:
            seg.pending += data

    def _finish(self, idx: int) -> None:
        self._segs[idx].done = True
        if idx == self._cursor:
            self._advance()

    def _advance(self) -> None:
        while self._cursor < len(self._segs) and not self._cancelled:
            seg = self._segs[self._cursor]
            for data in seg.buffered:
                self._deliver(seg, data)
            seg.buffered.clear()
            if not seg.done:
                return
            if seg.pending:
                self._seq.push(self._uid, self._lang, seg.pending, seg_last=True)
                seg.pending = b""
            elif seg.pushed_any:
                self._seq.end_segment(self._uid, self._lang)
            self._cursor += 1
