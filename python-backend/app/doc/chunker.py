"""分块与执行策略分组（design D4 / D5 plan_chunks）。

- 按段落累积估算的 token 数，达到目标值（默认 1800）时切块；加入下一段会超过上限（默认 3000）时提前切块
- 不跨一级、二级标题；不拆开单个段落（超长段落单独成块）
- group 为所属章节编号：每遇到一个一级 / 二级标题（且前面已有内容）编号加 1，文档开头没有标题时为 0
- 只含不可翻译段落的块 translatable=false，执行时不调用 LLM
"""

import math
import re
from dataclasses import dataclass, field
from typing import Any

from app.doc.parser import Segment

Strategy = str  # "serial" | "parallel" | "hybrid"
STRATEGIES = ("serial", "parallel", "hybrid")

# 中日韩统一表意文字、假名、谚文、全角标点：每个字符按 1 个 token 估算
_CJK_RE = re.compile(r"[　-〿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]")


def estimate_tokens(text: str) -> int:
    """粗略估算：中日韩字符按 1 计，其余按每 4 个字符 1 计（只用于分块）。"""
    if not text:
        return 0
    cjk = len(_CJK_RE.findall(text))
    return cjk + math.ceil((len(text) - cjk) / 4)


@dataclass
class Chunk:
    index: int
    seg_seqs: list[int] = field(default_factory=list)
    group: int = 0
    translatable: bool = False
    tokens: int = 0

    def to_dict(self) -> dict[str, Any]:
        """状态中的形式；事件中只发 index / segSeqs / group（见 to_event）。"""
        return {
            "index": self.index,
            "segSeqs": list(self.seg_seqs),
            "group": self.group,
            "translatable": self.translatable,
            "tokens": self.tokens,
        }

    def to_event(self) -> dict[str, Any]:
        return {"index": self.index, "segSeqs": list(self.seg_seqs), "group": self.group}


def _is_section_break(seg: Segment) -> bool:
    return seg.block_type == "heading" and (seg.level or 9) <= 2


def chunk_segments(segments: list[Segment], target_tokens: int = 1800, max_tokens: int = 3000) -> list[Chunk]:
    chunks: list[Chunk] = []
    current: Chunk | None = None
    group = 0
    seen_content = False

    def flush() -> None:
        nonlocal current
        if current is not None and current.seg_seqs:
            chunks.append(current)
        current = None

    for seg in segments:
        tokens = estimate_tokens(seg.source) if seg.translatable else 0
        if _is_section_break(seg):
            if seen_content:
                group += 1
            flush()
        elif current is not None and current.tokens > 0 and current.tokens + tokens > max_tokens:
            flush()
        if current is None:
            current = Chunk(index=len(chunks), group=group)
        current.seg_seqs.append(seg.seq)
        current.tokens += tokens
        current.translatable = current.translatable or seg.translatable
        if seg.block_type != "blank":
            seen_content = True
        if current.tokens >= target_tokens:
            flush()
    flush()
    return chunks


def plan_groups(chunks: list[Chunk] | list[dict[str, Any]], strategy: Strategy) -> list[list[int]]:
    """serial：全部块 1 组；parallel：每块 1 组；hybrid：每个章节（group）1 组。组内按块序号排列。"""
    items = [(c.index, c.group) if isinstance(c, Chunk) else (c["index"], c["group"]) for c in chunks]
    if not items:
        return []
    if strategy == "parallel":
        return [[i] for i, _ in items]
    if strategy == "hybrid":
        groups: dict[int, list[int]] = {}
        for i, g in items:
            groups.setdefault(g, []).append(i)
        return [groups[g] for g in sorted(groups)]
    return [[i for i, _ in items]]
