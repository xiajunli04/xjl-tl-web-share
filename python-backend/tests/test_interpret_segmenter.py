"""流式文本增量切段（improve-speech-playback-latency 2.2）。"""

import pytest

from app.interpret.segmenter import SentenceSegmenter, split_sentences, text_weight


def _feed_all(seg: SentenceSegmenter, deltas: list[str]) -> list[str]:
    out = [s for d in deltas for s in seg.feed(d)]
    rest = seg.flush()
    return out + ([rest] if rest else [])


@pytest.mark.parametrize(
    ("text", "weight"),
    [
        ("你好世界", 4),
        ("Hello there", 6),
        ("I'm fine", 6),
        ("今天 meeting 开始", 7),
        ("こんにちは", 5),
        ("안녕하세요", 5),
    ],
)
def test_text_weight(text, weight):
    assert text_weight(text) == weight


def test_first_segment_cuts_at_clause_then_sentences_only():
    seg = SentenceSegmenter(first_min=8, min_chars=12)
    deltas = ["如果错误率超过", "千分之一，", "就立即回滚，", "并通知值班同事。", "其余按原计划执行。"]
    assert _feed_all(seg, deltas) == ["如果错误率超过千分之一，", "就立即回滚，并通知值班同事。", "其余按原计划执行。"]


def test_short_first_clause_waits_for_more():
    seg = SentenceSegmenter(first_min=8)
    assert seg.feed("好的，") == []  # 2 字不足首段长度
    assert seg.feed("我们马上安排人去处理这个问题。") == ["好的，我们马上安排人去处理这个问题。"]


def test_fast_mode_first_min():
    seg = SentenceSegmenter(first_min=4)
    assert seg.feed("好的好的，马上") == ["好的好的，"]


def test_english_needs_whitespace_after_period_and_comma():
    seg = SentenceSegmenter(first_min=8, min_chars=12)
    out = seg.feed("Version 3.5 is out, ")  # "3.5" 不切；逗号后有空白可切（首段 4 词 = 12）
    assert out == ["Version 3.5 is out,"]
    assert seg.feed("and we will roll it out") == []  # 尚无边界
    assert seg.feed(" next week. Thanks") == ["and we will roll it out next week."]
    assert seg.flush() == "Thanks"


def test_later_long_clause_can_split():
    seg = SentenceSegmenter(first_min=8, min_chars=12)
    assert seg.feed("Sure thing. ") == []  # 2 词 = 6 < 8
    out = seg.feed("Sure thing. We have a quiet table by the window for two people, ")
    assert out == ["Sure thing. Sure thing.", "We have a quiet table by the window for two people,"]
    out = seg.feed("and the chef recommends the grilled fish with seasonal vegetables and a light sauce, ")
    assert out == ["and the chef recommends the grilled fish with seasonal vegetables and a light sauce,"]  # ≥ 24


def test_japanese_and_quotes():
    seg = SentenceSegmenter(first_min=8, min_chars=12)
    deltas = ["いらっしゃいませ。", "「こちらへどうぞ」と案内します！", "ご注文は"]
    assert _feed_all(seg, deltas) == ["いらっしゃいませ。", "「こちらへどうぞ」と案内します！", "ご注文は"]


def test_flush_empty():
    seg = SentenceSegmenter()
    assert seg.flush() is None
    seg.feed("   ")
    assert seg.flush() is None


def test_split_sentences_compat():
    done, rest = split_sentences("Hi! Welcome to our place. We have 3.5 kinds of ")
    assert done == ["Hi! Welcome to our place."] and rest == "We have 3.5 kinds of "
