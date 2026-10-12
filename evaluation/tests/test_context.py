"""E1–E3 执行器与评审的离线测试：假平台客户端与假评审模型。"""

import json

import pytest

from eval.ablation.runner import RateLimiter
from eval.client import StreamResult
from eval.context import ambiguity, session_eval, tm_loo
from eval.context.judge import ContextJudge, combine_orders, parse_phenomena, parse_winner

# ---------------------------------------------------------------- 评审解析


def test_parse_phenomena_requires_every_index():
    content = '{"items": [{"index": 0, "correct": true, "reason": "ok"}, {"index": 1, "correct": false}]}'
    assert parse_phenomena(content, 2) == [True, False]
    assert parse_phenomena('{"items": [{"index": 0, "correct": true}]}', 2) is None
    assert parse_phenomena('```json\n{"items": [{"index": 0, "correct": false}]}\n```', 1) == [False]
    assert parse_phenomena("not json", 1) is None


def test_parse_winner_and_order_combination():
    assert parse_winner('{"winner": "B", "reason": "x"}') == "B"
    assert parse_winner('{"winner": "C"}') is None
    # X 在 A 位赢、在 B 位也赢 → X；结论随位置翻转 → tie
    assert combine_orders("A", "B") == "X"
    assert combine_orders("B", "A") == "Y"
    assert combine_orders("A", "A") == "tie"
    assert combine_orders("tie", "B") == "tie"
    assert combine_orders(None, None) == "tie"


def test_context_judge_caches_and_swaps_order(tmp_path):
    calls = []

    def llm(messages):
        calls.append(messages)
        user = messages[1]["content"]
        if "需判定的片段" in user:
            return '{"items": [{"index": 0, "correct": true}]}'
        # 成对偏好：总是偏好含"耳机"的译文
        a_part = user.split("## 译文 A")[1].split("## 译文 B")[0]
        return '{"winner": "A"}' if "耳机" in a_part else '{"winner": "B"}'

    judge = ContextJudge(llm, model="fake", cache_dir=tmp_path)
    phen = [{"span": "It", "expected": "指耳机"}]
    assert judge.phenomena(["I bought headphones."], "It broke.", "耳机坏了。", phen) == [True]
    assert judge.phenomena(["I bought headphones."], "It broke.", "耳机坏了。", phen) == [True]  # 命中缓存
    assert judge.phenomena([], "Hi.", "你好。", []) == []
    assert judge.pairwise(["It broke."], ["耳机坏了。"], ["它坏了。"]) == "X"
    assert judge.pairwise(["It broke."], ["它坏了。"], ["耳机坏了。"]) == "Y"
    assert len(calls) == 1 + 2  # 现象 1 次（第二次命中缓存）；成对偏好两种顺序各 1 次，交换参数后两条都命中缓存


# ---------------------------------------------------------------- E2


class FakeSessionClient:
    def __init__(self):
        self.created = []
        self.calls = []
        self.deleted = []

    def create_session(self, **kw):
        self.created.append(kw)
        return {"id": 40 + len(self.created)}

    def delete_session(self, sid):
        self.deleted.append(sid)

    def translate_stream(self, text, **kw):
        self.calls.append((text, kw))
        res = StreamResult()
        sid = kw.get("session_id")
        res.events = (
            [("node", {"node": "retrieve", "status": "completed", "detail": {"sessionTurns": 2}})] if sid else []
        )
        if "bank" in text and sid:
            res.clarify = {
                "threadId": "turn:x",
                "question": "bank 指什么？",
                "options": ["银行", "河岸"],
                "span": "bank",
            }
            res.events.append(("node", {"node": "plan", "status": "completed", "latencyMs": 900}))
            return res
        res.events.append(("node", {"node": "plan", "status": "completed", "latencyMs": 600}))
        res.final = {"translation": f"译:{text}", "usage": {"promptTokens": 10, "completionTokens": 4}, "recordId": 1}
        return res


def test_run_dialogue_session_condition_uses_one_session():
    client = FakeSessionClient()
    dialogue = {"id": "d01", "turns": [{"source": "A.", "phenomena": []}, {"source": "B.", "phenomena": []}]}
    data = session_eval.run_dialogue(
        client, dialogue, "session", mode="standard", model_id=2, limiter=RateLimiter(0), commit="abc"
    )
    assert client.created == [
        {"source_lang": "en", "target_lang": "zh", "title": "eval-d01", "clarifyEnabled": False, "modelConfigId": 2}
    ]
    assert [kw["session_id"] for _, kw in client.calls] == [41, 41]
    assert [t["sessionTurns"] for t in data["turns"]] == [2, 2]
    plain = session_eval.run_dialogue(
        client, dialogue, "nosession", mode="standard", model_id=2, limiter=RateLimiter(0), commit="abc"
    )
    assert [kw["session_id"] for _, kw in client.calls[2:]] == [None, None]
    assert plain["sessionId"] is None and len(client.created) == 1


def test_session_summary_and_accuracy_by_type(tmp_path):
    for cond, tokens in (("session", 20), ("nosession", 10)):
        (tmp_path / f"d01__{cond}.json").write_text(
            json.dumps({"turns": [{"usage": {"promptTokens": tokens, "completionTokens": 0}}]}), encoding="utf-8"
        )
    judgement = {
        "phenomena": [
            {"condition": "session", "type": "pronoun", "correct": True},
            {"condition": "session", "type": "gender", "correct": True},
            {"condition": "nosession", "type": "pronoun", "correct": False},
            {"condition": "nosession", "type": "gender", "correct": True},
            {"condition": "nosession", "type": "gender", "correct": None},  # 评审失败的项不计入
        ],
        "pairwise": [{"winner": "session"}, {"winner": "tie"}],
    }
    rows = {r["condition"]: r for r in session_eval.summarize(judgement, tmp_path)}
    assert rows["session"]["phenomena_accuracy"] == 1.0 and rows["nosession"]["phenomena_accuracy"] == 0.5
    assert rows["session"]["pairwise_wins"] == 1 and rows["session"]["pairwise_ties"] == 1
    assert rows["session"]["mean_tokens_per_turn"] == 20
    by_type = session_eval.accuracy_by_type(judgement)
    assert by_type["pronoun"]["session"] == 1.0 and by_type["pronoun"]["nosession"] == 0.0
    assert by_type["gender"]["nosession"] == 1.0


# ---------------------------------------------------------------- E3


def test_span_hit():
    assert ambiguity.span_hit("Bank", "bank")
    assert ambiguity.span_hit("the bank", "bank")
    assert not ambiguity.span_hit("send", "bank")
    assert not ambiguity.span_hit(None, "bank")


def test_run_one_records_clarify_and_deletes_session():
    client = FakeSessionClient()
    row = {"id": "a01", "ambiguous": True, "source": "Please send it to the bank.", "span": "bank"}
    rec = ambiguity.run_one(client, row, "clarify_on", model_id=2, limiter=RateLimiter(0), commit="abc")
    assert rec["asked"] and rec["span"] == "bank" and rec["ok"] and rec["planLatencyMs"] == 900
    assert client.created[0]["clarifyEnabled"] is True and client.deleted == [41]
    plain = ambiguity.run_one(
        client,
        {"id": "u01", "ambiguous": False, "source": "Shipped."},
        "clarify_off",
        model_id=2,
        limiter=RateLimiter(0),
        commit="abc",
    )
    assert not plain["asked"] and client.created[1]["clarifyEnabled"] is False


def test_ambiguity_report_scenario():
    """规格场景"统计检测结果"：20 句歧义中 16 句追问，20 句无歧义中 2 句追问。"""
    recs = [
        {
            "id": f"a{i}",
            "condition": "clarify_on",
            "ok": True,
            "ambiguous": True,
            "asked": i < 16,
            "span": "bank",
            "gold_span": "bank" if i < 12 else "other",
        }
        for i in range(20)
    ]
    recs += [
        {
            "id": f"u{i}",
            "condition": "clarify_on",
            "ok": True,
            "ambiguous": False,
            "asked": i < 2,
            "planLatencyMs": 1000,
        }
        for i in range(20)
    ]
    recs += [
        {
            "id": f"u{i}",
            "condition": "clarify_off",
            "ok": True,
            "ambiguous": False,
            "asked": False,
            "planLatencyMs": 600,
        }
        for i in range(20)
    ]
    r = ambiguity.report(recs)
    assert r["recall"] == pytest.approx(0.80) and r["precision"] == pytest.approx(16 / 18)
    assert r["span_hit_rate"] == pytest.approx(12 / 16)
    assert r["plan_ms_clarify_on_plain"] == 1000 and r["plan_ms_clarify_off_plain"] == 600
    assert r["false_positive_ids"] == ["u0", "u1"] and len(r["missed_ids"]) == 4


def test_ambiguity_resume_skips_done(tmp_path):
    path = tmp_path / "amb.jsonl"
    path.write_text(
        json.dumps({"id": "a01", "condition": "clarify_on", "ok": True})
        + "\n"
        + json.dumps({"id": "a02", "condition": "clarify_on", "ok": False})
        + "\n",
        encoding="utf-8",
    )
    assert ambiguity.done_keys(path) == {("a01", "clarify_on")}


# ---------------------------------------------------------------- E1


def test_memory_docs_leave_one_out():
    """规格场景"记忆来自其余文档"。"""
    docs = ("configmap", "deployment", "pods", "service", "volumes")
    assert tm_loo.memory_docs("pods", docs) == ["configmap", "deployment", "service", "volumes"]


def test_load_memory_clears_then_writes_others():
    class FakeTmClient:
        def __init__(self):
            self.log = []

        def tm_clear(self):
            self.log.append("clear")
            return 7

        def doc_task_memory(self, task_id):
            self.log.append(task_id)
            return 10

    client = FakeTmClient()
    sources = {d: i for i, d in enumerate(tm_loo.DOC_IDS, start=100)}
    held = tm_loo.DOC_IDS[0]
    out = tm_loo.load_memory(client, held, sources, log=lambda m: None)
    assert client.log[0] == "clear" and sources[held] not in client.log[1:]
    assert out["removed"] == 7 and sum(out["written"].values()) == 40


def test_tm_groups_and_hit_stats():
    assert tm_loo.TM_GROUPS["TM0"].options["translationMemory"] is False
    assert tm_loo.TM_GROUPS["TM1"].options["translationMemory"] is True
    assert tm_loo.TM_GROUPS["TM1"].strategy == "hybrid" and tm_loo.TM_GROUPS["TM1"].options["review"] is False
    segs = [
        {"translatable": True, "chunkIndex": 0, "tmHits": [{"fuzzy": 0.9}]},
        {"translatable": True, "chunkIndex": 0, "tmHits": []},
        {"translatable": True, "chunkIndex": 1, "tmHits": [{"fuzzy": 0.7}]},
        {"translatable": False, "chunkIndex": 1},
    ]
    stats = tm_loo.tm_hit_stats(segs)
    assert stats["hit_segments"] == 2 and stats["hits_per_chunk"] == 1.0
    assert stats["mean_fuzzy"] == pytest.approx(0.8)
