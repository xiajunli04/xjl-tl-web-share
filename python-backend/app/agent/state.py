"""Agent 状态与上下文包（design D2）。"""

from dataclasses import dataclass, field
from typing import Any, Literal, TypedDict

from pydantic import Field, field_validator

from app.core.errors import BizException, ErrorCode
from app.core.schema import CamelModel
from app.glossary.matcher import TermCompliance, TermHit
from app.lang import languages
from app.llm.base import Usage

PathType = Literal["fast", "standard", "revise"]
Mode = Literal["auto", "fast", "standard", "revise"]
Style = Literal["faithful", "fluent", "creative"]

DEFAULT_DOMAIN = "通用"
STYLE_NAMES: dict[str, str] = {"faithful": "忠实", "fluent": "流畅", "creative": "创意"}
REVIEW_CATEGORIES = ("accuracy", "fluency", "terminology", "style")
REVIEW_SEVERITIES = ("critical", "major", "minor")


class SessionTurn(CamelModel):
    """会话中已采用的一轮（原文与译文）；instruction 为该版本的修订要求。"""

    seq: int | None = None
    source: str = ""
    target: str = ""
    instruction: str | None = None


class SessionEntity(CamelModel):
    """会话专名表的一项：原文写法、已用译法、备注。"""

    source: str
    target: str
    note: str | None = None


class SessionPayload(CamelModel):
    """会话载荷（add-session-context-and-memory 契约 A）：Spring 组装，Python 只读。"""

    session_id: int | None = None
    clarify_enabled: bool = True
    recent_turns: list[SessionTurn] = Field(default_factory=list)
    summary: str | None = None
    entities: list[SessionEntity] = Field(default_factory=list)
    to_memorize: list[SessionTurn] = Field(default_factory=list)
    memorized_until: int = 0
    turn_seq: int | None = None

    @field_validator("recent_turns", "entities", "to_memorize", mode="before")
    @classmethod
    def _none_to_empty(cls, v: Any) -> Any:
        return [] if v is None else v

    @field_validator("clarify_enabled", mode="before")
    @classmethod
    def _none_to_true(cls, v: Any) -> Any:
        return True if v is None else v

    @field_validator("memorized_until", mode="before")
    @classmethod
    def _none_to_zero(cls, v: Any) -> Any:
        return 0 if v is None else v


class RevisePayload(CamelModel):
    """修订载荷：被修订记录的原文、当前译文与修订要求。"""

    record_id: int | None = None
    base_source: str = ""
    base_target: str = Field(min_length=1)
    instruction: str = Field(min_length=1, max_length=500)


class TranslateRequest(CamelModel):
    """POST /internal/translate/stream 的请求体：design D7 的 TranslateRequest 加上 userId、会话与修订载荷。"""

    text: str
    source_lang: str = languages.AUTO
    target_lang: str
    mode: Mode = "auto"
    style: Style = "faithful"
    domain: str | None = Field(default=None, max_length=32)
    glossary_ids: list[int] = Field(default_factory=list)
    model_config_id: int | None = Field(default=None, ge=1)
    review_model_config_id: int | None = Field(default=None, ge=1)  # 评审模型；为空时评审使用译者模型
    user_id: int | None = None
    session: SessionPayload | None = None
    revise: RevisePayload | None = None

    @field_validator("glossary_ids", mode="before")
    @classmethod
    def _none_to_empty(cls, v: Any) -> Any:
        return [] if v is None else v

    @property
    def user_domain(self) -> str | None:
        """用户指定的领域；空或 "auto" 视为未指定。"""
        d = (self.domain or "").strip()
        return d if d and d.lower() != "auto" else None

    def check(self, max_text_length: int) -> None:
        """Spring 已预先校验；这里做基本校验，失败时在建立事件流之前返回 JSON 错误。"""
        if not self.text.strip():
            raise BizException(ErrorCode.PARAM_INVALID, "原文不能为空")
        if len(self.text) > max_text_length:
            raise BizException(
                ErrorCode.PARAM_INVALID, f"原文不能超过 {max_text_length} 字符，长文本请使用文档翻译（即将推出）"
            )
        if self.source_lang != languages.AUTO and not languages.is_supported(self.source_lang):
            raise BizException(ErrorCode.UNSUPPORTED_LANGUAGE, f"不支持的源语言: {self.source_lang}")
        if not languages.is_supported(self.target_lang):
            raise BizException(ErrorCode.UNSUPPORTED_LANGUAGE, f"不支持的目标语言: {self.target_lang}")
        if self.source_lang == self.target_lang:
            raise BizException(ErrorCode.PARAM_INVALID, "源语言与目标语言不能相同")
        if self.mode == "revise" and (self.revise is None or not self.revise.instruction.strip()):
            raise BizException(ErrorCode.PARAM_INVALID, "修订请求缺少修订要求")


@dataclass
class TranslationContext:
    """上下文包：序列化为提示词（app/agent/prompts.py）。

    - tm_examples：翻译记忆命中 [{source, target}]（标准路径的 retrieve 节点填充）
    - session_ctx：会话最近轮次 [{seq, source, target}]（已按窗口与字符上限截断）
    - session_summary / session_entities：会话早期摘要与会话专名表 [{source, target, note}]
    - clarification：用户对歧义追问的回答 {question, options, span, answer}
    - doc_memory 由文档翻译使用
    """

    terms: list[TermHit] = field(default_factory=list)
    domain_hint: str | None = None
    style: str = "faithful"
    tm_examples: list[dict[str, str]] = field(default_factory=list)
    doc_memory: str | None = None
    session_ctx: list[dict[str, Any]] = field(default_factory=list)
    session_summary: str | None = None
    session_entities: list[dict[str, Any]] = field(default_factory=list)
    clarification: dict[str, Any] | None = None


@dataclass
class ReviewIssue:
    category: str
    severity: str
    span: str
    suggestion: str

    def to_event(self) -> dict[str, str]:
        return {"category": self.category, "severity": self.severity, "span": self.span, "suggestion": self.suggestion}


@dataclass
class Review:
    round: int
    score: int | None  # 评审输出无法解析时为 None（视为通过）
    passed: bool
    issues: list[ReviewIssue] = field(default_factory=list)
    parse_failed: bool = False
    reviewer: str | None = None  # 评审模型显示名
    fallback: bool = False  # 指定的评审模型不可用，退回译者模型

    def to_event(self) -> dict[str, Any]:
        return {
            "round": self.round,
            "score": self.score,
            "passed": self.passed,
            "issues": [i.to_event() for i in self.issues],
            "reviewer": self.reviewer,
            "fallback": self.fallback,
        }


@dataclass
class NodeTrace:
    node: str
    status: str  # started | completed | skipped | interrupted
    summary: str | None = None
    latency_ms: int | None = None
    usage: Usage | None = None


@dataclass
class TextFeatures:
    length: int
    placeholders: list[str] = field(default_factory=list)
    urls: list[str] = field(default_factory=list)
    has_code: bool = False


class TranslationState(TypedDict, total=False):
    request: TranslateRequest
    source_lang: str  # 生效的源语言：用户指定或识别结果
    detected_lang: str | None
    detect_confidence: float | None
    detect_method: str | None
    term_hits: list[TermHit]
    skipped_glossaries: list[int]
    features: TextFeatures
    path: PathType
    plan_reason: str
    domain: str
    context: TranslationContext
    draft: str
    round: int  # 修正轮次，0 表示首译
    reviews: list[Review]
    final: str | None
    compliance: list[TermCompliance]
    usage: Usage
    node_traces: list[NodeTrace]
    ambiguity: dict[str, Any] | None  # plan 判定的歧义 {span, question, options, reason}
    clarification: dict[str, Any] | None  # 追问与回答 {question, options, span, answer}
    tm_hits: list[dict[str, Any]]  # 翻译记忆命中（TmHit VO）
    memory: dict[str, Any] | None  # memorize 节点的压缩结果 {summary, entities, memorizedUntil}


def add_usage(total: Usage | None, extra: Usage | None) -> Usage:
    total = total or Usage()
    if extra is None:
        return Usage(total.prompt_tokens, total.completion_tokens)
    return Usage(total.prompt_tokens + extra.prompt_tokens, total.completion_tokens + extra.completion_tokens)


def usage_vo(usage: Usage) -> dict[str, int]:
    return {"promptTokens": usage.prompt_tokens, "completionTokens": usage.completion_tokens}
