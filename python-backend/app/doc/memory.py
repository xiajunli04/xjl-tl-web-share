"""篇章记忆（design D5 的上下文包）：任务术语表、全文摘要、滚动专名表、前块上下文。

按实验选项裁剪（design D12）：
- globalSummary=false：不放全文摘要
- contextWindow=false：不放前块上下文；前块上下文只在组内串行时存在（parallel 下每组只有 1 块）
- 滚动专名表只在组内共享（parallel 下各块之间不共享）
"""

from collections import OrderedDict
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

from app.agent.state import DEFAULT_DOMAIN, TranslationContext
from app.glossary.matcher import HARD, SOFT, TermHit, term_present

PREV_CONTEXT_SEGMENTS = 2
TASK_TERM_GLOSSARY_ID = 0  # 任务术语表没有对应的术语库，用 0 占位


@dataclass
class DocOptions:
    context_window: bool = True
    global_summary: bool = True
    term_extraction: bool = True
    review: bool = True
    translation_memory: bool = True

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "DocOptions":
        o = payload.get("options") or {}
        return cls(
            context_window=bool(o.get("contextWindow", True)),
            global_summary=bool(o.get("globalSummary", True)),
            term_extraction=bool(o.get("termExtraction", True)),
            review=bool(o.get("review", True)),
            translation_memory=bool(o.get("translationMemory", True)),
        )


@dataclass
class ChunkMemory:
    """分块翻译 user 消息中的篇章上下文部分。"""

    summary: str | None = None
    names: list[tuple[str, str]] = field(default_factory=list)
    prev: list[tuple[str, str]] = field(default_factory=list)  # (原文, 译文)
    tm: list[tuple[str, str]] = field(default_factory=list)  # 翻译记忆参考 (记忆原文, 记忆译文)


class RollingNames:
    """滚动专名表：同一源词保留最近一次的译法，提示词中只放最近的 limit 条。"""

    def __init__(self, items: Iterable[tuple[str, str]] = ()):
        self._items: OrderedDict[str, tuple[str, str]] = OrderedDict()
        self.update(items)

    def update(self, items: Iterable[tuple[str, str]]) -> None:
        for source, target in items:
            source, target = (source or "").strip(), (target or "").strip()
            if not source or not target:
                continue
            key = source.lower()
            self._items.pop(key, None)
            self._items[key] = (source, target)

    def recent(self, limit: int) -> list[tuple[str, str]]:
        items = list(self._items.values())
        return items[-limit:] if limit > 0 else []

    def __len__(self) -> int:
        return len(self._items)


def build_memory(
    options: DocOptions,
    *,
    summary: str | None,
    names: RollingNames | None,
    prev_pairs: list[tuple[str, str]] | None,
    max_names: int,
) -> ChunkMemory:
    return ChunkMemory(
        summary=(summary or None) if options.global_summary else None,
        names=names.recent(max_names) if names is not None else [],
        prev=list(prev_pairs or [])[-PREV_CONTEXT_SEGMENTS:] if options.context_window else [],
    )


def default_case_sensitive(source: str) -> bool:
    """抽取的术语与用户新增的术语：源词含大写字母时区分大小写（如资源名 Deployment 与普通词 deployment）。"""
    return source != source.lower()


def term_hits(terms: Iterable[dict[str, Any]]) -> list[TermHit]:
    """任务术语表 [{source, target, caseSensitive?, binding?}] 转为 TermHit，供提示词术语表与遵循校验复用。

    binding 缺失（旧检查点中的条目、单段重译接口传入的术语）时按硬约束处理。
    """
    hits = []
    for t in terms:
        source, target = str(t.get("source") or "").strip(), str(t.get("target") or "").strip()
        if source and target:
            case = t.get("caseSensitive")
            hits.append(
                TermHit(
                    source=source,
                    target=target,
                    glossary_id=TASK_TERM_GLOSSARY_ID,
                    case_sensitive=default_case_sensitive(source) if case is None else bool(case),
                    binding=binding_of(t),
                )
            )
    return hits


def binding_of(term: dict[str, Any]) -> str:
    return SOFT if str(term.get("binding") or "").strip().lower() == SOFT else HARD


def terms_for_text(hits: list[TermHit], text: str) -> list[TermHit]:
    return [h for h in hits if term_present(h.source, text, h.case_sensitive)]


def hard_hits(hits: Iterable[TermHit]) -> list[TermHit]:
    """硬约束术语：参与规则术语检查与遵循判定。"""
    return [h for h in hits if h.binding == HARD]


def chunk_context(
    hits: list[TermHit], chunk_text: str, *, domain: str | None, style: str, max_terms: int
) -> TranslationContext:
    """系统提示词的上下文包：术语表较大时只放本块出现的术语。"""
    terms = hits if len(hits) <= max_terms else terms_for_text(hits, chunk_text)
    return TranslationContext(
        terms=list(terms),
        domain_hint=None if not domain or domain == DEFAULT_DOMAIN else domain,
        style=style,
    )
