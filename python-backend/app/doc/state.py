"""篇章图的状态、任务负载与运行时依赖（design D2 / D5）。

状态只包含 JSON 兼容的基本类型（dict / list / str / int / float / bool / None），
保证 AsyncPostgresSaver 序列化与反序列化时不依赖自定义类型。
"""

import asyncio
import operator
from dataclasses import dataclass, field
from typing import Annotated, Any, Literal, TypedDict

from pydantic import Field, field_validator

from app.agent.state import Style
from app.core.config import Settings
from app.core.errors import BizException, ErrorCode
from app.core.schema import CamelModel
from app.doc.events import EventEmitter
from app.doc.store import ChunkStore
from app.glossary.matcher import GlossaryMatcher
from app.glossary.repository import GlossaryRepository
from app.lang import languages
from app.lang.detector import LanguageDetector
from app.llm.base import LLMClient, Usage
from app.llm.reviewer import ReviewerSource, ReviewModel, review_model_of


class DocOptionsModel(CamelModel):
    context_window: bool = True
    global_summary: bool = True
    term_extraction: bool = True
    review: bool = False
    translation_memory: bool = True  # 按段检索任务所属用户的翻译记忆（add-session-context-and-memory D7）


class DocPayload(CamelModel):
    """start / retry 命令中的 payload（design D2）。"""

    user_id: int | None = None
    title: str | None = None
    format: Literal["md", "txt"] = "md"
    text: str
    source_lang: str = languages.AUTO
    target_lang: str
    style: Style = "faithful"
    domain: str | None = Field(default=None, max_length=32)
    glossary_ids: list[int] = Field(default_factory=list)
    model_config_id: int | None = None
    review_model_config_id: int | None = Field(default=None, ge=1)  # 评审模型；为空时评审使用译者模型
    strategy: Literal["serial", "parallel", "hybrid"] = "hybrid"
    confirm_terms: bool = True
    options: DocOptionsModel = Field(default_factory=DocOptionsModel)

    @field_validator("glossary_ids", mode="before")
    @classmethod
    def _none_to_empty(cls, v: Any) -> Any:
        return [] if v is None else v

    @field_validator("options", mode="before")
    @classmethod
    def _none_options(cls, v: Any) -> Any:
        return {} if v is None else v

    def check(self, max_length: int) -> None:
        if len(self.text) > max_length:
            raise BizException(ErrorCode.PARAM_INVALID, f"文档不能超过 {max_length} 字符")
        if self.source_lang != languages.AUTO and not languages.is_supported(self.source_lang):
            raise BizException(ErrorCode.UNSUPPORTED_LANGUAGE, f"不支持的源语言: {self.source_lang}")
        if not languages.is_supported(self.target_lang):
            raise BizException(ErrorCode.UNSUPPORTED_LANGUAGE, f"不支持的目标语言: {self.target_lang}")

    @property
    def user_domain(self) -> str | None:
        d = (self.domain or "").strip()
        return d if d and d.lower() != "auto" else None


def add_usage_dict(a: dict[str, int] | None, b: dict[str, int] | None) -> dict[str, int]:
    a, b = a or {}, b or {}
    return {
        "promptTokens": int(a.get("promptTokens", 0)) + int(b.get("promptTokens", 0)),
        "completionTokens": int(a.get("completionTokens", 0)) + int(b.get("completionTokens", 0)),
    }


def usage_dict(u: Usage | None) -> dict[str, int]:
    u = u or Usage()
    return {"promptTokens": u.prompt_tokens, "completionTokens": u.completion_tokens}


def sum_usage(*items: Usage | None) -> Usage:
    total = Usage()
    for u in items:
        if u is not None:
            total = Usage(total.prompt_tokens + u.prompt_tokens, total.completion_tokens + u.completion_tokens)
    return total


class DocState(TypedDict, total=False):
    task_id: int
    payload: dict[str, Any]  # DocPayload.model_dump(by_alias=True)
    segments: list[dict[str, Any]]  # Segment.to_dict()
    chunks: list[dict[str, Any]]  # Chunk.to_dict()
    source_lang: str
    detected_lang: str | None
    confidence: float | None
    summary: str | None
    domain: str
    genre: str
    extracted: list[dict[str, Any]]  # LLM 抽取的原始候选 {source, target, type}
    candidates: list[dict[str, Any]]  # 合并后的候选 {source, target, origin, frequency, type, alts}
    terms: list[dict[str, Any]]  # 任务术语表 {source, target, caseSensitive, binding}；缺 binding 按 hard
    groups: list[list[int]]
    translate_started_ms: int
    chunk_results: Annotated[list[dict[str, Any]], operator.add]
    consistency: dict[str, Any]
    final_targets: dict[str, str]  # seq（字符串） -> 一致性修正后的译文
    usage: Annotated[dict[str, int], add_usage_dict]
    elapsed_ms: Annotated[int, operator.add]  # 除翻译阶段外各节点耗时之和
    pending_traces: list[dict[str, Any]]


class GroupInput(TypedDict):
    """translate_group 的 Send 负载：组内执行所需的全部信息。"""

    task_id: int
    group: int
    chunk_ids: list[int]
    total_chunks: int
    chunks: dict[str, dict[str, Any]]  # chunk index（字符串） -> chunk
    segments: dict[str, dict[str, Any]]  # seq（字符串） -> segment（仅本组）
    terms: list[dict[str, Any]]
    summary: str | None
    domain: str
    source_lang: str
    payload: dict[str, Any]


@dataclass
class DocDeps:
    """通过 LangGraph Runtime context 传给节点的依赖（每次执行一份，不进入检查点）。"""

    llm: LLMClient
    settings: Settings
    detector: LanguageDetector
    glossary_repo: GlossaryRepository
    emitter: EventEmitter
    store: ChunkStore
    model_params: dict[str, Any] = field(default_factory=dict)
    matcher: GlossaryMatcher = field(default_factory=GlossaryMatcher)
    chunk_semaphore: asyncio.Semaphore | None = None
    reviewer: ReviewerSource | None = None  # 评审模型来源；为空时评审使用译者模型
    review_fallback_traced: bool = False  # 本次执行是否已记录评审模型退回的警告轨迹
    tm: Any = None  # 翻译记忆仓储（app.memory.tm.TranslationMemory）；为空时不检索

    async def review_model(self) -> ReviewModel:
        return await review_model_of(self.reviewer, self.llm)

    def __post_init__(self) -> None:
        if self.chunk_semaphore is None:
            self.chunk_semaphore = asyncio.Semaphore(max(1, self.settings.doc_chunk_concurrency))

    @property
    def temperature(self) -> float | None:
        t = self.model_params.get("temperature")
        return float(t) if t is not None else None
