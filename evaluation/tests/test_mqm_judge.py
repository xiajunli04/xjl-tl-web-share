"""MQM 评审：用假 LLM 测试罚分、解析失败重试、缓存命中与缺失处理。"""

import json

import pytest

from eval.metrics.mqm_judge import (
    ChunkJudgement,
    MqmJudge,
    build_messages,
    chunk_pairs,
    count_source_words,
    parse_errors,
    penalty,
    per_thousand,
    summarize,
)


class FakeLLM:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []

    def __call__(self, messages):
        self.calls.append(messages)
        r = self.replies.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def _judge(tmp_path, llm):
    return MqmJudge(llm, model="judge-x", temperature=0, cache_dir=tmp_path / "cache", backoff=0)


def test_penalty_scenario():
    """规格场景"罚分计算"：1000 源词，1 major + 3 minor → 8.0。"""
    errors = [{"severity": "major", "category": "accuracy"}] + [{"severity": "minor", "category": "fluency"}] * 3
    assert penalty(errors) == 8
    assert per_thousand(penalty(errors), 1000) == pytest.approx(8.0)
    doc = summarize([ChunkJudgement(0, 600, errors[:2]), ChunkJudgement(1, 400, errors[2:])])
    assert doc.score == pytest.approx(8.0)
    assert doc.by_severity == {"major": 1, "minor": 3}


def test_missing_chunk_not_counted_as_zero():
    doc = summarize([ChunkJudgement(0, 500, [{"severity": "critical", "category": "accuracy"}]),
                     ChunkJudgement(1, 500, None)])
    assert doc.missing_chunks == 1
    assert doc.judged_words == 500
    assert doc.score == pytest.approx(50.0)
    assert summarize([ChunkJudgement(0, 10, None)]).score is None


def test_parse_errors_tolerant():
    text = (
        '好的：\n```json\n{"errors": [{"segment": 1, "category": "Terminology", "severity": "MAJOR", "span": "部署"},'
        '{"category": "accuracy", "severity": "neutral"}, {"category": "weird", "severity": "minor"}]}\n```'
    )
    errs = parse_errors(text)
    assert [(e["category"], e["severity"]) for e in errs] == [("terminology", "major"), ("other", "minor")]
    assert parse_errors('{"errors": []}') == []
    assert parse_errors("not json") is None
    assert parse_errors('{"foo": 1}') is None


def test_parse_failure_retried_once_then_cached(tmp_path):
    llm = FakeLLM(["oops", '{"errors": [{"category": "fluency", "severity": "minor", "span": "x"}]}'])
    judge = _judge(tmp_path, llm)
    pairs = [("Hello world", "你好世界")]
    cj = judge.judge_chunk("pods", "D0", 0, pairs)
    assert len(llm.calls) == 2 and cj.attempts == 2
    assert cj.penalty == 1 and not cj.missing
    assert len(list((tmp_path / "cache").glob("*.json"))) == 1


def test_parse_failure_twice_records_missing_and_not_cached(tmp_path):
    llm = FakeLLM(["bad", "still bad"])
    judge = _judge(tmp_path, llm)
    cj = judge.judge_chunk("pods", "D0", 0, [("Hello", "你好")])
    assert cj.missing and cj.penalty is None
    assert not (tmp_path / "cache").exists() or not list((tmp_path / "cache").glob("*.json"))


def test_cache_hit_does_not_call_model(tmp_path):
    """规格场景"缓存命中"。"""
    llm = FakeLLM(['{"errors": []}'])
    pairs = [("Hello", "你好")]
    first = _judge(tmp_path, llm).judge_chunk("pods", "D4", 2, pairs)
    second_llm = FakeLLM([])
    second = _judge(tmp_path, second_llm).judge_chunk("pods", "D4", 2, pairs)
    assert not first.cached and second.cached
    assert second_llm.calls == [] and second.errors == []
    # 译文变化 → 缓存键变化，需要重新评审
    other = FakeLLM(['{"errors": []}'])
    _judge(tmp_path, other).judge_chunk("pods", "D4", 2, [("Hello", "您好")])
    assert len(other.calls) == 1


def test_network_errors_are_retried(tmp_path):
    llm = FakeLLM([ConnectionError("tls"), TimeoutError("slow"), '{"errors": []}'])
    cj = _judge(tmp_path, llm).judge_chunk("d", "g", 0, [("a b", "甲乙")])
    assert cj.errors == [] and len(llm.calls) == 3


def test_prompt_contains_numbered_pairs_and_json_instruction():
    msgs = build_messages([("Source one", "译文一"), ("Source two", "译文二")])
    user = msgs[-1]["content"]
    assert "[1] 原文：\nSource one" in user and "[2] 译文：\n译文二" in user
    assert '"errors"' in user and "critical" in user and "terminology" in user
    json.dumps(msgs, ensure_ascii=False)


def test_chunk_pairs_groups_translatable_segments():
    segs = [
        {"seq": 0, "source": "# Title", "target": "# 标题", "translatable": True, "chunkIndex": 0},
        {"seq": 1, "source": "```code```", "target": None, "translatable": False, "chunkIndex": 0},
        {"seq": 3, "source": "Para B", "target": None, "translatable": True, "chunkIndex": 1},
        {"seq": 2, "source": "Para A", "target": "段落甲", "translatable": True, "chunkIndex": 1},
        {"seq": 4, "source": "", "target": "", "translatable": True, "chunkIndex": 1},
    ]
    assert chunk_pairs(segs) == {0: [("# Title", "# 标题")], 1: [("Para A", "段落甲"), ("Para B", "")]}


def test_count_source_words():
    assert count_source_words("A Pod's contents are co-located (v1.19).") == 6
