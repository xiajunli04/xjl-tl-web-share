"""执行器：用假平台客户端测试配置映射、跳过已完成组合、失败重试与句子级续跑。"""

import json
from dataclasses import replace

import pytest

from eval.ablation import runner
from eval.ablation.runner import GROUPS, DocJob, RateLimiter, plan_doc_jobs
from eval.client import PlatformError, StreamResult
from eval.metrics.terminology import TermEntry


class FakeDocClient:
    """按脚本返回任务状态：statuses 依次作为每次 wait 的最终状态。"""

    def __init__(self, statuses=("COMPLETED",), create_errors=0, terms=()):
        self.statuses = list(statuses)
        self.terms = list(terms)
        self.confirmed = []
        self.created = []
        self.retried = 0
        self.create_errors = create_errors
        self.closed = False

    def model_configs(self):
        return [{"id": 2, "name": "译者", "modelName": "gpt-5.6-luna", "isDefault": True, "apiKeyMask": "sk-***"}]

    def create_doc_task(self, text, **kw):
        if self.create_errors:
            self.create_errors -= 1
            raise PlatformError("A0213", "并发超限", 429)
        self.created.append({"text": text, **kw})
        return {"id": 100 + len(self.created), "status": "PENDING"}

    def wait_doc_task(self, task_id, until=None):
        status = self.statuses.pop(0)
        assert status != "AWAITING_CONFIRM" or (until and status in until)
        task = {"id": task_id, "status": status, "promptTokens": 10, "completionTokens": 5,
                "startedAt": "2026-10-03T00:00:00Z", "finishedAt": "2026-10-03T00:01:00Z"}
        if status == "FAILED":
            task.update(retryable=True, errorCode="C0140", errorMessage="LLM 超时")
        return task

    def retry_doc_task(self, task_id):
        self.retried += 1
        return {"id": task_id, "status": "PENDING"}

    def doc_segments(self, task_id):
        return [{"seq": 0, "source": "Hello", "target": "你好", "translatable": True, "chunkIndex": 0}]

    def doc_traces(self, task_id):
        return [{"seq": 1, "node": "translate_chunk", "chunkIndex": 0, "latencyMs": 1000}]

    def doc_terms(self, task_id):
        return self.terms

    def confirm_doc_terms(self, task_id, terms):
        self.confirmed.append(terms)
        return terms

    def close(self):
        self.closed = True


@pytest.fixture
def k8s_dir(tmp_path):
    d = tmp_path / "k8s"
    d.mkdir()
    for doc in ("pods", "volumes"):
        (d / f"{doc}.en.md").write_text(f"# {doc}\n\nText.\n", encoding="utf-8")
    return d


def test_group_config_table():
    """规格场景"配置正确"：D2 → contextWindow、globalSummary 开启，其余关闭，串行。"""
    d2 = GROUPS["D2"]
    assert d2.options == {"contextWindow": True, "globalSummary": True, "termExtraction": False, "review": False}
    assert d2.strategy == "serial"
    assert GROUPS["D0"].options == dict.fromkeys(d2.options, False) and GROUPS["D0"].strategy == "parallel"
    assert all(GROUPS[g].options == dict.fromkeys(d2.options, True) for g in ("D4", "D5", "D6"))
    assert [GROUPS[g].strategy for g in ("D4", "D5", "D6")] == ["serial", "parallel", "hybrid"]


def test_default_plan_has_d4_and_improve_repeats():
    jobs = plan_doc_jobs()
    assert len(jobs) == 5 * 7 + 5 + 5 * 3 * 2
    assert {j.group for j in jobs if j.run == 2} == {"D4", "I1", "I2", "I3"}
    assert plan_doc_jobs(["pods"], ["D0", "D1"], runs=[3]) == [DocJob("pods", "D0", 3), DocJob("pods", "D1", 3)]


def test_create_request_uses_group_config_and_explicit_model(tmp_path, k8s_dir):
    client = FakeDocClient()
    runner.run_doc_jobs([DocJob("pods", "D2", 1)], client_factory=lambda: client, concurrency=1,
                        model_config_id=2, max_retries=2, root=tmp_path / "doc", k8s_dir=k8s_dir, log=lambda m: None)
    req = client.created[0]
    assert req["options"] == GROUPS["D2"].options and req["strategy"] == "serial"
    assert req["model_config_id"] == 2 and req["glossary_ids"] == [] and req["confirm_terms"] is False
    assert req["target_lang"] == "zh"
    data = json.loads((tmp_path / "doc" / "pods__D2__run1.json").read_text(encoding="utf-8"))
    for key in ("config", "model", "gitCommit", "startedAt", "finishedAt", "taskId", "segments", "traces", "usage"):
        assert key in data
    assert data["model"]["modelName"] == "gpt-5.6-luna" and "apiKeyMask" not in data["model"]
    assert data["config"]["options"] == GROUPS["D2"].options and data["retries"] == 0
    assert client.closed


def test_skips_existing_results(tmp_path, k8s_dir):
    """规格场景"中断后继续"：已有结果文件的组合不再执行。"""
    root = tmp_path / "doc"
    root.mkdir()
    (root / "pods__D0__run1.json").write_text("{}", encoding="utf-8")
    client = FakeDocClient(statuses=["COMPLETED"])
    jobs = [DocJob("pods", "D0", 1), DocJob("volumes", "D0", 1)]
    assert runner.pending_jobs(jobs, root) == [DocJob("volumes", "D0", 1)]
    runner.run_doc_jobs(jobs, client_factory=lambda: client, concurrency=1, model_config_id=2,
                        root=root, k8s_dir=k8s_dir, log=lambda m: None)
    assert len(client.created) == 1 and "volumes" in client.created[0]["title"]


def test_failed_task_is_retried_and_recorded(tmp_path, k8s_dir):
    """规格场景"失败重试"：调用继续接口后完成，结果记录重试次数。"""
    client = FakeDocClient(statuses=["FAILED", "COMPLETED"])
    runner.run_doc_jobs([DocJob("pods", "D4", 1)], client_factory=lambda: client, concurrency=1,
                        model_config_id=2, max_retries=2, root=tmp_path / "doc", k8s_dir=k8s_dir, log=lambda m: None)
    data = json.loads((tmp_path / "doc" / "pods__D4__run1.json").read_text(encoding="utf-8"))
    assert client.retried == 1 and data["retries"] == 1
    assert data["retryHistory"][0]["errorCode"] == "C0140"


def test_gives_up_after_max_retries(tmp_path, k8s_dir):
    client = FakeDocClient(statuses=["FAILED", "FAILED", "FAILED"])
    results = runner.run_doc_jobs([DocJob("pods", "D4", 1)], client_factory=lambda: client, concurrency=1,
                                  model_config_id=2, max_retries=2, root=tmp_path / "doc", k8s_dir=k8s_dir,
                                  log=lambda m: None)
    assert client.retried == 2
    assert results[0]["status"] == "FAILED" and "C0140" in results[0]["error"]
    assert not (tmp_path / "doc" / "pods__D4__run1.json").exists()
    assert (tmp_path / "doc" / "pods__D4__run1.failed.json").exists()
    # 失败文件不阻止重跑
    assert runner.pending_jobs([DocJob("pods", "D4", 1)], tmp_path / "doc")


def test_waits_when_concurrency_limited(tmp_path, k8s_dir):
    client = FakeDocClient(create_errors=2)
    sleeps = []
    runner.run_doc_jobs([DocJob("pods", "D0", 1)], client_factory=lambda: client, concurrency=1, model_config_id=2,
                        root=tmp_path / "doc", k8s_dir=k8s_dir, sleep=sleeps.append, log=lambda m: None)
    assert len(sleeps) == 2 and len(client.created) == 1


def test_improve_group_config_table():
    full_no_review = {"contextWindow": True, "globalSummary": True, "termExtraction": True, "review": False}
    assert GROUPS["I1"].options == full_no_review and GROUPS["I3"].options == full_no_review
    assert GROUPS["I2"].options == {**full_no_review, "review": True}
    assert {GROUPS[g].strategy for g in ("I1", "I2", "I3")} == {"hybrid"}
    assert [GROUPS[g].confirm for g in ("I1", "I2", "I3")] == ["none", "none", "oracle"]
    assert [GROUPS[g].review_model for g in ("I1", "I2", "I3")] == [False, True, False]


def test_oracle_decisions_correct_only_gold_terms():
    """规格场景"模拟人工确认"：金标中的源词改为金标译法（不区分大小写），其余原样接受。"""
    gold = [TermEntry("Deployment", "Deployment"), TermEntry("namespace", "名字空间")]
    terms = [
        {"id": 1, "source": "Deployment", "target": "部署", "status": "PENDING"},
        {"id": 2, "source": "rollout", "target": "滚动更新", "status": "PENDING"},
        {"id": 3, "source": "Namespace", "target": "名字空间", "status": "PENDING"},
        {"id": 4, "source": "GPU", "target": "图形处理器", "status": "CONFIRMED"},
    ]
    decisions, corrected = runner.oracle_decisions(terms, gold)
    assert decisions == [
        {"id": 1, "source": "Deployment", "target": "Deployment", "status": "CONFIRMED"},
        {"id": 2, "source": "rollout", "target": "滚动更新", "status": "CONFIRMED"},
        {"id": 3, "source": "Namespace", "target": "名字空间", "status": "CONFIRMED"},
    ]
    assert corrected == [{"source": "Deployment", "from": "部署", "to": "Deployment"}]


def test_i3_confirms_with_oracle_then_completes(tmp_path, k8s_dir):
    terms_path = tmp_path / "terms.json"
    terms_path.write_text(
        json.dumps({"pods": [{"source": "Pod", "target": "Pod", "caseSensitive": True}]}), encoding="utf-8"
    )
    client = FakeDocClient(
        statuses=["AWAITING_CONFIRM", "COMPLETED"],
        terms=[{"id": 7, "source": "Pod", "target": "容器组", "status": "PENDING"}],
    )
    runner.run_doc_jobs([DocJob("pods", "I3", 1)], client_factory=lambda: client, concurrency=1, model_config_id=2,
                        root=tmp_path / "doc", k8s_dir=k8s_dir, terms_path=terms_path, log=lambda m: None)
    req = client.created[0]
    assert req["confirm_terms"] is True and req["strategy"] == "hybrid" and req["review_model_config_id"] is None
    assert client.confirmed == [[{"id": 7, "source": "Pod", "target": "Pod", "status": "CONFIRMED"}]]
    data = json.loads((tmp_path / "doc" / "pods__I3__run1.json").read_text(encoding="utf-8"))
    assert data["confirmation"]["corrected"] == [{"source": "Pod", "from": "容器组", "to": "Pod"}]
    assert data["config"]["confirmTerms"] is True


def test_i2_uses_review_model(tmp_path, k8s_dir, monkeypatch):
    """规格场景"指定独立评审模型"。"""
    cfg = runner.get_config()
    monkeypatch.setattr(runner, "get_config", lambda: replace(cfg, improve_review_model_id=3))
    client = FakeDocClient()
    runner.run_doc_jobs([DocJob("pods", "I2", 1)], client_factory=lambda: client, concurrency=1, model_config_id=2,
                        root=tmp_path / "doc", k8s_dir=k8s_dir, log=lambda m: None)
    req = client.created[0]
    assert req["review_model_config_id"] == 3 and req["options"]["review"] is True and req["confirm_terms"] is False
    data = json.loads((tmp_path / "doc" / "pods__I2__run1.json").read_text(encoding="utf-8"))
    assert data["config"]["reviewModelConfigId"] == 3


def test_i2_without_review_model_fails_fast(tmp_path, k8s_dir, monkeypatch):
    cfg = runner.get_config()
    monkeypatch.setattr(runner, "get_config", lambda: replace(cfg, improve_review_model_id=None))
    client = FakeDocClient()
    results = runner.run_doc_jobs([DocJob("pods", "I2", 1)], client_factory=lambda: client, concurrency=1,
                                  model_config_id=2, root=tmp_path / "doc", k8s_dir=k8s_dir, log=lambda m: None)
    assert results[0]["status"] == "ERROR" and "review_model_config_id" in results[0]["error"]
    assert client.created == []


# ---------------------------------------------------------------- 句子级


class FakeStreamClient:
    def __init__(self, fail_ids=()):
        self.calls = []
        self.fail_ids = set(fail_ids)

    def translate_stream(self, text, **kw):
        self.calls.append((text, kw))
        if text in self.fail_ids:
            self.fail_ids.discard(text)
            raise PlatformError("A0212", "限流", 429)
        res = StreamResult()
        res.events = [
            ("node", {"node": "translate", "status": "completed"}),
            ("review", {"round": 1, "score": 70, "passed": False}),
            ("node", {"node": "refine", "status": "completed"}),
            ("review", {"round": 2, "score": 92, "passed": True}),
            ("final", {"translation": "译文", "path": kw["mode"], "usage": {"promptTokens": 9, "completionTokens": 3}}),
        ]
        res.final = res.events[-1][1]
        res.ttfe_ms, res.total_ms = 10.0, 50.0
        return res

    def close(self):
        pass


def test_sentence_records_review_rounds_and_resumes(tmp_path):
    """规格场景"记录修正触发"：评审未通过并修正 1 轮 → reviewRounds=1。"""
    rows = [{"id": i, "source": f"s{i}", "reference": f"参考{i}"} for i in range(3)]
    root = tmp_path / "sentence"
    root.mkdir()
    lines = [json.dumps({"id": 0, "ok": True}), json.dumps({"id": 1, "ok": False})]
    (root / "standard.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")
    client = FakeStreamClient(fail_ids={"s2"})
    runner.run_sentences(["standard"], client_factory=lambda: client, concurrency=1, interval=0, model_config_id=2,
                         root=root, rows=rows, sleep=lambda s: None, log=lambda m: None)
    assert sorted(t for t, _ in client.calls) == ["s1", "s2", "s2"]  # id=0 已成功被跳过；s2 限流后重试
    assert all(kw["mode"] == "standard" and kw["model_config_id"] == 2 for _, kw in client.calls)
    recs = [json.loads(line) for line in (root / "standard.jsonl").read_text(encoding="utf-8").splitlines()]
    new = [r for r in recs if r.get("translation")]
    assert {r["id"] for r in new} == {1, 2}
    assert all(r["reviewRounds"] == 1 and r["firstScore"] == 70 and r["finalScore"] == 92 for r in new)
    assert runner.done_sentence_ids(root / "standard.jsonl") == {0, 1, 2}


def test_rate_limiter_spaces_calls():
    t = [0.0]
    slept = []

    def sleep(s):
        slept.append(s)
        t[0] += s

    lim = RateLimiter(3.0, clock=lambda: t[0], sleep=sleep)
    for _ in range(3):
        lim.wait()
    assert slept == [3.0, 3.0]


def test_standard_review_variant_passes_review_model(tmp_path, monkeypatch):
    cfg = runner.get_config()
    monkeypatch.setattr(runner, "get_config", lambda: replace(cfg, improve_review_model_id=3))
    rows = [{"id": 0, "source": "s0", "reference": "参考0"}]
    client = FakeStreamClient()
    runner.run_sentences(["standard_review"], client_factory=lambda: client, concurrency=1, interval=0,
                         model_config_id=2, root=tmp_path, rows=rows, sleep=lambda s: None, log=lambda m: None)
    _, kw = client.calls[0]
    assert kw["mode"] == "standard" and kw["review_model_config_id"] == 3
    rec = json.loads((tmp_path / "standard_review.jsonl").read_text(encoding="utf-8"))
    assert rec["mode"] == "standard_review" and rec["reviewModelConfigId"] == 3


def test_summarize_stream_counts_first_review_issues():
    events = [
        ("review", {"round": 0, "score": 88, "passed": False, "reviewer": "gpt-6-luna", "fallback": False,
                    "issues": [{"severity": "major"}, {"severity": "minor"}, {"severity": "minor"}]}),
        ("node", {"node": "refine", "status": "completed"}),
        ("review", {"round": 1, "score": 93, "passed": True, "issues": []}),
    ]
    s = runner.summarize_stream(events)
    assert s["firstIssues"] == {"critical": 0, "major": 1, "minor": 2}
    assert s["reviewer"] == "gpt-6-luna" and s["reviewerFallback"] is False and s["reviewRounds"] == 1
