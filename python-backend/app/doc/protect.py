"""行内内容保护（design D3）。

发给 LLM 之前，把段落中的行内代码、图片、自动链接、HTML 标签、Markdown 链接目标、URL、邮箱和占位符
（``{name}``、``{{var}}``、``${var}``、``%s``）替换为 ``⟦0⟧``、``⟦1⟧`` 等编号标记，译后按编号还原。
表格行的单元格分隔符 ``|`` 与多行引用中每行开头的 ``>`` 也作为标记保护，避免模型改动结构。

还原时校验：每个编号必须恰好出现一次，不能出现未知编号；否则视为失败，由调用方单独重译。
"""

import re
from dataclasses import dataclass, field

MARK_OPEN, MARK_CLOSE = "⟦", "⟧"

_BASE_PATTERNS = (
    r"(`+)(?!`).+?(?<!`)\1(?!`)",  # 行内代码（可跨行）
    r"!\[[^\]\n]*\]\([^)\n]*\)",  # 图片
    r"<(?:https?|ftp|mailto):[^>\s]+>",  # 自动链接
    r"<!--.*?-->",  # HTML 注释
    r"</?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*?)?/?>",  # HTML 标签
    r"\]\([^)\n]*\)",  # 链接目标 ](url "title")
    r"\]\[[^\]\n]*\]",  # 引用式链接 ][id]
    r"(?:https?://|www\.)[^\s<>\"'`]+",  # URL（结尾标点在回调中剥离）
    r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+",  # 邮箱
    r"\{\{[^{}\n]+\}\}|\$\{[^{}\n]+\}|\{[A-Za-z_][\w.]*\}|\{\d+\}",  # {{var}} / ${var} / {name} / {0}
    r"%(?:\d+\$)?[-+0#]?\d*(?:\.\d+)?[sdifuxXeEgGc@](?![A-Za-z])",  # printf 风格
    r"[⟦⟧]",  # 原文中恰好出现的标记字符本身
)
_TABLE_PIPE = r"[ \t]*(?<!\\)\|[ \t]*"
_QUOTE_MARK = r"(?<=\n)[ \t]*>(?:[ \t]?>)*[ \t]?"

_URL_TRAILING = ".,;:!?。，；：！？"


def _compile(*extra: str) -> re.Pattern[str]:
    return re.compile("|".join(f"(?:{p})" for p in (*extra, *_BASE_PATTERNS)), re.DOTALL)


_PATTERNS = {
    (False, False): _compile(),
    (True, False): _compile(_TABLE_PIPE),
    (False, True): _compile(_QUOTE_MARK),
    (True, True): _compile(_TABLE_PIPE, _QUOTE_MARK),
}
_MARK_RE = re.compile(r"⟦\s*(\d+)\s*⟧")


def mark(i: int) -> str:
    return f"{MARK_OPEN}{i}{MARK_CLOSE}"


@dataclass
class Protected:
    text: str  # 带标记的文本
    spans: list[str] = field(default_factory=list)  # 下标即标记编号


@dataclass
class RestoreResult:
    text: str
    ok: bool
    missing: list[int] = field(default_factory=list)
    duplicated: list[int] = field(default_factory=list)
    unknown: list[int] = field(default_factory=list)

    @property
    def problem(self) -> str:
        parts = []
        if self.missing:
            parts.append(f"缺失标记 {self.missing}")
        if self.duplicated:
            parts.append(f"重复标记 {self.duplicated}")
        if self.unknown:
            parts.append(f"未知标记 {self.unknown}")
        return "，".join(parts)


def _trim_url(s: str) -> tuple[str, str]:
    """剥离 URL 结尾的标点；右括号只在不配对时剥离。"""
    end = len(s)
    while end > 0:
        ch = s[end - 1]
        if ch in _URL_TRAILING or (ch == ")" and s[:end].count("(") < s[:end].count(")")):
            end -= 1
            continue
        break
    return s[:end], s[end:]


def protect(text: str, *, table_row: bool = False, quote: bool = False) -> Protected:
    spans: list[str] = []

    def repl(m: re.Match[str]) -> str:
        s = m.group(0)
        tail = ""
        if s.startswith(("http://", "https://", "www.")):
            s, tail = _trim_url(s)
            if not s:
                return m.group(0)
        spans.append(s)
        return mark(len(spans) - 1) + tail

    out = _PATTERNS[(table_row, quote)].sub(repl, text)
    return Protected(out, spans)


def protect_segment(source: str, block_type: str, prefix: str = "") -> Protected:
    return protect(source, table_row=block_type == "table_row", quote=">" in prefix)


def plain_text(text: str) -> str:
    """把受保护内容替换为标记后的文本，用于术语匹配：代码、URL 等内容中的单词不算术语出现。"""
    return protect(text).text


def restore(text: str, spans: list[str]) -> RestoreResult:
    counts: dict[int, int] = {}
    for m in _MARK_RE.finditer(text):
        i = int(m.group(1))
        counts[i] = counts.get(i, 0) + 1
    n = len(spans)
    missing = [i for i in range(n) if counts.get(i, 0) == 0]
    duplicated = [i for i in range(n) if counts.get(i, 0) > 1]
    unknown = sorted(i for i in counts if i >= n)

    def repl(m: re.Match[str]) -> str:
        i = int(m.group(1))
        return spans[i] if i < n else m.group(0)

    restored = _MARK_RE.sub(repl, text)
    return RestoreResult(restored, not (missing or duplicated or unknown), missing, duplicated, unknown)
