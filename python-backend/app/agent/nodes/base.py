"""节点公共定义：运行时依赖、节点产出、事件推送、LLM 调用辅助。"""

import contextlib
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from app.core.config import Settings
from app.core.errors import ErrorCode
from app.glossary.matcher import GlossaryMatcher
from app.glossary.repository import GlossaryRepository
from app.lang.detector import LanguageDetector
from app.llm.base import ChatMessage, ChatRequest, LLMClient, Usage
from app.llm.reviewer import ReviewerSource, ReviewModel, review_model_of

Emit = Callable[[str, dict[str, Any]], None]


class AgentError(Exception):
    """Agent 自身的执行错误，映射为 C0140。"""

    def __init__(self, message: str):
        super().__init__(message)
        self.error_code = ErrorCode.AGENT_FAILED
        self.message = message


@dataclass
class AgentDeps:
    """通过 LangGraph Runtime context 传给节点的依赖（每次翻译一份）。"""

    llm: LLMClient
    settings: Settings
    detector: LanguageDetector
    glossary_repo: GlossaryRepository
    matcher: GlossaryMatcher = field(default_factory=GlossaryMatcher)
    model_params: dict[str, Any] = field(default_factory=dict)  # 模型配置 params（camelCase）
    reviewer: ReviewerSource | None = None  # 评审模型来源；为空时评审使用译者模型
    tm: Any = None  # 翻译记忆仓储（app.memory.tm.TranslationMemory）；为空时不检索
    clarify_available: bool = False  # 本次执行带检查点，可以中断追问（graph_hitl）

    async def review_model(self) -> ReviewModel:
        return await review_model_of(self.reviewer, self.llm)

    @property
    def temperature(self) -> float | None:
        t = self.model_params.get("temperature")
        return float(t) if t is not None else None

    @property
    def translate_max_tokens(self) -> int:
        return int(self.model_params.get("maxTokens") or self.settings.agent_translate_max_tokens)


@dataclass
class NodeOutput:
    update: dict[str, Any]
    summary: str
    usage: Usage | None = None  # 调用了 LLM 的节点才有
    detail: dict[str, Any] | None = None  # node completed 事件的可选明细（如 retrieve 的 tmHits）


async def stream_llm_text(deps: AgentDeps, messages: list[ChatMessage], round_: int, emit: Emit) -> tuple[str, Usage]:
    """流式调用 LLM，每个增量推送一个 delta 事件；返回完整文本和 usage。"""
    req = ChatRequest(messages=messages, temperature=deps.temperature, max_tokens=deps.translate_max_tokens)
    parts: list[str] = []
    usage = Usage()
    async with contextlib.aclosing(deps.llm.stream(req)) as stream:
        async for chunk in stream:
            if chunk.delta:
                parts.append(chunk.delta)
                emit("delta", {"round": round_, "text": chunk.delta})
            if chunk.done and chunk.usage is not None:
                usage = chunk.usage
    return "".join(parts), usage
