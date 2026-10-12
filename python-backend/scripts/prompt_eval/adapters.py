"""适配层：把评测用例转成真实代码构造的 LLM 请求，隔离提示词 API 的变化。

ADAPTER = "v3"：improve-prompts-and-context-memory 改造后的代码路径（v2 之后加入陪练示范的本轮提示兜底）。
- 同传：interpret_prompts.interpret_messages + 发言流级最近语句窗口（含双向对话的双方），固定低温度，输出经 clean_final
- 字幕：interpret_prompts.subtitle_messages，上下文为用户上一句与本条回复前面的句子
- AI 对话：DialogMemory 维护窗口与滚动摘要，build_messages 带上摘要与本轮提示；评测中压缩同步等待，保证可复现。
  用户语种由引擎的识别结果决定；评测数据只有中英两种语言，这里按是否含汉字判断

改造前的基线（ADAPTER = "baseline"）见提交 c795779 中的本文件，其结果保存在 evaluation/results/prompt/baseline/。
"""

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

from app.agent.state import TranslationContext
from app.core.config import Settings
from app.interpret import chat_prompts, dialog_memory, interpret_prompts
from app.interpret.chat_prompts import (
    INTERRUPTED_MARK,
    REPLY_MAX_TOKENS,
    REPLY_TEMPERATURE,
    build_messages,
    turn_hint,
)
from app.interpret.dialog_memory import DialogMemory, summarize
from app.interpret.interpret_prompts import Utterance, interpret_messages, subtitle_messages, window
from app.interpret.output_filter import clean_final
from app.llm.base import ChatMessage, ChatRequest

from .client import EvalLLM

ADAPTER = "v3"
PROMPT_VERSION = f"{interpret_prompts.PROMPT_VERSION}/{chat_prompts.PROMPT_VERSION}/{dialog_memory.PROMPT_VERSION}"
PERSONA = "Lumi"
# 测试中转单次延迟 3–60 s：评测中把压缩超时放宽，避免把中转抖动计为压缩失败（平台缺省 30 s）
EVAL_MEMORY_TIMEOUT = 120.0

_CJK = re.compile(r"[一-鿿]")
_SENTENCE_END = re.compile(r"(?<=[.!?。！？])\s+")


def _default(name: str) -> Any:
    return Settings.model_fields[name].default


@dataclass
class Request:
    messages: list[ChatMessage]
    temperature: float | None
    max_tokens: int | None
    post: Callable[[str], str] = field(default=lambda s: s.strip())


def interpret_request(case: dict[str, Any]) -> Request:
    src, tgt, text = case["src"], case["tgt"], case["text"]
    recent = [Utterance(h["lang"], h["text"], dict(h.get("translations") or {})) for h in case.get("history") or []]
    recent = window(recent, tgt, _default("interpret_ctx_sentences"), _default("interpret_ctx_max_chars"))
    messages = interpret_messages(TranslationContext(style="fluent"), recent, text, src, tgt)
    return Request(
        messages,
        _default("interpret_mt_temperature"),
        _default("interpret_mt_max_tokens"),
        lambda out: clean_final(out, text),
    )


def subtitle_request(case: dict[str, Any]) -> Request:
    text = case["text"]
    messages = subtitle_messages(case.get("user"), case.get("prev") or [], text, case["src"], case["tgt"], PERSONA)
    return Request(
        messages,
        _default("interpret_mt_temperature"),
        _default("interpret_mt_max_tokens"),
        lambda out: clean_final(out, text),
    )


def interrupted_part(text: str) -> str:
    """模拟打断：保留第一句；只有一句时保留前一半的词。"""
    parts = _SENTENCE_END.split(text.strip())
    if len(parts) > 1:
        return parts[0]
    words = text.split()
    return " ".join(words[: max(1, len(words) // 2)]) if len(words) > 1 else text[: max(1, len(text) // 2)]


class _Client:
    """把 EvalLLM 包装成 dialog_memory.summarize 需要的 chat(ChatRequest) 接口。"""

    def __init__(self, llm: EvalLLM):
        self._llm = llm

    async def chat(self, req: ChatRequest) -> SimpleNamespace:
        content = await self._llm.chat(req.messages, temperature=req.temperature, max_tokens=req.max_tokens)
        return SimpleNamespace(content=content)


class ChatDriver:
    """按改造后的 CascadeChatEngine 组装对话请求：DialogMemory 维护窗口，超出时压缩成摘要（同步等待）。"""

    def __init__(self, llm: EvalLLM, scenario: str, my: str, ai: str):
        self.llm, self.scenario, self.my, self.ai = llm, scenario, my, ai
        self.memory = DialogMemory(
            window_turns=_default("chat_window_turns"),
            batch_turns=_default("chat_memory_batch_turns"),
            max_chars=_default("chat_memory_max_chars"),
            hard_turns=_default("chat_memory_hard_turns"),
        )
        self.compressions = 0
        self._settings = SimpleNamespace(
            chat_memory_summary_max_chars=_default("chat_memory_summary_max_chars"),
            chat_memory_timeout_seconds=EVAL_MEMORY_TIMEOUT,
        )

    @property
    def summary(self) -> str | None:
        return self.memory.summary

    async def _reply(self, history: list[ChatMessage], user_text: str | None) -> str:
        hint = None
        if user_text is not None:
            last = next((m.content for m in reversed(history) if m.role == "assistant"), None)
            user_lang = "zh" if _CJK.search(user_text) else "en"
            hint = turn_hint(user_text, user_lang, last, self.my, self.ai)
        messages = build_messages(
            self.scenario, self.my, self.ai, history, user_text, PERSONA, self.memory.summary, hint
        )
        return await self.llm.chat(messages, temperature=REPLY_TEMPERATURE, max_tokens=REPLY_MAX_TOKENS)

    async def greet(self) -> str:
        reply = await self._reply(self.memory.history(), None)
        self.memory.append(ChatMessage(role="assistant", content=reply))
        return reply

    def interrupt_last(self) -> str | None:
        """把上一条 AI 回复截成被打断的样子（已生成部分 + 省略号），返回保留的部分。"""
        last = self.memory.last()
        if last is None or last.role != "assistant":
            return None
        kept = interrupted_part(last.content)
        # 评测专用：直接替换最后一条（引擎中打断发生在回复写入之前，写入的就是已生成部分）
        order, _ = self.memory._items[-1]
        self.memory._items[-1] = (order, ChatMessage(role="assistant", content=kept + INTERRUPTED_MARK))
        return kept

    async def turn(self, text: str) -> str:
        history = self.memory.history()
        self.memory.append(ChatMessage(role="user", content=text))
        reply = await self._reply(history, text)
        self.memory.append(ChatMessage(role="assistant", content=reply))
        return reply

    async def after_turn(self) -> None:
        batch = self.memory.due()
        if batch is None:
            return
        try:
            summary = await summarize(
                _Client(self.llm), self.memory, batch, scenario=self.scenario, persona=PERSONA, settings=self._settings
            )
        except Exception:  # noqa: BLE001 - 与引擎一致：失败时记忆不变，下次重试
            self.memory.fail()
            return
        if summary:
            self.memory.commit(batch, summary)
            self.compressions += 1
        else:
            self.memory.fail()
