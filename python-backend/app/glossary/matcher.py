"""术语匹配与遵循校验（design D4）。

- 按源术语长度降序做最长匹配，已覆盖的区间不再重复匹配
- 拉丁、西里尔等以空格分词的文字：默认不区分大小写，要求词边界
- 中日韩、泰文：直接子串匹配
"""

import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from functools import lru_cache

from app.glossary.repository import Glossary, Term

# 按子串匹配的文字的码位区间：泰文、谚文、假名、中日韩统一表意文字、半角片假名
_SUBSTRING_RANGES = (
    (0x0E00, 0x0E7F),
    (0x1100, 0x11FF),
    (0x3040, 0x30FF),
    (0x3130, 0x318F),
    (0x3400, 0x4DBF),
    (0x4E00, 0x9FFF),
    (0xAC00, 0xD7AF),
    (0xF900, 0xFAFF),
    (0xFF66, 0xFF9F),
)
# 术语约束强度（improve-agent-from-experiments D1）：术语库命中与用户确认的术语为硬约束，
# 未经确认自动采用的抽取术语为软约束（只作参考译法，不参与规则检查与遵循判定）
HARD = "hard"
SOFT = "soft"

_SUBSTRING_SCRIPT = re.compile("[" + "".join(f"{chr(a)}-{chr(b)}" for a, b in _SUBSTRING_RANGES) + "]")


@dataclass
class TermHit:
    source: str
    target: str
    glossary_id: int
    case_sensitive: bool = False
    spans: list[tuple[int, int]] = field(default_factory=list)
    binding: str = HARD

    def __post_init__(self) -> None:
        # 检查点（msgpack）反序列化时元组会变成列表，这里统一还原
        self.spans = [tuple(s) for s in self.spans]

    def to_event(self) -> dict:
        return {"source": self.source, "target": self.target, "glossaryId": self.glossary_id}


@dataclass
class TermCompliance:
    source: str
    target: str
    compliant: bool

    def to_event(self) -> dict:
        return {"source": self.source, "target": self.target, "compliant": self.compliant}


@dataclass
class GlossarySelection:
    usable: list[Glossary]
    mismatched: list[int]  # 语言对不符
    unavailable: list[int]  # 不存在或已删除

    @property
    def skipped(self) -> list[int]:
        return self.mismatched + self.unavailable


def select_glossaries(
    glossary_ids: Sequence[int], loaded: dict[int, Glossary], source_lang: str, target_lang: str
) -> GlossarySelection:
    """按请求中的顺序挑出语言对与本次翻译一致的术语库。"""
    usable, mismatched, unavailable = [], [], []
    for gid in dict.fromkeys(glossary_ids):
        g = loaded.get(gid)
        if g is None:
            unavailable.append(gid)
        elif g.source_lang == source_lang and g.target_lang == target_lang:
            usable.append(g)
        else:
            mismatched.append(gid)
    return GlossarySelection(usable, mismatched, unavailable)


def uses_substring_match(term: str) -> bool:
    return bool(_SUBSTRING_SCRIPT.search(term))


@lru_cache(maxsize=4096)
def term_pattern(term: str, case_sensitive: bool) -> re.Pattern[str]:
    parts = term.split()
    body = r"\s+".join(re.escape(p) for p in parts) if parts else re.escape(term)
    if not uses_substring_match(term):
        body = rf"(?<!\w){body}(?!\w)"
    return re.compile(body, 0 if case_sensitive else re.IGNORECASE)


def term_present(term: str, text: str, case_sensitive: bool = False) -> bool:
    if not term.strip():
        return False
    return term_pattern(term, case_sensitive).search(text) is not None


def _overlaps(span: tuple[int, int], covered: Iterable[tuple[int, int]]) -> bool:
    s, e = span
    return any(s < ce and cs < e for cs, ce in covered)


class GlossaryMatcher:
    def match(self, text: str, glossaries: Sequence[Glossary]) -> list[TermHit]:
        """返回命中的术语，按在原文中首次出现的位置排序。"""
        ordered: list[tuple[int, Term]] = [
            (gi, t) for gi, g in enumerate(glossaries) for t in g.terms if t.source_term.strip()
        ]
        ordered.sort(key=lambda x: (-len(x[1].source_term), x[0], x[1].id))
        covered: list[tuple[int, int]] = []
        hits: list[TermHit] = []
        for _, term in ordered:
            spans = [
                m.span()
                for m in term_pattern(term.source_term, term.case_sensitive).finditer(text)
                if not _overlaps(m.span(), covered)
            ]
            if not spans:
                continue
            covered.extend(spans)
            hits.append(
                TermHit(
                    source=term.source_term,
                    target=term.target_term,
                    glossary_id=term.glossary_id,
                    case_sensitive=term.case_sensitive,
                    spans=spans,
                )
            )
        hits.sort(key=lambda h: h.spans[0][0])
        return hits


def check_compliance(hits: Sequence[TermHit], translation: str) -> list[TermCompliance]:
    """目标术语出现在译文中即视为遵循（大小写与边界规则同术语匹配）。"""
    return [TermCompliance(h.source, h.target, term_present(h.target, translation, h.case_sensitive)) for h in hits]
