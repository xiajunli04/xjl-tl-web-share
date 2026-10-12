"""术语与专名指标（design D4）：按出现次数的术语准确率、术语一致率、专名一致率，以及术语锁定判定。

匹配规则
--------
- 预处理：去掉行内代码（`` `...` ``）与 Markdown 链接目标（`](...)`），两边都不参与匹配
- 英文源词：按词边界匹配（边界只看 ASCII 字母数字、下划线与连字符，避免 Python 的 \\w 把汉字当作单词字符），
  容忍规则复数（-s / -es），遵守条目的 caseSensitive
- 译法：
  * 纯拉丁字母译法（如 "Pod"、"Deployment"）同样按 ASCII 词边界匹配并容忍复数；中文语境里保留英文的写法
    大小写差异不视为术语错误，因此不区分大小写
  * 含汉字的译法按子串计数，其中的空白可有可无（"Init 容器" 与 "Init容器" 等价）

"不被子串误导"的屏蔽规则（保守实现）
-----------------------------------
统计某个写法 r 时，先找出"包含 r 的更长写法"在文本中的出现位置，落在这些位置内的 r 不计数：
  1. 金标表中所有条目的金标译法、变体和 blockers 中，包含 r 且比 r 长的写法（例如统计"部署"时屏蔽
     "金丝雀部署"；统计 "Pod" 时屏蔽另一条目的 "Pod 模板"）
  2. 以汉字开头的写法 r，自动屏蔽 "可" + r（"可部署""可调度"这类形容词性普通词）
  3. 条目可在 blockers 中列出其他含有译法的普通词（例如 "部署单元"）
源词一侧对称处理：统计源词 s 时屏蔽金标表中包含 s 的更长源词（"Pod template" 中的 Pod 不计入 Pod）。

局限：中文没有词边界，规则 2、3 之外的普通词（例如动词"部署"）无法与术语"部署"区分；
因此当金标译法本身是常见词时，准确率可能偏高。这一点在实验报告中说明，本测试集的金标译法
多数为保留英文的资源名或专业名词，受影响有限。
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field, replace

_INLINE_CODE = re.compile(r"`[^`\n]*`")
_LINK_TARGET = re.compile(r"\]\([^)\s]*\)")
_CJK = re.compile(r"[㐀-鿿豈-﫿]")
_ASCII_WORD = r"A-Za-z0-9_"


@dataclass(frozen=True)
class TermEntry:
    source: str
    target: str
    variants: tuple[str, ...] = ()
    case_sensitive: bool = False
    kind: str = "term"  # term | proper_noun
    blockers: tuple[str, ...] = ()

    @property
    def renderings(self) -> tuple[str, ...]:
        """金标在前，其余为变体（去重保持顺序）。"""
        seen: dict[str, None] = {}
        for r in (self.target, *self.variants):
            seen.setdefault(r, None)
        return tuple(seen)

    @classmethod
    def from_dict(cls, d: dict) -> TermEntry:
        return cls(
            source=d["source"],
            target=d["target"],
            variants=tuple(d.get("variants") or ()),
            case_sensitive=bool(d.get("caseSensitive", False)),
            kind=d.get("kind", "term"),
            blockers=tuple(d.get("blockers") or ()),
        )


def strip_markup(text: str) -> str:
    """去掉行内代码与链接目标（替换为空格，避免把两侧文字拼成新词）。"""
    text = _INLINE_CODE.sub(" ", text)
    return _LINK_TARGET.sub("] ", text)


def _is_cjk(s: str) -> bool:
    return bool(_CJK.search(s))


def source_pattern(term: str, case_sensitive: bool) -> re.Pattern[str]:
    body = r"\s+".join(re.escape(p) for p in term.split())
    flags = 0 if case_sensitive else re.IGNORECASE
    return re.compile(rf"(?<![{_ASCII_WORD}-]){body}(?:e?s)?(?![{_ASCII_WORD}-])", flags)


def target_pattern(rendering: str) -> re.Pattern[str]:
    parts = rendering.split()
    body = r"\s*".join(re.escape(p) for p in parts)
    if _is_cjk(rendering):
        head = rf"(?<![{_ASCII_WORD}])" if re.match(r"[A-Za-z0-9]", rendering) else ""
        tail = rf"(?![{_ASCII_WORD}])" if re.search(r"[A-Za-z0-9]$", rendering) else ""
        return re.compile(head + body + tail, re.IGNORECASE)
    return re.compile(rf"(?<![{_ASCII_WORD}]){body}(?:e?s)?(?![{_ASCII_WORD}])", re.IGNORECASE)


def _spans(pattern: re.Pattern[str], text: str) -> list[tuple[int, int]]:
    return [m.span() for m in pattern.finditer(text)]


def _count_unmasked(pattern: re.Pattern[str], text: str, masks: Iterable[re.Pattern[str]]) -> int:
    masked = [s for p in masks for s in _spans(p, text)]
    n = 0
    for a, b in _spans(pattern, text):
        if not any(ma < b and a < mb for ma, mb in masked):
            n += 1
    return n


class TermMatcher:
    """预编译金标表的全部模式与屏蔽关系。"""

    def __init__(self, entries: Sequence[TermEntry]):
        self.entries = list(entries)
        pool: dict[str, None] = {}
        for e in self.entries:
            for s in (*e.renderings, *e.blockers):
                pool.setdefault(s, None)
        for r in list(pool):
            if _is_cjk(r[0]):
                pool.setdefault("可" + r, None)
        self._target_pool = list(pool)
        self._src_pat = {id(e): source_pattern(e.source, e.case_sensitive) for e in self.entries}
        self._src_masks = {
            id(e): [
                source_pattern(o.source, o.case_sensitive)
                for o in self.entries
                if o is not e and len(o.source) > len(e.source) and e.source.lower() in o.source.lower()
            ]
            for e in self.entries
        }
        self._tgt_pat: dict[str, re.Pattern[str]] = {}
        self._tgt_masks: dict[str, list[re.Pattern[str]]] = {}
        for e in self.entries:
            for r in e.renderings:
                if r in self._tgt_pat:
                    continue
                key = _norm(r)
                self._tgt_pat[r] = target_pattern(r)
                self._tgt_masks[r] = [
                    target_pattern(s) for s in self._target_pool if len(_norm(s)) > len(key) and key in _norm(s)
                ]

    def count_source(self, entry: TermEntry, text: str) -> int:
        return _count_unmasked(self._src_pat[id(entry)], strip_markup(text), self._src_masks[id(entry)])

    def count_rendering(self, rendering: str, text: str) -> int:
        return _count_unmasked(self._tgt_pat[rendering], strip_markup(text), self._tgt_masks[rendering])


def _norm(s: str) -> str:
    return re.sub(r"\s+", "", s).lower()


@dataclass
class TermStat:
    source: str
    kind: str
    occurrences: int = 0  # 原文中出现次数
    hits: int = 0  # 按出现次数计入的金标译法次数
    renderings: Counter = field(default_factory=Counter)

    @property
    def accuracy(self) -> float | None:
        return self.hits / self.occurrences if self.occurrences else None

    @property
    def consistency(self) -> float | None:
        total = sum(self.renderings.values())
        return max(self.renderings.values()) / total if total else None


@dataclass
class TermReport:
    accuracy: float | None  # 按出现次数加权
    consistency: float | None  # 按术语取平均
    proper_noun_consistency: float | None
    occurrences: int
    terms: list[TermStat]


def _mean(xs: list[float]) -> float | None:
    return sum(xs) / len(xs) if xs else None


def evaluate_terms(pairs: Iterable[tuple[str, str | None]], entries: Sequence[TermEntry]) -> TermReport:
    """pairs：逐段的（原文段落，译文段落）；译文缺失时视为未遵循。"""
    matcher = TermMatcher(entries)
    stats = {id(e): TermStat(e.source, e.kind) for e in entries}
    for source, target in pairs:
        tgt = target or ""
        for e in entries:
            n_src = matcher.count_source(e, source)
            if n_src == 0:
                continue
            st = stats[id(e)]
            st.occurrences += n_src
            st.hits += min(matcher.count_rendering(e.target, tgt), n_src)
            for r in e.renderings:
                c = matcher.count_rendering(r, tgt)
                if c:
                    st.renderings[r] += c
    terms = list(stats.values())
    occ = sum(t.occurrences for t in terms)
    hits = sum(t.hits for t in terms)
    cons = [t.consistency for t in terms if t.consistency is not None]
    pn = [t.consistency for t in terms if t.kind == "proper_noun" and t.consistency is not None]
    return TermReport(
        accuracy=hits / occ if occ else None,
        consistency=_mean(cons),
        proper_noun_consistency=_mean(pn),
        occurrences=occ,
        terms=terms,
    )


# ---------------------------------------------------------------- 术语锁定（improve-agent-from-experiments design D6）

LOCKIN_MIN_OCCURRENCES = 3
LOCKIN_KEEP_RATIO = 0.2


@dataclass(frozen=True)
class LockinTerm:
    source: str
    occurrences: int
    kept: int

    @property
    def keep_ratio(self) -> float:
        return self.kept / self.occurrences


def detect_lockin(
    pairs: Iterable[tuple[str, str | None]],
    entries: Sequence[TermEntry],
    *,
    min_occurrences: int = LOCKIN_MIN_OCCURRENCES,
    keep_ratio: float = LOCKIN_KEEP_RATIO,
) -> list[LockinTerm]:
    """产出侧的锁定判定：金标译法与源词相同（应保留原文）的术语，原文中区分大小写出现至少 min_occurrences 次，
    而对应译文段中保留源词的比例低于 keep_ratio，即视为被系统性地译掉。

    源词按区分大小写统计（"Service" 资源名与普通词 "service" 区分开）；保留与否沿用译法的匹配规则。
    返回发生锁定的术语（空列表表示该运行未发生锁定）。
    """
    keep = [e for e in entries if e.target == e.source]
    if not keep:
        return []
    forced = {id(e): replace(e, case_sensitive=True) for e in keep}
    report = evaluate_terms(list(pairs), [forced.get(id(e), e) for e in entries])
    keep_sources = {e.source for e in keep}
    locked = []
    for st in report.terms:
        if st.source in keep_sources and st.occurrences >= min_occurrences and st.hits / st.occurrences < keep_ratio:
            locked.append(LockinTerm(st.source, st.occurrences, st.hits))
    return locked
