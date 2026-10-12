"""AI 回复的母语字幕（improve-speech-playback-latency D5）：逐句并行翻译，按句序以 translation.delta 追加。

translation.delta 在前端是追加语义，因此并行翻译的结果不能直接流式交错发出：每句译完后，
等前面各句都已发出再按序追加（第 2 句先译完也要等第 1 句）。全部完成后发 translation.final；
单句翻译失败时用原文占位并发非致命错误。级联 AI 对话与实时语音模型引擎共用。
翻译函数同时拿到本条回复中这一句之前的句子，用作字幕提示词的上下文（improve-prompts-and-context-memory D2）。
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable

from app.core.errors import BizException, ErrorCode
from app.llm.base import LLMError

log = logging.getLogger("app.interpret.subtitles")

CJK_LANGS = ("zh", "ja", "ko", "yue")  # 字幕句间不加空格

Translate = Callable[[str, str, str, list[str]], Awaitable[str]]  # (句子, 源语种, 目标语种, 前面的句子) → 译文


class Subtitles:
    def __init__(
        self,
        emit: Callable[..., None],
        emit_error: Callable[[ErrorCode, str], None],
        translate: Translate,
        uid: int,
        source: str,
        target: str,
    ):
        self._emit = emit
        self._emit_error = emit_error
        self._translate_fn = translate
        self._uid = uid
        self._source = source
        self._target = target
        self._joiner = "" if target in CJK_LANGS else " "
        self._tasks: list[asyncio.Task] = []
        self._results: list[str | None] = []
        self._sentences: list[str] = []
        self._released = 0  # 已按序发出的句数

    def add(self, sentence: str) -> None:
        idx = len(self._results)
        prev = list(self._sentences)
        self._sentences.append(sentence)
        self._results.append(None)
        self._tasks.append(asyncio.create_task(self._translate(idx, sentence, prev)))

    async def finish(self) -> None:
        if not self._tasks:
            return
        await asyncio.gather(*self._tasks, return_exceptions=True)
        text = self._joiner.join(r for r in self._results if r).strip()
        if text:
            self._emit("translation.final", utteranceId=self._uid, lang=self._target, text=text, ttsFallback=False)

    async def cancel(self) -> None:
        pending = [t for t in self._tasks if not t.done()]
        for t in pending:
            t.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

    async def _translate(self, idx: int, sentence: str, prev: list[str]) -> None:
        try:
            text = await self._translate_fn(sentence, self._source, self._target, prev)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 - 单句字幕失败不影响对话，用原文占位
            log.warning("AI 回复字幕翻译失败 uid=%s idx=%s", self._uid, idx, exc_info=True)
            message = e.message if isinstance(e, BizException | LLMError) else "字幕翻译失败"
            self._emit_error(ErrorCode.LLM_CALL_FAILED, f"字幕翻译失败：{message}")
            text = ""
        self._results[idx] = text or sentence
        self._release()

    def _release(self) -> None:
        while self._released < len(self._results) and self._results[self._released] is not None:
            piece = self._results[self._released]
            delta = piece if self._released == 0 or not self._joiner else self._joiner + piece
            self._emit("translation.delta", utteranceId=self._uid, lang=self._target, delta=delta)
            self._released += 1
