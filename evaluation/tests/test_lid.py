"""语种识别：映射、范围外计为错误、样本切分规则、LLM 批量解析与重试。"""

import json

from eval.lid import benchmark as bm
from eval.lid import data


def test_normalize_code_maps_each_recognizer_format():
    assert bm.normalize_code("__label__zh") == "zh"  # fastText
    assert bm.normalize_code("zh-cn") == "zh" and bm.normalize_code("zh-tw") == "zh"  # langdetect
    assert bm.normalize_code("EN") == "en"  # lingua 的 IsoCode639_1 名称
    assert bm.normalize_code("pt_BR") == "pt"
    assert bm.normalize_code(" Ja ") == "ja"


def test_out_of_scope_and_unknown_become_other():
    assert bm.normalize_code("__label__nl") == bm.OTHER  # 荷兰语不在 15 种之内
    assert bm.normalize_code("ms") == bm.OTHER
    assert bm.normalize_code("") == bm.OTHER and bm.normalize_code(None) == bm.OTHER


def _samples():
    return [
        {"id": "a", "lang": "en", "tier": "word", "text": "hello"},
        {"id": "b", "lang": "en", "tier": "word", "text": "world"},
        {"id": "c", "lang": "id", "tier": "word", "text": "dengan"},
        {"id": "d", "lang": "zh", "tier": "sentence", "text": "你好世界"},
    ]


def test_accuracy_counts_other_as_error():
    preds = {"fasttext": {"a": "en", "b": bm.OTHER, "c": bm.OTHER, "d": "zh"}}
    rows = {(r["tier"], r["lang"]): r for r in bm.accuracy_rows(_samples(), preds)}
    assert rows[("word", "en")]["accuracy"] == 0.5
    assert rows[("word", "id")]["correct"] == 0
    assert rows[("sentence", "zh")]["accuracy"] == 1.0


def test_confusion_pairs_only_errors():
    pairs = bm.confusion_pairs(_samples(), {"a": "en", "b": "de", "c": "ms", "d": "ja"}, tier="word")
    assert pairs == {("en", "de"): 1, ("id", "ms"): 1}


def test_summary_throughput_and_other():
    run = bm.RunResult(
        "fasttext",
        {"a": ("en", "__label__en"), "b": ("other", "__label__nl"), "c": ("id", "__label__id"), "d": ("zh", "x")},
        seconds_by_tier={"word": 0.5, "sentence": 0.25},
    )
    rows = {r["tier"]: r for r in bm.summary_rows(_samples(), {"fasttext": run})}
    assert rows["word"]["accuracy"] == round(2 / 3, 4) and rows["word"]["other_or_unknown"] == 1
    assert rows["word"]["throughput_per_s"] == 6.0
    assert rows["all"]["n"] == 4 and rows["all"]["throughput_per_s"] == round(4 / 0.75, 1)


def test_parse_llm_array_tolerates_fence_and_requires_all_ids():
    assert bm.parse_llm_array('```json\n[{"id":1,"lang":"en"},{"id":2,"lang":"zh"}]\n```', 2) == ["en", "zh"]
    assert bm.parse_llm_array('结果：[{"id":2,"lang":"zh"},{"id":1,"lang":"en"}]', 2) == ["en", "zh"]
    assert bm.parse_llm_array('[{"id":1,"lang":"en"}]', 2) is None
    assert bm.parse_llm_array("not json", 1) is None


def _lid_samples(n_per_cell=10):
    out = []
    for lang in data.CODES:
        for tier in data.TIERS:
            out += [
                {"id": f"{lang}-{tier}-{i}", "lang": lang, "tier": tier, "text": f"t{i}"} for i in range(n_per_cell)
            ]
    return out


def test_run_llm_batches_retries_and_caches(tmp_path, monkeypatch):
    monkeypatch.setattr(bm.time, "sleep", lambda s: None)
    samples = _lid_samples(12)
    calls = {"n": 0}

    def chat(messages):
        calls["n"] += 1
        items = json.loads(messages[1]["content"])
        assert len(items) <= bm.LLM_BATCH
        if calls["n"] == 1:
            raise ConnectionError("TLS 抖动")
        if calls["n"] == 2:
            return "坏输出", {}
        return json.dumps([{"id": it["id"], "lang": "en"} for it in items]), {"prompt_tokens": 1}

    cache = tmp_path / "raw.jsonl"
    res = bm.run_llm(samples, cache_path=cache, chat=chat)
    assert len(res.predictions) == 15 * 3 * bm.LLM_PER_CELL  # 每档每语种 10 条
    assert len(res.call_latencies_ms) == 18  # 450 / 25
    assert res.calls == 18 + 2  # 第一批重试了 2 次
    first = calls["n"]
    res2 = bm.run_llm(samples, cache_path=cache, chat=chat)  # 全部命中缓存
    assert calls["n"] == first and res2.predictions == res.predictions


def test_llm_subset_is_deterministic():
    s = _lid_samples(12)
    assert [x["id"] for x in bm.llm_subset(s)] == [x["id"] for x in bm.llm_subset(s)]


def test_graphemes_keep_thai_marks_with_base():
    assert data.graphemes("กิน") == ["กิ", "น"]
    runs = data.script_runs("tha_Thai", "ฉันกินข้าว 123 แล้ว")
    assert ["".join(r) for r in runs] == ["ฉันกินข้าว", "แล้ว"]


def test_script_runs_split_on_punct_and_latin():
    assert ["".join(r) for r in data.script_runs("zho_Hans", "我们使用GPU训练，效果很好。")] == [
        "我们使用",
        "训练",
        "效果很好",
    ]
    assert ["".join(r) for r in data.script_runs("jpn_Jpan", "これはテストです。")] == ["これはテストです"]


def test_clean_words_and_candidates():
    assert data.clean_words('"Hello," said 3rd-party (world).') == ["Hello", "said", None, "world"]
    assert data.word_candidates("eng_Latn", ["Hello there, wonderful world 12345!"]) == [
        "Hello",
        "there",
        "wonderful",
        "world",
    ]
    phrases = data.phrase_candidates(["One two 3 four five six"])
    assert "One two" in phrases and "four five six" in phrases and "two 3" not in phrases


def _devtest():
    zh = ["我们在这里研究机器翻译的方法与评测问题。"] * 3 + [
        f"第{i}句话包含不同的汉字内容用于测试样本生成" for i in range(200)
    ]
    th = [f"ประโยคที่ {i} มีข้อความภาษาไทยสำหรับทดสอบการสุ่มตัวอย่าง" for i in range(200)]
    latin = [
        f"Sentence number {i} contains wonderful different vocabulary{chr(97 + i % 26)}{i % 7} words"
        for i in range(200)
    ]
    words = [f"Example{chr(97 + i % 26) * (1 + i // 26)} sentence with distinct tokens" for i in range(200)]
    out = {}
    for flores in data.FLORES_TO_CODE:
        out[flores] = {"zho_Hans": zh, "jpn_Jpan": zh, "tha_Thai": th}.get(flores, latin + words)
    return out


def test_build_samples_is_reproducible_and_respects_lengths():
    dev = _devtest()
    a, b = data.build_samples(dev), data.build_samples(dev)
    assert a == b and len(a) == 15 * 3 * data.PER_TIER
    for r in a:
        if r["flores"] in data.NO_SPACE and r["tier"] != "sentence":
            n = len(data.graphemes(r["text"]))
            lo, hi = data.WORD_CHARS if r["tier"] == "word" else data.PHRASE_CHARS
            assert lo <= n <= hi, r
        elif r["tier"] == "word":
            assert data.letter_count(r["text"]) >= data.MIN_WORD_LETTERS and " " not in r["text"]
        elif r["tier"] == "phrase":
            assert 2 <= len(r["text"].split()) <= 3
    assert data.build_samples(dev, seed=1) != a
