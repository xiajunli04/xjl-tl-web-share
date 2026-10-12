"""译文输出清理（improve-prompts-and-context-memory D1）：去掉模型偶尔加在开头的"译文：""Translation:"等标签和包裹引号。

- LeadingCleaner：流式过滤。只在开头可能是标签或引号时缓冲（最多 HOLD 个字符），一旦确定就原样放行后续增量，
  因此普通输出在首个增量就放行，不增加首字延迟
- clean_final：定稿文本的同样处理，另外去掉成对的包裹引号（原话本身带引号时保留）
"""

import re

HOLD = 16
_LABELS = ("译文", "翻译", "字幕", "translation", "translated text", "subtitle")
_LABEL_RE = re.compile(r"^\s*(?:译文|翻译|字幕|translation|translated text|subtitle)\s*[:：]\s*", re.IGNORECASE)
QUOTES = {'"': '"', "“": "”", "「": "」", "『": "』", "«": "»", "„": "“"}


def _strip_label(text: str) -> str:
    return _LABEL_RE.sub("", text, count=1)


def _undecided(buf: str) -> bool:
    """开头是否仍可能是一个标签（还没出现冒号）。"""
    s = buf.lstrip().lower()
    if not s:
        return True
    for label in _LABELS:
        if label.startswith(s):
            return True
        if s.startswith(label):
            return not s[len(label) :].strip()
    return False


class LeadingCleaner:
    def __init__(self, source: str):
        self._source_quoted = source.lstrip()[:1] in QUOTES
        self._buf = ""
        self._released = False
        self._skip_space = False  # 标签已去掉但正文还没到：跳过后续增量开头的空白

    def feed(self, delta: str) -> str:
        if self._released:
            if self._skip_space:
                delta = delta.lstrip()
                self._skip_space = not delta
            return delta
        self._buf += delta
        if len(self._buf) < HOLD and _undecided(self._buf):
            return ""
        return self._release()

    def flush(self) -> str:
        """流结束：冲出仍在缓冲的内容。"""
        return "" if self._released else self._release()

    def _release(self) -> str:
        self._released = True
        text = _strip_label(self._buf)
        stripped = text.lstrip()
        if stripped[:1] in QUOTES and not self._source_quoted:
            text = stripped[1:]
        if text != self._buf:
            text = text.lstrip()
            self._skip_space = not text
        self._buf = ""
        return text


def clean_final(text: str, source: str) -> str:
    s = _strip_label(text).strip()
    if len(s) >= 2 and QUOTES.get(s[0]) == s[-1] and source.lstrip()[:1] not in QUOTES:
        s = s[1:-1].strip()
    return s
