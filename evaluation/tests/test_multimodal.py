"""add-speech-and-image-translation 11.5：E4 / E5 指标与数据集校验。"""

import pytest

from eval.multimodal import image_dataset, speech_dataset
from eval.multimodal.metrics import (
    char_accuracy,
    edit_distance,
    error_rate,
    iou,
    match_boxes,
    normalize_chars,
    percentile,
)


def test_edit_distance_basic():
    assert edit_distance("kitten", "sitting") == 3
    assert edit_distance([], ["a"]) == 1
    assert edit_distance("abc", "abc") == 0


def test_cer_ignores_punctuation_and_width():
    # ASR 常缺标点、全角半角不一致，这些不算错误
    assert error_rate("大家好，今天开会。", "大家好今天开会", "zh") == 0.0
    assert error_rate("ＡＢＣ１２３", "abc123", "zh") == 0.0
    assert normalize_chars("Hello, 世界！") == list("hello世界")


def test_cer_counts_substitution():
    assert error_rate("今天开会", "今天开车", "zh") == pytest.approx(0.25)
    # 日语、韩语、粤语同样按字计
    assert error_rate("すみません", "すみません", "ja") == 0.0
    assert error_rate("안녕하세요", "안녕하세오", "ko") == pytest.approx(0.2)


def test_wer_for_english():
    assert error_rate("Revenue grew twelve percent.", "revenue grew 12 percent", "en") == pytest.approx(0.25)
    assert error_rate("", "", "en") == 0.0
    assert error_rate("", "noise", "en") == 1.0


def test_char_accuracy_clamped():
    assert char_accuracy("宫保鸡丁", "宫保鸡丁") == 1.0
    assert char_accuracy("宫保鸡丁", "宫保鸡") == pytest.approx(0.75)
    assert char_accuracy("出口", "完全不同的很长的文字") == 0.0


def test_iou():
    assert iou([0, 0, 1, 1], [0, 0, 1, 1]) == 1.0
    assert iou([0, 0, 1, 1], [1, 1, 2, 2]) == 0.0
    assert iou([0, 0, 2, 1], [1, 0, 3, 1]) == pytest.approx(1 / 3)
    assert iou([0, 0, 0, 0], [0, 0, 0, 0]) == 0.0


def test_match_boxes_greedy_one_to_one():
    truth = [[0, 0, 10, 10], [0, 20, 10, 30], [0, 40, 10, 50]]
    pred = [[0, 21, 10, 31], [0, 0, 10, 10], [100, 100, 110, 110]]
    pairs = match_boxes(truth, pred)
    assert [(i, j) for i, j, _ in pairs] == [(0, 1), (1, 0)]
    # 一个预测框不能匹配两个真值框
    assert len(match_boxes([[0, 0, 10, 10], [0, 0, 10, 10]], [[0, 0, 10, 10]])) == 1


def test_percentile():
    assert percentile([1, 2, 3, 4], 50) == pytest.approx(2.5)
    assert percentile([5], 90) == 5
    assert percentile([], 50) is None
    assert percentile([1, None, 3], 50) == 2


def test_speech_dataset_complete():
    assert speech_dataset.check() == []
    rows = speech_dataset.load_sentences()
    assert {r["targetLang"] for r in rows if r["lang"] != "zh"} == {"zh"}
    assert sum(1 for r in rows if r["context"]) == 5
    assert sum(len(r["terms"]) for r in rows) == 6


def test_image_dataset_complete():
    assert image_dataset.check() == []
    rows = image_dataset.load_truth()
    assert {(r["scene"], r["sourceLang"]) for r in rows} == {
        (s, lang) for s in ("sign", "menu", "label") for lang in ("zh", "en", "ja")
    }
    assert all(3 <= len(r["blocks"]) <= 6 for r in rows)
