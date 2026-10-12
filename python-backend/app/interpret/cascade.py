"""平台级联同传引擎（design D4）：VAD → ASR → 翻译（TranslationContext）→ TTS。

识别（两段式断句见 app.speech.endpointing，improve-speech-endpointing-and-live-ux D1–D4）：
- 音频由单个处理协程顺序消费，交给 Endpointer：VAD 静音达到候选阈值时对"已挂起音频 + 本段"整体识别并判定是否说完
  - 说完 → transcript.final{text, lang}（yue 归为 zh）；未说完 → transcript.partial{hold:true}，等待续说，
    再开口则并入同一句；等待超时（音频时钟，另投递 _HoldExpire 做墙钟兜底）以最后一次识别结果定稿
  - 识别为空或只有语气词 → 丢弃；此前发过 partial 的发 transcript.discard{utteranceId}
  - flush / 按键松开 / 静音 / 结束时立即定稿
- 说话期间每累计 speech_partial_interval_ms 的语音，对"挂起音频 + 进行中的语音段"跑一次本地识别产生
  transcript.partial（后台任务，上一次未完成时跳过；远程转写不出 partial）
- 识别让路（D4.1）：最近约 200 ms 输入都低于静音阈值（可能即将判句末）时不发起新的 partial，避免与最终识别争 CPU
- 响应速度档位（D6）：fast 档缩短候选静音、续说等待、partial 间隔与首段合成的最小长度；CHAT 的续说等待更长
- utteranceId 在首次出 partial 或定稿时分配，流内从 1 递增；startedMs/endedMs 为音频时间轴上相对流开始的偏移
  （合并的句子取首段开始与末段结束）；metrics.holdMs 为续说等待累计时长

路由（D3）：
- LISTEN：源语种等于目标语种时只发 transcript.final（及 metrics）
- CONVERSE：按键（ptt）时以按下的一侧为源；自动时按识别语种发往另一侧，识别语种不属于 A/B 时用 lingua 在 A/B 中判定
- ROOM：目标为其他成员语言（去掉本句源语种），随 targets 控制帧更新

翻译与合成（improve-speech-playback-latency D4；提示词与上下文见 improve-prompts-and-context-memory D1 / D2）：
- 每个目标并行：同声传译专用提示词（interpret_prompts）+ 术语匹配、领域 + 本发言流最近 N 句（含双向对话的双方，
  一句话在 transcript.final 时即进入上下文、译完后回填译文），固定低温度，max_tokens = interpret_mt_max_tokens，
  流式 translation.delta（开头的"译文："等标签与包裹引号先经 LeadingCleaner 去掉）
- 开启播报时译文边生成边切段（SentenceSegmenter），每段立即交给 SpeechPipeline 合成（最多 2 路并发、按段序发出）；
  translation.final 在译文生成完即发出，不等合成。合成在出声前失败时发非致命 error(C0172)，
  并补发一次 ttsFallback=true 的同文 translation.final（前端据此改用浏览器朗读该句）
- 句与句之间流水线并行，audio 经 AudioSequencer 按 utteranceId 顺序发出，整句结束后发 metrics
"""

import asyncio
import contextlib
import logging
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import numpy as np

from app.agent.state import TranslationContext
from app.core.errors import BizException, ErrorCode
from app.glossary.matcher import GlossaryMatcher, select_glossaries
from app.lang import languages
from app.llm.base import ChatMessage, ChatRequest, LLMError
from app.llm.registry import ResolvedModel
from app.speech.asr import ASREngine, LocalSenseVoiceASR
from app.speech.audio import pcm16_to_float
from app.speech.endpointing import Commit, Decision, Discard, Endpointer, Hold, TurnJudge, is_meaningful, profile_for
from app.speech.engines import CASCADE, CASCADE_MAX_TARGETS, resolve_asr, resolve_tts
from app.speech.smart_turn import load_turn_model
from app.speech.tts import BROWSER, TtsEngine
from app.speech.vad import SAMPLE_RATE, SpeechSegment, VadSegmenter

from .engine import (
    EngineError,
    InterpretEngine,
    StreamConfig,
    UtteranceMetrics,
    ms_since,
    room_targets,
)
from .interpret_prompts import PROMPT_VERSION, Utterance, interpret_messages, window
from .output_filter import LeadingCleaner, clean_final
from .pipeline import SpeechPipeline
from .segmenter import SentenceSegmenter

log = logging.getLogger("app.interpret.cascade")

FINISH_TIMEOUT_SECONDS = 60.0
RECENT_KEEP = 24  # 发言流保留的最近语句数（上下文窗口另按配置截取）


@dataclass
class _Flush:
    side: str | None  # 按键松开时那一侧，用于确定本句方向


@dataclass
class _HoldExpire:
    token: int  # 续说等待的墙钟兜底（没有音频帧时也能定稿）


_STOP = object()


class CascadeEngine(InterpretEngine):
    id = CASCADE
    max_targets = CASCADE_MAX_TARGETS

    def __init__(self, cfg: StreamConfig, emit, deps):
        super().__init__(cfg, emit, deps)
        settings = deps.settings
        self._queue: asyncio.Queue[Any] = asyncio.Queue()
        self._worker: asyncio.Task | None = None
        self._tasks: set[asyncio.Task] = set()
        self._vad: VadSegmenter | None = None
        self._ep: Endpointer | None = None
        self._timers: set[asyncio.TimerHandle] = set()
        self._asr: ASREngine | None = None
        self._llm: ResolvedModel | None = None
        self._tts: TtsEngine | None = None
        self._tts_wanted = cfg.tts and cfg.tts_engine != BROWSER
        self._glossaries: dict = {}
        self._matcher = GlossaryMatcher()
        self._targets = list(dict.fromkeys(cfg.target_langs))
        self._ptt: str | None = None
        self._muted = False
        # partial 状态
        self._gen = 0  # 每次最终识别 +1，过期的 partial 结果丢弃
        self._cur_uid: int | None = None
        self._speech_samples = 0  # 当前语音段已累计的采样数（近似）
        self._partial_at = 0  # 上次 partial 时的语音段长度
        fast = cfg.latency_mode == "fast"
        partial_ms = settings.speech_partial_interval_ms_fast if fast else settings.speech_partial_interval_ms
        self._partial_interval = partial_ms * SAMPLE_RATE // 1000
        self._partial_task: asyncio.Task | None = None
        self._profile = profile_for(settings, cfg.mode, cfg.latency_mode)
        self._vad_silence_ms = self._profile.candidate_silence_ms
        self._seg_first_min = settings.interpret_seg_first_min_fast if fast else settings.interpret_seg_first_min
        # 最近输入的（采样数, RMS），用于判断尾部静音
        self._recent_rms: deque[tuple[int, float]] = deque()
        self._quiet_samples = settings.speech_partial_quiet_ms * SAMPLE_RATE // 1000
        self._quiet_rms = settings.speech_partial_quiet_rms
        # 发言流级的最近语句（D2）：不按目标语言分桶，双向对话包含双方；发言流重建时从 config.history 恢复（D5）
        self._recent: deque[Utterance] = deque(
            (
                Utterance(lang=h.lang or "", text=h.text, translations=dict(h.translations))
                for h in cfg.history
                if h.role == "user"
            ),
            maxlen=RECENT_KEEP,
        )

    # ---------------- 生命周期 ----------------

    async def start(self) -> None:
        deps, cfg = self.deps, self.cfg
        try:
            self._vad = VadSegmenter(min_silence_ms=self._vad_silence_ms)
        except FileNotFoundError:
            raise EngineError(ErrorCode.SPEECH_ENGINE_UNAVAILABLE, "本地 VAD 模型未下载") from None
        try:
            self._asr = await resolve_asr(cfg.asr_engine, None, deps.registry, deps.detector)
            if isinstance(self._asr, LocalSenseVoiceASR):
                await self._asr.warmup()
            self._llm = await deps.registry.get(cfg.model_config_id)
        except BizException as e:
            raise EngineError(e.error, e.message) from None
        self._ep = await self._endpointer()
        if self._tts_wanted:
            try:
                self._tts = await resolve_tts(cfg.tts_engine, None, deps.registry)
            except BizException as e:
                self.emit_error(ErrorCode.SPEECH_ENGINE_UNAVAILABLE, f"{e.message}，改用浏览器朗读")
        self._glossaries = await self.load_glossaries()
        self._worker = asyncio.create_task(self._run())
        self.emit_ready()
        log.info(
            "级联同传开始 stream=%s mode=%s asr=%s tts=%s targets=%s prompt=%s",
            cfg.stream_id,
            cfg.mode,
            self._asr.id,
            self._tts.id if self._tts else None,
            self._targets,
            PROMPT_VERSION,
        )

    async def feed(self, pcm: bytes) -> None:
        if pcm and not self._muted:
            self._queue.put_nowait(pcm)

    async def _endpointer(self) -> Endpointer:
        settings = self.deps.settings
        model = load_turn_model(settings.endpoint_smart_turn) if self._profile.hold_ms > 0 else None
        if model is not None:
            try:
                await model.warmup()
            except Exception:  # noqa: BLE001 - 加载失败时 available=False，退化为文本规则
                model = None
        judge = TurnJudge(model, settings.endpoint_smart_turn_threshold, settings.endpoint_smart_turn_confident)
        return Endpointer(self._vad, self._asr, judge, self._profile)

    async def control(self, msg: dict[str, Any]) -> None:
        kind = msg.get("type")
        if kind == "targets":
            targets = [t for t in msg.get("targetLangs") or [] if languages.is_supported(t)]
            self._targets = list(dict.fromkeys(targets))[: self.max_targets]
        elif kind == "ptt":
            side = msg.get("side")
            if side in ("A", "B"):
                self._ptt = side
            else:
                released, self._ptt = self._ptt, None
                self._queue.put_nowait(_Flush(released))
        elif kind == "flush":
            self._queue.put_nowait(_Flush(self._ptt))
        elif kind == "mute":
            muted = bool(msg.get("muted"))
            if muted and not self._muted:
                self._queue.put_nowait(_Flush(self._ptt))
            self._muted = muted

    async def finish(self) -> None:
        if self._worker is None:
            return
        self._queue.put_nowait(_Flush(self._ptt))
        self._queue.put_nowait(_STOP)
        with contextlib.suppress(asyncio.CancelledError):
            await self._worker
        pending = [t for t in self._tasks if not t.done()]
        if pending:
            await asyncio.wait(pending, timeout=FINISH_TIMEOUT_SECONDS)

    async def close(self) -> None:
        for h in self._timers:
            h.cancel()
        self._timers.clear()
        tasks = [t for t in (self._worker, self._partial_task, *self._tasks) if t is not None and not t.done()]
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        for res in (self._tts, self._asr):  # 释放远程引擎复用的连接
            if res is not None and hasattr(res, "aclose"):
                with contextlib.suppress(Exception):
                    await res.aclose()

    # ---------------- 识别 ----------------

    async def _run(self) -> None:
        try:
            while True:
                item = await self._queue.get()
                if item is _STOP:
                    return
                if isinstance(item, _Flush):
                    await self._apply(await self._ep.flush(self._hint(item.side)), item.side)
                    self._speech_samples = 0
                    continue
                if isinstance(item, _HoldExpire):
                    await self._apply(self._ep.expire(item.token), self._ptt)
                    continue
                samples = pcm16_to_float(item)
                self._track_level(samples)
                await self._apply(await self._ep.accept(samples, self._hint(self._ptt)), self._ptt)
                self._maybe_partial(len(samples))
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("级联处理协程异常 stream=%s", self.cfg.stream_id)
            self.fail(EngineError(ErrorCode.SYSTEM_ERROR, "同传处理异常"))

    def _track_level(self, samples: np.ndarray) -> None:
        if not len(samples):
            return
        self._recent_rms.append((len(samples), float(np.sqrt(np.mean(np.square(samples))))))
        total = sum(n for n, _ in self._recent_rms)
        while self._recent_rms and total - self._recent_rms[0][0] >= self._quiet_samples:
            total -= self._recent_rms.popleft()[0]

    def _trailing_quiet(self) -> bool:
        """最近 quiet_ms 的输入都低于静音阈值：说话可能已结束，VAD 即将判句末。"""
        total = sum(n for n, _ in self._recent_rms)
        return total >= self._quiet_samples and all(r < self._quiet_rms for _, r in self._recent_rms)

    def _maybe_partial(self, n: int) -> None:
        if not self._ep.speaking:
            self._speech_samples = 0
            self._partial_at = 0
            return
        self._speech_samples += n
        if not isinstance(self._asr, LocalSenseVoiceASR):
            return
        if self._speech_samples - self._partial_at < self._partial_interval:
            return
        if self._partial_task is not None and not self._partial_task.done():
            return
        if self._trailing_quiet():
            return  # 识别让路：把 CPU 留给即将到来的最终识别
        audio = self._ep.current_audio()
        if audio is None:
            return
        self._partial_at = self._speech_samples
        self._partial_task = asyncio.create_task(self._partial(self._gen, audio))

    async def _partial(self, gen: int, samples: np.ndarray) -> None:
        try:
            res = await self._asr.transcribe(samples, self._hint(self._ptt))
        except Exception:  # noqa: BLE001 - partial 失败不影响最终识别
            log.debug("partial 识别失败", exc_info=True)
            return
        if gen != self._gen or not res.text:
            return
        if self._cur_uid is None:
            self._cur_uid = self.next_uid()
        self.emit("transcript.partial", utteranceId=self._cur_uid, text=res.text)

    def _hint(self, side: str | None) -> str | None:
        return self.cfg.side_lang(side) or self.cfg.declared_source

    async def _apply(self, decisions: list[Decision], side: str | None) -> None:
        """把断句结果映射为事件：等待续说 / 定稿 / 丢弃。"""
        for d in decisions:
            self._gen += 1  # 之前发起的 partial 结果作废
            self._partial_at = 0
            if isinstance(d, Hold):
                if self._cur_uid is None:
                    self._cur_uid = self.next_uid()
                self.emit("transcript.partial", utteranceId=self._cur_uid, text=d.text, hold=True)
                self._schedule_expire(d)
            elif isinstance(d, Commit):
                uid, self._cur_uid = self._cur_uid, None
                await self._commit(uid, d.text, d.lang, d.start_ms, d.end_ms, side, d.t0, d.asr_ms, d.hold_ms)
            elif isinstance(d, Discard):
                if d.error is not None:
                    self.emit_error(*d.error)
                self._discard(d.reason)

    def _schedule_expire(self, hold: Hold) -> None:
        handle: asyncio.TimerHandle | None = None

        def fire() -> None:
            self._timers.discard(handle)
            self._queue.put_nowait(_HoldExpire(hold.token))

        handle = asyncio.get_running_loop().call_later(hold.deadline_s, fire)
        self._timers.add(handle)

    def _discard(self, reason: str) -> None:
        uid, self._cur_uid = self._cur_uid, None
        if uid is not None:
            self.emit("transcript.discard", utteranceId=uid)
        log.debug("丢弃语音段 stream=%s uid=%s reason=%s", self.cfg.stream_id, uid, reason)
        self._after_discard(uid)

    def _after_discard(self, uid: int | None) -> None:
        """一段语音被丢弃后的扩展点（AI 对话在此恢复让位的回复）。"""

    async def _finalize(self, seg: SpeechSegment, side: str | None) -> None:
        """直接对一个语音段识别并定稿（不经过续说等待）；单测与离线工具使用。"""
        t0 = time.perf_counter()
        self._gen += 1
        self._partial_at = 0
        try:
            res = await self._asr.transcribe(seg.samples, self._hint(side))
        except BizException as e:
            self.emit_error(e.error, f"语音识别失败：{e.message}")
            self._discard("asr-error")
            return
        except Exception:
            log.exception("最终识别失败 stream=%s", self.cfg.stream_id)
            self.emit_error(ErrorCode.SPEECH_ENGINE_UNAVAILABLE, "语音识别失败")
            self._discard("asr-error")
            return
        if not is_meaningful(res.text):
            self._discard("filler" if res.text else "empty")
            return
        uid, self._cur_uid = self._cur_uid, None
        await self._commit(uid, res.text, res.lang, seg.start_ms, seg.end_ms, side, t0, res.latency_ms, None)

    async def _commit(
        self,
        uid: int | None,
        text: str,
        detected: str | None,
        start_ms: int,
        end_ms: int,
        side: str | None,
        t0: float,
        asr_ms: int,
        hold_ms: int | None,
    ) -> None:
        uid = uid or self.next_uid()
        source, targets = await self._route(text, detected, side)
        metrics = UtteranceMetrics(t0=t0, asr_ms=asr_ms, hold_ms=hold_ms)
        self.emit("transcript.final", utteranceId=uid, text=text, lang=source, startedMs=start_ms, endedMs=end_ms)
        fmt, rate = (self._tts.format, self._tts.sample_rate) if self._tts else ("mp3", 24000)
        self.sequencer.open(
            uid, targets, fmt, rate, on_done=lambda first_audio: self._emit_fn(metrics.to_event(uid, first_audio))
        )
        # 本句之前的语句作为上下文（对象引用：前句的译文完成后回填，翻译开始时即可见）
        before = list(self._recent)
        utt = Utterance(lang=source, text=text)
        self._recent.append(utt)
        if targets:
            self._spawn(self._translate_all(uid, utt, before, targets, metrics))
        self._after_final(uid, text, source, t0)

    def _after_final(self, uid: int, text: str, source: str, t0: float) -> None:
        """一句话定稿并完成路由后的扩展点（AI 对话在此生成回复）。"""

    def _spawn(self, coro: Any) -> asyncio.Task:
        """后台任务：finish 时等待、close 时取消。"""
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    async def _route(self, text: str, detected: str | None, side: str | None) -> tuple[str, list[str]]:
        """返回（本句源语种, 目标语种列表）。"""
        cfg = self.cfg
        if cfg.mode == "CONVERSE":
            a, b = cfg.pair
            source = cfg.side_lang(side)
            if source is None:
                source = detected if detected in (a, b) else (await self.detect_lang(text, (a, b)) or a)
            return source, [b if source == a else a]
        source = detected or cfg.declared_source or await self.detect_lang(text) or "en"
        if cfg.mode == "LISTEN":
            target = self._targets[0] if self._targets else None
            return source, [] if target is None or target == source else [target]
        return source, room_targets(source, self._targets)

    # ---------------- 翻译与合成 ----------------

    async def _translate_all(
        self, uid: int, utt: Utterance, before: list[Utterance], targets: list[str], metrics: UtteranceMetrics
    ) -> None:
        await asyncio.gather(*(self._translate_one(uid, utt, before, t, metrics) for t in targets))

    async def _translate_one(
        self, uid: int, utt: Utterance, before: list[Utterance], target: str, m: UtteranceMetrics
    ) -> None:
        text, source = utt.text, utt.lang
        pipe = self._pipeline(uid, target, m) if self._tts is not None else None
        segmenter = SentenceSegmenter(self._seg_first_min, self.deps.settings.interpret_seg_min_chars)

        def on_delta(delta: str) -> None:
            for piece in segmenter.feed(delta):
                pipe.add(piece)

        closed = False
        try:
            try:
                messages = self._interpret_messages(text, source, target, before)
                translation = await self._translate(uid, messages, target, m, on_delta if pipe else None)
            except LLMError as e:
                self.emit_error(e.error_code, f"翻译失败：{e.message}")
                return
            except Exception:
                log.exception("翻译失败 uid=%s target=%s", uid, target)
                self.emit_error(ErrorCode.LLM_CALL_FAILED, "翻译失败")
                return
            if not translation:
                self.emit_error(ErrorCode.LLM_CALL_FAILED, "模型未返回译文")
                return
            utt.translations[target] = translation
            if pipe is not None and (rest := segmenter.flush()):
                pipe.add(rest)
            fallback = self._tts_wanted and (pipe is None or pipe.fallback_needed)
            self.emit("translation.final", utteranceId=uid, lang=target, text=translation, ttsFallback=fallback)
            m.final_emitted()
            if pipe is not None:
                await pipe.close()
                closed = True
                if pipe.fallback_needed and not fallback:
                    # 定稿时合成尚未失败、之后在出声前失败：补发一次带降级标记的定稿
                    self.emit("translation.final", utteranceId=uid, lang=target, text=translation, ttsFallback=True)
        finally:
            if pipe is not None and not closed:
                await pipe.cancel()
            self.sequencer.end(uid, target)

    def _pipeline(self, uid: int, target: str, m: UtteranceMetrics) -> SpeechPipeline:
        tts = self._tts
        return SpeechPipeline(
            tts,
            self.sequencer,
            uid,
            target,
            tts.resolve_voice(target, self.cfg.voices.get(target), self.cfg.gender),
            concurrency=self.deps.settings.interpret_tts_concurrency,
            first_timeout=self.deps.settings.edge_tts_timeout_seconds,
            on_first_audio=m.tts_first.append,
            on_error=lambda message, _before_audio: self.emit_error(ErrorCode.TTS_FAILED, message),
        )

    def _context(self, text: str, source: str, target: str) -> TranslationContext:
        """术语匹配与领域；最近语句由调用方单独传入提示词。"""
        usable = select_glossaries(self.cfg.glossary_ids, self._glossaries, source, target).usable
        return TranslationContext(
            terms=self._matcher.match(text, usable) if usable else [],
            domain_hint=self.cfg.domain_hint or None,
            style="fluent",
        )

    def _interpret_messages(self, text: str, source: str, target: str, before: list[Utterance]) -> list[ChatMessage]:
        settings = self.deps.settings
        recent = window(before, target, settings.interpret_ctx_sentences, settings.interpret_ctx_max_chars)
        return interpret_messages(self._context(text, source, target), recent, text, source, target)

    def _temperature(self) -> float | None:
        """同传与字幕使用固定的低温度（D1）；配置为空时沿用模型参数。"""
        fixed = self.deps.settings.interpret_mt_temperature
        if fixed is not None:
            return fixed
        temperature = self._llm.params.get("temperature")
        return float(temperature) if temperature is not None else None

    async def _translate(
        self,
        uid: int,
        messages: list[ChatMessage],
        target: str,
        m: UtteranceMetrics,
        on_delta: Callable[[str], None] | None = None,
        emit_deltas: bool = True,
    ) -> str:
        """流式翻译一句（messages 由调用方按同传或字幕构造，最后一条为原文），返回清理后的译文。"""
        extra: dict[str, Any] = {}
        effort = self._llm.config.extra.get("reasoningEffort")
        if effort and self._llm.config.provider == "OPENAI_COMPATIBLE":  # 推理模型取最低推理强度，其他厂商忽略
            extra["reasoning_effort"] = effort
        req = ChatRequest(
            messages=messages,
            temperature=self._temperature(),
            max_tokens=self.deps.settings.interpret_mt_max_tokens,
            extra=extra,
        )
        source_text = messages[-1].content if isinstance(messages[-1].content, str) else ""
        cleaner = LeadingCleaner(source_text)
        start = time.perf_counter()
        parts: list[str] = []

        def push(delta: str) -> None:
            if not delta:
                return
            if emit_deltas:
                self.emit("translation.delta", utteranceId=uid, lang=target, delta=delta)
            if on_delta is not None:
                on_delta(delta)

        async with contextlib.aclosing(self._llm.client.stream(req)) as stream:
            async for chunk in stream:
                if chunk.delta:
                    if not parts:
                        m.mt_first.append(ms_since(start))
                    parts.append(chunk.delta)
                    push(cleaner.feed(chunk.delta))
        push(cleaner.flush())
        m.mt_total.append(ms_since(start))
        return clean_final("".join(parts), source_text)


async def _aclose(stream: Any) -> None:
    with contextlib.suppress(Exception):
        await stream.aclose()
