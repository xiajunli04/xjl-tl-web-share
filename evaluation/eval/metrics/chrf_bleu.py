"""参考指标（design D4）：文档级 d-chrF / d-BLEU 与句子级语料 chrF / BLEU。

- chrF：字符 6-gram、word n-gram=0（即 chrF 而非 chrF++），β=2，与 sacrebleu 默认一致
- BLEU：tokenize="zh"（汉字逐字切分，其他部分按 13a 规则），与 `sacrebleu -tok zh` 一致
- 文档级：把整篇译文与整篇参考各视为一个"句子"计算，因此不依赖段落对齐（参考译文是本地化改写）。
  计算前把换行压成空格，避免 BLEU 的分词对换行敏感
"""

from __future__ import annotations

import re
from collections.abc import Sequence

from sacrebleu.metrics import BLEU, CHRF


def _chrf() -> CHRF:
    return CHRF(char_order=6, word_order=0)


def _bleu() -> BLEU:
    return BLEU(tokenize="zh")


def _flatten(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def doc_chrf(hypothesis: str, reference: str) -> float:
    return _chrf().corpus_score([_flatten(hypothesis)], [[_flatten(reference)]]).score


def doc_bleu(hypothesis: str, reference: str) -> float:
    return _bleu().corpus_score([_flatten(hypothesis)], [[_flatten(reference)]]).score


def corpus_chrf(hypotheses: Sequence[str], references: Sequence[str]) -> float:
    return _chrf().corpus_score(list(hypotheses), [list(references)]).score


def corpus_bleu(hypotheses: Sequence[str], references: Sequence[str]) -> float:
    return _bleu().corpus_score(list(hypotheses), [list(references)]).score
