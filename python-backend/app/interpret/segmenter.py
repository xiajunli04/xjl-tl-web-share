"""流式文本增量切段（improve-speech-playback-latency D4）：把 LLM 的流式输出切成可独立合成的语音段。

- 句末边界：中日全角与半角句末标点（。！？!?…），英文句点须后跟空白（避免切开 3.5、e.g.）
- 分句边界：逗号、顿号、分号、冒号（半角须后跟空白）。只在首段（尽早开口）或片段已足够长（≥ clause_min）时使用，
  避免切得过碎导致合成语调断裂
- 长度按"字"计：中日韩字符每字 1，其他语言每词折算 3（12 字 ≈ 4 个英文词）
- 首段达到 first_min 即可切出，后续段至少 min_chars；不足时并入下一段，流结束时 flush 剩余
"""

import re

_CJK = r"぀-ヿ㐀-䶿一-鿿가-힯豈-﫿"
_CJK_CHAR = re.compile(rf"[{_CJK}]")
_WORD = re.compile(rf"[^\s{_CJK}\W]+(?:['’][^\s\W]+)?", re.UNICODE)
# 句末标点（可带右引号/括号），或后跟空白的英文句点
_SENTENCE_END = re.compile(r"([。！？!?…]+[\"'”’）)」』]*|\.(?=\s))\s*")
# 句末 + 分句标点；半角逗号等须后跟空白
_ANY_END = re.compile(r"([。！？!?…]+[\"'”’）)」』]*|[，、；：]|[.,;:](?=\s))\s*")
_SENTENCE_PUNCT = re.compile(r"[。！？!?…]|\.$")

DEFAULT_FIRST_MIN = 8
DEFAULT_MIN_CHARS = 12
CLAUSE_MIN_FACTOR = 2  # 非首段在分句边界切开所需长度 = min_chars × 2


def text_weight(text: str) -> int:
    """切段长度：中日韩字符每字 1，其他语言每词 3。"""
    cjk = len(_CJK_CHAR.findall(text))
    words = len(_WORD.findall(_CJK_CHAR.sub(" ", text)))
    return cjk + words * 3


class SentenceSegmenter:
    def __init__(self, first_min: int = DEFAULT_FIRST_MIN, min_chars: int = DEFAULT_MIN_CHARS):
        self.first_min = first_min
        self.min_chars = min_chars
        self.clause_min = min_chars * CLAUSE_MIN_FACTOR
        self._buffer = ""
        self._emitted = 0

    def feed(self, delta: str) -> list[str]:
        """追加一段流式文本，返回新切出的完整段（可能为空）。"""
        self._buffer += delta
        out: list[str] = []
        start = 0
        for m in _ANY_END.finditer(self._buffer):
            piece = self._buffer[start : m.end()]
            if not self._ready(piece, m.group(1)):
                continue
            text = piece.strip()
            if text:
                out.append(text)
                self._emitted += 1
            start = m.end()
        self._buffer = self._buffer[start:]
        return out

    def flush(self) -> str | None:
        """流结束：返回剩余文本（不论长短）。"""
        text, self._buffer = self._buffer.strip(), ""
        if not text:
            return None
        self._emitted += 1
        return text

    def _ready(self, piece: str, punct: str) -> bool:
        weight = text_weight(piece)
        if self._emitted == 0:
            return weight >= self.first_min
        if _SENTENCE_PUNCT.search(punct.strip()):
            return weight >= self.min_chars
        return weight >= self.clause_min


def split_sentences(buffer: str, min_chars: int = 6) -> tuple[list[str], str]:
    """把文本缓冲切成完整句子与剩余部分（只按句末标点）；过短的句子并入下一句。

    add-ai-avatar-and-landing 的旧接口，保留供兼容；新代码使用 SentenceSegmenter。
    """
    sentences: list[str] = []
    start = 0
    pending = ""
    for m in _SENTENCE_END.finditer(buffer):
        piece = pending + buffer[start : m.end()]
        start = m.end()
        if len(piece.strip()) < min_chars:
            pending = piece
            continue
        sentences.append(piece.strip())
        pending = ""
    return sentences, pending + buffer[start:]
