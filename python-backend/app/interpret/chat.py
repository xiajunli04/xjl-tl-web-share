"""AI 对话（CHAT）引擎（add-ai-avatar-and-landing D6）：在级联识别链路上把"翻译"换成"对话回复"。

- 用户句：沿用级联 VAD → ASR，只发 transcript.partial/final 与仅含 asrMs 的 metrics，不翻译
- AI 回复（新 utteranceId，所有事件带 role=assistant，含 AudioSequencer 发出的 audio）：
  流式 LLM → transcript.partial（累计文本）→ transcript.final(lang=aiLang) → audio 收尾
  → metrics(e2e = 用户句末 → 首段音频)
- 逐句成段（improve-speech-playback-latency D5）：回复边生成边切段（SentenceSegmenter），每段交给 SpeechPipeline 合成，
  后句合成与前句播放并行；母语字幕 translation.delta/final(lang=myLang，两种语言相同时没有) 逐句并行翻译，
  按句序以 delta 追加、全部完成后发 final，单句失败用原文占位。语音与字幕互不等待
- 开场白：发言流首次建立（chat.greet）时 AI 先开口
- 打断：interrupt 控制帧或新的用户句定稿时取消进行中的回复（LLM、字幕、TTS），发 reply.interrupted{text}，
  已生成的部分加省略号写入对话历史
- 对话记忆（improve-prompts-and-context-memory D4）：DialogMemory 维护尚未并入摘要的对话与滚动摘要；每条回复结束后
  检查是否需要压缩，需要时在后台调用一次 LLM，成功后发 memory{summary, turns}（Spring 暂存，不转发浏览器）。
  发言流重建时从 config 的 history 与 chat.memory 恢复（D5）
- 字幕（D1.1）：使用字幕提示词，上下文为用户上一句与本条回复前面的句子
- 回复让位（improve-speech-endpointing-and-live-ux D6）：客户端在回复尚未开播时检测到用户继续说话，发
  interrupt{yield:true} → 取消该回复，发 transcript.discard（role=assistant），此后该 uid 不再有任何事件；回复不写入
  对话记忆。用户随后定稿的新句与上一句相邻，提示词规范化时合并为一轮；续说被丢弃（噪声）或 chat_yield_resume_seconds
  内没有新句定稿时，为上一句重新生成回复
- 纯语气词 / 噪声的用户句由两段式断句丢弃，不触发回复
"""

import asyncio
import contextlib
import logging
import time
from collections.abc import Callable
from typing import Any

from app.core.errors import ErrorCode
from app.llm.base import ChatMessage, ChatRequest, LLMError

from .cascade import CascadeEngine
from .chat_prompts import (
    INTERRUPTED_MARK,
    PROMPT_VERSION,
    REPLY_MAX_TOKENS,
    REPLY_TEMPERATURE,
    build_messages,
    turn_hint,
)
from .dialog_memory import DialogMemory, compress, new_memory
from .engine import AudioSequencer, Event, UtteranceMetrics, ms_since
from .interpret_prompts import subtitle_messages
from .pipeline import SpeechPipeline
from .segmenter import SentenceSegmenter, split_sentences  # noqa: F401 - split_sentences 兼容旧导入
from .subtitles import Subtitles

log = logging.getLogger("app.interpret.chat")

ROLE_ASSISTANT = "assistant"


class _Reply:
    """一条进行中的 AI 回复。"""

    def __init__(self, uid: int, metrics: UtteranceMetrics, user_text: str | None = None):
        self.uid = uid
        self.metrics = metrics
        self.user_text = user_text  # 本条回复针对的用户句（开场白为 None）
        self.text = ""
        self.final_emitted = False
        self.task: asyncio.Task | None = None
        self.memory_msg: ChatMessage | None = None  # 写入对话记忆的那条消息（让位时撤回）


class CascadeChatEngine(CascadeEngine):
    def __init__(self, cfg, emit, deps):
        super().__init__(cfg, emit, deps)
        self._chat = cfg.chat
        self._user_lang: str | None = None  # 最近一句用户话的语种（本轮提示据此判断是否用母语提问）
        self._memory: DialogMemory = new_memory(deps.settings)
        self._memory.seed(
            [ChatMessage(role=h.role, content=h.text) for h in cfg.history], cfg.chat.memory if cfg.chat else None
        )
        self._ai_uids: set[int] = set()
        self._reply: _Reply | None = None
        self._last_reply: _Reply | None = None  # 最近一条回复（可能已生成完、客户端尚未开播）
        self._last_ai_uid: int | None = None
        self._withdrawn: set[int] = set()  # 已让位撤回的回复：之后不再发出该 uid 的任何事件
        self._yielded: _Reply | None = None  # 让位后等待恢复的回复
        self._yield_timer: asyncio.TimerHandle | None = None
        inner = self._emit_fn

        def emit_tagged(ev: Event) -> None:
            uid = ev.get("utteranceId")
            if uid in self._withdrawn:
                return
            if uid in self._ai_uids:
                ev = {**ev, "role": ROLE_ASSISTANT}
            inner(ev)

        self._emit_fn = emit_tagged
        self.sequencer = AudioSequencer(emit_tagged)  # AI 句的 audio 同样打上 role

    # ---------------- 生命周期 ----------------

    @property
    def _dialog(self) -> list[ChatMessage]:
        return self._memory.history()

    async def start(self) -> None:
        await super().start()
        log.info(
            "AI 对话开始 stream=%s prompt=%s restored=%s memory=%s",
            self.cfg.stream_id,
            PROMPT_VERSION,
            len(self._memory.history()),
            bool(self._memory.summary),
        )
        if self._chat.greet:
            self._start_reply(None, time.perf_counter())

    async def control(self, msg: dict[str, Any]) -> None:
        if msg.get("type") == "interrupt":
            if msg.get("yield"):
                self.yield_reply()
            else:
                self.interrupt()
            return
        await super().control(msg)

    async def close(self) -> None:
        if self._yield_timer is not None:
            self._yield_timer.cancel()
        await super().close()

    # ---------------- 用户句 ----------------

    async def _route(self, text: str, detected: str | None, side: str | None) -> tuple[str, list[str]]:
        my, ai = self._chat.my_lang, self._chat.ai_lang
        if my == ai:
            return my, []
        if detected in (my, ai):
            return detected, []
        return (await self.detect_lang(text, (my, ai)) or my), []

    def _after_final(self, uid: int, text: str, source: str, t0: float) -> None:
        # 用户插话：先打断仍在进行的回复，再回应新的一句
        if self._reply is not None:
            self.interrupt()
        self._clear_yield()  # 让位后的续说已定稿：与上一句合并为一轮回应
        self._user_lang = source
        self._memory.append(ChatMessage(role="user", content=text))
        self._start_reply(text, t0)

    # ---------------- 回复 ----------------

    def _start_reply(self, user_text: str | None, t0: float) -> None:
        uid = self.next_uid()
        self._ai_uids.add(uid)
        self._last_ai_uid = uid
        reply = _Reply(uid, UtteranceMetrics(t0=t0), user_text)
        self._last_reply = reply
        speak = self._tts is not None
        fmt, rate = (self._tts.format, self._tts.sample_rate) if self._tts else ("mp3", 24000)
        if speak:
            # 播报时 metrics 在音频发完后由 sequencer 回调发出；不播报时在回复结束时发出（见 _run_reply）
            self.sequencer.open(
                uid,
                [self._chat.ai_lang],
                fmt,
                rate,
                on_done=lambda first_audio: self._emit_fn(reply.metrics.to_event(uid, first_audio)),
            )
        self._reply = reply
        reply.task = self._spawn(self._run_reply(reply, user_text))

    async def _run_reply(self, reply: _Reply, user_text: str | None) -> None:
        ai, my = self._chat.ai_lang, self._chat.my_lang
        pipe = self._pipeline(reply.uid, reply.metrics, ai) if self._tts is not None else None
        subtitles = self._subtitles(reply.uid, ai, my, user_text) if my != ai else None

        def on_segment(text: str) -> None:
            if pipe is not None:
                pipe.add(text)
            if subtitles is not None:
                subtitles.add(text)

        closed = False
        try:
            try:
                await self._generate(reply, user_text, on_segment)
            except LLMError as e:
                self.emit_error(e.error_code, f"AI 回复失败：{e.message}")
            except Exception:
                log.exception("AI 回复失败 stream=%s", self.cfg.stream_id)
                self.emit_error(ErrorCode.LLM_CALL_FAILED, "AI 回复失败")
            text = reply.text.strip()
            if not text:
                return
            fallback = self._tts_wanted and (pipe is None or pipe.fallback_needed)
            self._emit_final(reply, fallback=fallback)
            reply.memory_msg = ChatMessage(role="assistant", content=text)
            self._memory.append(reply.memory_msg)
            self._maybe_compress()
            if subtitles is not None:
                await subtitles.finish()
            if pipe is not None:
                await pipe.close()
                closed = True
                if pipe.fallback_needed and not fallback:
                    # 定稿时合成尚未失败、之后在出声前失败：补发一次带降级标记的定稿，前端改用浏览器朗读
                    self.emit("transcript.final", utteranceId=reply.uid, text=text, lang=ai, ttsFallback=True)
        finally:
            if subtitles is not None:
                await subtitles.cancel()
            if pipe is not None and not closed:
                await pipe.cancel()
            if self._tts is not None:
                self.sequencer.end(reply.uid, ai)
            else:
                self._emit_fn(reply.metrics.to_event(reply.uid, None))
            if self._reply is reply:
                self._reply = None

    def _subtitles(self, uid: int, source: str, target: str, user_text: str | None) -> Subtitles:
        async def translate(text: str, src: str, tgt: str, prev: list[str]) -> str:
            messages = subtitle_messages(user_text, prev, text, src, tgt, self._chat.persona)
            return await self._translate(uid, messages, tgt, UtteranceMetrics(t0=0.0), emit_deltas=False)

        return Subtitles(self.emit, self.emit_error, translate, uid, source, target)

    def _pipeline(self, uid: int, metrics: UtteranceMetrics, lang: str) -> SpeechPipeline:
        tts = self._tts
        return SpeechPipeline(
            tts,
            self.sequencer,
            uid,
            lang,
            tts.resolve_voice(lang, self.cfg.voices.get(lang), self.cfg.gender),
            concurrency=self.deps.settings.interpret_tts_concurrency,
            first_timeout=self.deps.settings.edge_tts_timeout_seconds,
            on_first_audio=metrics.tts_first.append,
            on_error=lambda message, _before_audio: self.emit_error(ErrorCode.TTS_FAILED, message),
        )

    async def _generate(self, reply: _Reply, user_text: str | None, on_segment: Callable[[str], None]) -> None:
        chat = self._chat
        history = self._memory.history()
        if user_text is not None and history and history[-1].role == "user":
            history = history[:-1]  # 本轮用户句由 build_messages 追加
        last_reply = next((m.content for m in reversed(history) if m.role == "assistant"), None)
        hint = turn_hint(user_text, self._user_lang, last_reply, chat.my_lang, chat.ai_lang)
        extra: dict[str, Any] = {}
        effort = self._llm.config.extra.get("reasoningEffort")
        if effort and self._llm.config.provider == "OPENAI_COMPATIBLE":
            extra["reasoning_effort"] = effort
        req = ChatRequest(
            messages=build_messages(
                chat.scenario, chat.my_lang, chat.ai_lang, history, user_text, chat.persona, self._memory.summary, hint
            ),
            temperature=REPLY_TEMPERATURE,
            max_tokens=REPLY_MAX_TOKENS,
            extra=extra,
        )
        segmenter = SentenceSegmenter(self._seg_first_min, self.deps.settings.interpret_seg_min_chars)
        start = time.perf_counter()
        completed = False
        try:
            async with contextlib.aclosing(self._llm.client.stream(req)) as stream:
                async for chunk in stream:
                    if not chunk.delta:
                        continue
                    if not reply.text:
                        reply.metrics.mt_first.append(ms_since(start))
                    reply.text += chunk.delta
                    self.emit("transcript.partial", utteranceId=reply.uid, text=reply.text.strip())
                    for piece in segmenter.feed(chunk.delta):
                        on_segment(piece)
            reply.metrics.mt_total.append(ms_since(start))
            completed = True
        finally:
            # 正常结束或生成中途出错时，剩余文本照常播报；被取消（打断）时不再追加
            rest = segmenter.flush()
            if rest is not None and (completed or not asyncio.current_task().cancelling()):
                on_segment(rest)

    def _emit_final(self, reply: _Reply, fallback: bool = False) -> None:
        if reply.final_emitted:
            return
        reply.final_emitted = True
        reply.metrics.final_emitted()
        self.emit(
            "transcript.final",
            utteranceId=reply.uid,
            text=reply.text.strip(),
            lang=self._chat.ai_lang,
            ttsFallback=fallback,
        )

    # ---------------- 打断 ----------------

    def interrupt(self) -> None:
        """取消进行中的回复；没有时针对最近一条回复回执（前端据此标记已打断）。"""
        reply = self._reply
        if reply is None:
            if self._last_ai_uid is not None:
                self.emit("reply.interrupted", utteranceId=self._last_ai_uid, text="")
            return
        self._reply = None
        text = reply.text.strip()
        if self._tts is not None:
            self.sequencer.abort(reply.uid, self._chat.ai_lang)
        if reply.task is not None:
            reply.task.cancel()
        if text:
            self._emit_final(reply)
            last = self._memory.last()
            if last is None or last.role != "assistant":
                self._memory.append(ChatMessage(role="assistant", content=text + INTERRUPTED_MARK))
        self.emit("reply.interrupted", utteranceId=reply.uid, text=text)
        log.info("AI 回复被打断 stream=%s uid=%s chars=%s", self.cfg.stream_id, reply.uid, len(text))

    # ---------------- 让位（D6） ----------------

    def yield_reply(self) -> None:
        """撤回最近一条回复（客户端尚未开播）：取消生成与合成、发 discard、不写入记忆，等待用户说完。"""
        reply = self._last_reply
        if reply is None or reply.uid in self._withdrawn:
            return
        if self._reply is reply:
            self._reply = None
            if self._tts is not None:
                self.sequencer.abort(reply.uid, self._chat.ai_lang)
            if reply.task is not None:
                reply.task.cancel()
        if reply.memory_msg is not None:
            self._memory.remove(reply.memory_msg)
        self.emit("transcript.discard", utteranceId=reply.uid)
        self._withdrawn.add(reply.uid)
        self._last_reply = None
        self._yielded = reply
        self._arm_yield_timer()
        log.info("AI 回复让位 stream=%s uid=%s chars=%s", self.cfg.stream_id, reply.uid, len(reply.text))

    def _arm_yield_timer(self) -> None:
        if self._yield_timer is not None:
            self._yield_timer.cancel()
        delay = self.deps.settings.chat_yield_resume_seconds
        self._yield_timer = asyncio.get_running_loop().call_later(delay, self._resume_yield)

    def _resume_yield(self) -> None:
        """让位后没有等到新的用户句：用户仍在说（断句未结束）就继续等，否则为原来那句重新回复。"""
        self._yield_timer = None
        reply = self._yielded
        if reply is None:
            return
        if self._ep is not None and self._ep.open:
            self._arm_yield_timer()
            return
        self._yielded = None
        log.info("让位后未等到续说，恢复回复 stream=%s", self.cfg.stream_id)
        self._start_reply(reply.user_text, time.perf_counter())

    def _clear_yield(self) -> None:
        self._yielded = None
        if self._yield_timer is not None:
            self._yield_timer.cancel()
            self._yield_timer = None

    def _after_discard(self, uid: int | None) -> None:
        # 触发让位的续说只是噪声或语气词：立即恢复回复
        if self._yielded is not None:
            if self._yield_timer is not None:
                self._yield_timer.cancel()
            self._resume_yield()

    # ---------------- 对话记忆 ----------------

    def _maybe_compress(self) -> None:
        """需要时在后台把最早的若干轮并入摘要（同一时间最多一个压缩任务），不阻塞当前回复。"""
        batch = self._memory.due()
        if batch is not None:
            self._spawn(self._compress(batch))

    async def _compress(self, batch: list[ChatMessage]) -> None:
        chat = self._chat
        summary = await compress(
            self._llm.client,
            self._memory,
            batch,
            scenario=chat.scenario,
            persona=chat.persona,
            settings=self.deps.settings,
            stream_id=self.cfg.stream_id,
        )
        if summary is not None:
            self.emit("memory", summary=summary, turns=self._memory.memorized_turns)
