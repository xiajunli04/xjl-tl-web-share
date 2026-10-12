"""结构化解析（design D3）：把 Markdown / TXT 切分为段落序列。

每段由 prefix（结构标记）、source（需要翻译的正文）、suffix（行尾与块间空白）组成，
所有段的 ``prefix + source + suffix`` 依次拼接后与原文逐字节相同（包括 CRLF 与文件末尾换行）。

Markdown 的做法：用 markdown-it-py 解析出叶子块（标题、段落、表格行、代码块、HTML 块、分隔线）及其源码行号，
再按行号切回原文；容器标记（``> ``、``- ``、``1. ``）与标题标记放进 prefix，行尾空白、ATX 标题的闭合 ``#``、
表格行尾的 ``|`` 和块之间的空行放进 suffix。没有被任何叶子块覆盖的非空行（如链接引用定义、表头分隔行）
单独成段并标记为不可翻译。
"""

import re
from dataclasses import dataclass
from typing import Any, Literal

from markdown_it import MarkdownIt

BlockType = Literal["heading", "paragraph", "list_item", "blockquote", "table_row", "code", "html", "blank", "hr"]

BOM = chr(0xFEFF)

# 与 markdown-it 的换行规则一致：CRLF、CR、LF 都是换行（不能用 str.splitlines，它还会按 U+2028 等字符切分）
_LINE_RE = re.compile(r"[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+\Z")
_EOL_RE = re.compile(r"(?:\r\n|\r|\n)\Z")
_BLANK_LINE_RE = re.compile(r"[ \t]*(?:\r\n|\r|\n)?\Z")

# 一层容器标记：引用 `>`，或列表标记 `-`/`+`/`*`/`1.`/`1)`（后面必须是空白或行尾）
_CONTAINER_RE = re.compile(r"[ \t]*(?:>[ \t]?|(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|(?=[\r\n]|\Z)))")
_ATX_RE = re.compile(r"[ \t]*#{1,6}(?:[ \t]+|(?=[\r\n]|\Z))")
_INDENT_RE = re.compile(r"[ \t]*")
_TABLE_LEAD_RE = re.compile(r"[ \t]*(?:\|[ \t]*)?")

# 行尾：普通块只剥离空白；ATX 标题还要剥离闭合的 #；表格行剥离行尾未转义的 |
_TRAIL_RE = re.compile(r"[ \t]*(?:\r\n|\r|\n)?\Z")
_ATX_TRAIL_RE = re.compile(r"(?:[ \t]+#+|^#+)?[ \t]*(?:\r\n|\r|\n)?\Z")
_TABLE_TRAIL_RE = re.compile(r"[ \t]*(?:(?<!\\)\|[ \t]*)?(?:\r\n|\r|\n)?\Z")

_md = MarkdownIt("commonmark").enable("table")


@dataclass
class Segment:
    seq: int
    block_type: str
    prefix: str
    source: str
    suffix: str
    translatable: bool
    level: int | None = None

    def to_dict(self) -> dict[str, Any]:
        """事件 / 状态中的形式（design D2 的 Segment，camelCase）。"""
        d: dict[str, Any] = {
            "seq": self.seq,
            "blockType": self.block_type,
            "prefix": self.prefix,
            "source": self.source,
            "suffix": self.suffix,
            "translatable": self.translatable,
        }
        if self.level is not None:
            d["level"] = self.level
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Segment":
        return cls(
            seq=d["seq"],
            block_type=d["blockType"],
            prefix=d["prefix"],
            source=d["source"],
            suffix=d["suffix"],
            translatable=d["translatable"],
            level=d.get("level"),
        )


@dataclass
class _Leaf:
    start: int
    end: int  # 不含
    block_type: str
    translatable: bool
    level: int | None = None
    markers: int = 0  # 首行上需要剥离的容器标记层数
    atx: bool = False
    setext: bool = False


def split_lines(text: str) -> list[str]:
    """按换行切分并保留行尾；``"".join(split_lines(t)) == t``。"""
    return _LINE_RE.findall(text)


def join_segments(segments: list[Segment] | list[dict[str, Any]]) -> str:
    parts = []
    for s in segments:
        if isinstance(s, Segment):
            parts.append(s.prefix + s.source + s.suffix)
        else:
            parts.append(s["prefix"] + s["source"] + s["suffix"])
    return "".join(parts)


def parse_document(text: str, fmt: str) -> list[Segment]:
    """按格式解析；fmt 为 "md" 或 "txt"（其余按 txt 处理）。"""
    bom = text.startswith(BOM)
    body = text[1:] if bom else text
    segments = parse_markdown_body(body) if fmt == "md" else parse_text_body(body)
    if bom:
        if segments:
            segments[0].prefix = BOM + segments[0].prefix
        else:
            segments = [Segment(0, "blank", "", BOM, "", False)]
    return segments


# ---------------------------------------------------------------- TXT


def parse_text_body(text: str) -> list[Segment]:
    """纯文本：按空行切分段落，段内换行保留在 source 中。"""
    lines = split_lines(text)
    builder = _Builder()
    i = 0
    while i < len(lines):
        if _is_blank(lines[i]):
            builder.add_blank(lines[i])
            i += 1
            continue
        j = i
        while j < len(lines) and not _is_blank(lines[j]):
            j += 1
        block = "".join(lines[i:j])
        prefix = _INDENT_RE.match(block).group(0)
        builder.add_split(block, len(prefix), _TRAIL_RE, "paragraph", True)
        i = j
    return builder.segments


# ---------------------------------------------------------------- Markdown


def parse_markdown_body(text: str) -> list[Segment]:
    lines = split_lines(text)
    leaves, tables = _collect_leaves(text)
    builder = _Builder()
    pos = 0
    for leaf in leaves:
        start = max(leaf.start, pos)
        if start >= leaf.end:
            continue
        _add_gap(builder, lines, pos, start, tables)
        _add_leaf(builder, lines, leaf, start)
        pos = leaf.end
    _add_gap(builder, lines, pos, len(lines), tables)
    return builder.segments


def _collect_leaves(text: str) -> tuple[list[_Leaf], list[tuple[int, int]]]:
    """遍历块级 token，收集叶子块；tables 为表格的行号范围（用于识别表头分隔行）。"""
    leaves: list[_Leaf] = []
    tables: list[tuple[int, int]] = []
    stack: list[tuple[str, list[int] | None]] = []

    def markers_on(line: int) -> int:
        # 引用标记出现在每一行；列表标记只出现在列表项的第一行
        return sum(1 for kind, m in stack if kind == "bq" or (kind == "li" and m and m[0] == line))

    def list_depth() -> int:
        return sum(1 for kind, _ in stack if kind == "list")

    def inner_kind() -> str | None:
        for kind, _ in reversed(stack):
            if kind in ("bq", "li"):
                return kind
        return None

    for tok in _md.parse(text):
        t = tok.type
        if t in ("blockquote_open", "bullet_list_open", "ordered_list_open", "list_item_open", "table_open"):
            kind = {"blockquote_open": "bq", "list_item_open": "li", "table_open": "table"}.get(t, "list")
            stack.append((kind, tok.map))
            if t == "table_open" and tok.map:
                tables.append((tok.map[0], tok.map[1]))
            continue
        if t in ("blockquote_close", "bullet_list_close", "ordered_list_close", "list_item_close", "table_close"):
            if stack:
                stack.pop()
            continue
        if tok.map is None:
            continue
        s, e = tok.map
        if t == "heading_open":
            setext = tok.markup in ("=", "-")
            leaves.append(_Leaf(s, e, "heading", True, int(tok.tag[1:]), markers_on(s), atx=not setext, setext=setext))
        elif t == "paragraph_open":
            kind = inner_kind()
            if kind == "li":
                leaves.append(_Leaf(s, e, "list_item", True, list_depth(), markers_on(s)))
            elif kind == "bq":
                leaves.append(_Leaf(s, e, "blockquote", True, None, markers_on(s)))
            else:
                leaves.append(_Leaf(s, e, "paragraph", True, None, markers_on(s)))
        elif t == "tr_open":
            leaves.append(_Leaf(s, e, "table_row", True, None, markers_on(s)))
        elif t in ("fence", "code_block"):
            leaves.append(_Leaf(s, e, "code", False))
        elif t == "html_block":
            leaves.append(_Leaf(s, e, "html", False))
        elif t == "hr":
            leaves.append(_Leaf(s, e, "hr", False))
    leaves.sort(key=lambda lf: (lf.start, lf.end))
    return leaves, tables


def _add_gap(builder: "_Builder", lines: list[str], start: int, end: int, tables: list[tuple[int, int]]) -> None:
    """叶子块之间的行：空行并入上一段的 suffix；非空行单独成段（不可翻译）。"""
    i = start
    while i < end:
        if _is_blank(lines[i]):
            builder.add_blank(lines[i])
            i += 1
            continue
        j = i
        while j < end and not _is_blank(lines[j]):
            j += 1
        in_table = any(ts <= i < te for ts, te in tables)
        builder.add_raw("".join(lines[i:j]), "table_row" if in_table else "paragraph")
        i = j


def _add_leaf(builder: "_Builder", lines: list[str], leaf: _Leaf, start: int) -> None:
    block = "".join(lines[start : leaf.end])
    if not leaf.translatable:
        builder.add_raw(block, leaf.block_type)
        return
    first = lines[start]
    pos = 0
    for _ in range(leaf.markers):
        m = _CONTAINER_RE.match(first, pos)
        if not m:
            break
        pos = m.end()
    if leaf.atx:
        m = _ATX_RE.match(first, pos)
        if m:
            pos = m.end()
    if leaf.block_type == "table_row":
        pos = _TABLE_LEAD_RE.match(first, pos).end()
    else:
        pos = _INDENT_RE.match(first, pos).end()

    if leaf.setext:
        # 标题文字只在第一行；下划线行（=== / ---）放进 suffix
        text_block = "".join(lines[start : leaf.end - 1])
        builder.add_split(text_block, pos, _TRAIL_RE, "heading", True, leaf.level, extra_suffix=lines[leaf.end - 1])
        return
    trail = _ATX_TRAIL_RE if leaf.atx else _TABLE_TRAIL_RE if leaf.block_type == "table_row" else _TRAIL_RE
    builder.add_split(block, pos, trail, leaf.block_type, True, leaf.level)


def _is_blank(line: str) -> bool:
    return _BLANK_LINE_RE.fullmatch(line) is not None


class _Builder:
    def __init__(self) -> None:
        self.segments: list[Segment] = []

    def _append(self, block_type: str, prefix: str, source: str, suffix: str, translatable: bool, level=None):
        self.segments.append(Segment(len(self.segments), block_type, prefix, source, suffix, translatable, level))

    def add_blank(self, line: str) -> None:
        if self.segments:
            self.segments[-1].suffix += line
        else:
            self._append("blank", "", "", line, False)

    def add_raw(self, block: str, block_type: str) -> None:
        """不可翻译的块：正文放在 source，最后一个换行放在 suffix。"""
        m = _EOL_RE.search(block)
        cut = m.start() if m else len(block)
        self._append(block_type, "", block[:cut], block[cut:], False)

    def add_split(
        self,
        block: str,
        prefix_len: int,
        trail_re: re.Pattern[str],
        block_type: str,
        translatable: bool,
        level: int | None = None,
        extra_suffix: str = "",
    ) -> None:
        prefix = block[:prefix_len]
        body = block[prefix_len:]
        m = trail_re.search(body)
        cut = m.start() if m else len(body)
        source, suffix = body[:cut], body[cut:] + extra_suffix
        if not source.strip():
            # 空标题、只有标记的列表项等：没有可翻译内容
            translatable = False
        self._append(block_type, prefix, source, suffix, translatable, level)
