"""汇总与绘图：用构造的结果文件生成 CSV 与 PNG。"""

import json

import pandas as pd
import pytest

from eval.ablation import aggregate, plots
from eval.ablation.runner import GROUPS
from eval.metrics.mqm_judge import MqmJudge


def _segments(quality: int) -> list[dict]:
    good = quality >= 1
    return [
        {"seq": 0, "blockType": "heading", "prefix": "# ", "source": "Pods", "suffix": "\n\n", "translatable": True,
         "chunkIndex": 0, "target": "Pod"},
        {"seq": 1, "blockType": "paragraph", "prefix": "", "source": "A Pod runs containers in a cluster.",
         "suffix": "\n\n", "translatable": True, "chunkIndex": 0,
         "target": "Pod 在集群中运行容器。" if good else "容器组在群集中运行容器。"},
        {"seq": 2, "blockType": "code", "prefix": "```\n", "source": "kubectl get pods", "suffix": "\n```\n",
         "translatable": False, "chunkIndex": 0, "target": None},
        {"seq": 3, "blockType": "paragraph", "prefix": "", "source": "Each Pod has an IP address.", "suffix": "\n",
         "translatable": True, "chunkIndex": 1, "target": "每个 Pod 都有一个 IP 地址。"},
    ]


def _result(doc, group, run, quality):
    return {
        "doc": doc, "group": group, "run": run, "status": "COMPLETED", "error": None, "retries": 0,
        "taskId": 1, "gitCommit": "abc", "model": {"id": 2, "modelName": "gpt-5.6-luna"},
        "config": {"strategy": GROUPS[group].strategy, "options": GROUPS[group].options},
        "task": {"promptTokens": 1000 * quality + 500, "completionTokens": 200, "stats": {"chunks": 2, "refined": 0},
                 "startedAt": "2026-10-03T00:00:00Z", "finishedAt": f"2026-10-03T00:0{quality + 1}:00Z"},
        "segments": _segments(quality),
        "traces": [{"node": "translate_chunk", "chunkIndex": 0, "latencyMs": 3000 + quality * 1000},
                   {"node": "analyze", "chunkIndex": None, "latencyMs": 500}],
    }


@pytest.fixture
def results_dir(tmp_path):
    root = tmp_path / "results"
    (root / "doc").mkdir(parents=True)
    for doc in ("pods", "volumes"):
        for i, g in enumerate(g for g in GROUPS if g.startswith("D")):
            data = _result(doc, g, 1, 0 if g == "D0" else 1 + i % 3)
            (root / "doc" / f"{doc}__{g}__run1.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        d4b = _result(doc, "D4", 2, 1)
        (root / "doc" / f"{doc}__D4__run2.json").write_text(json.dumps(d4b, ensure_ascii=False), encoding="utf-8")
    failed = {"doc": "service", "group": "D1", "run": 1, "status": "FAILED", "error": "FAILED: [C0140] x",
              "retries": 2, "config": {"strategy": "serial"}}
    (root / "doc" / "service__D1__run1.failed.json").write_text(json.dumps(failed), encoding="utf-8")
    (root / "sentence").mkdir()
    for mode, rounds in (("fast", 0), ("standard", 1)):
        lines = [json.dumps({"id": i, "ok": True, "translation": "你好世界", "reference": "你好，世界",
                             "reviewRounds": rounds if i == 0 else 0, "firstScore": 80, "finalScore": 90,
                             "path": mode, "usage": {"promptTokens": 10, "completionTokens": 4}, "latencyMs": 100,
                             "ttfeMs": 20}, ensure_ascii=False) for i in range(4)]
        lines.append(json.dumps({"id": 4, "ok": False, "error": "x", "reference": "r"}))
        (root / "sentence" / f"{mode}.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return root


class FakeLLM:
    def __init__(self):
        self.calls = 0

    def __call__(self, messages):
        self.calls += 1
        return '{"errors": [{"segment": 1, "category": "fluency", "severity": "minor", "span": "x"}]}'


def test_aggregate_and_plots(results_dir, tmp_path):
    llm = FakeLLM()
    judge = MqmJudge(llm, model="fake", cache_dir=results_dir / "mqm_cache", backoff=0)
    out = aggregate.run(results_dir=results_dir, judge=judge, judge_workers=2)

    metrics = pd.read_csv(results_dir / "doc_metrics.csv", encoding="utf-8-sig")
    assert len(metrics) == 2 * 8 + 1
    failed = metrics[metrics["status"] == "FAILED"]
    assert len(failed) == 1 and failed.iloc[0]["doc"] == "service"
    ok = metrics[metrics["status"] == "COMPLETED"]
    assert ok["chrf"].notna().all() and ok["mqm"].notna().all()
    assert (ok["mqm_chunks"] == 2).all()  # 不可翻译的代码段被跳过，块 0 与块 1 各评审一次
    d0 = ok[(ok["group"] == "D0") & (ok["doc"] == "pods")].iloc[0]
    d4 = ok[(ok["group"] == "D4") & (ok["doc"] == "pods") & (ok["run"] == 1)].iloc[0]
    assert d0["term_accuracy"] < d4["term_accuracy"]
    assert d4["chunk_latency_ms"] < d4["node_latency_ms"]

    # 相同译文复用缓存：同一（文档、组、块、内容）只评审一次；D4 两轮译文相同 → 共享
    assert llm.calls == len({(r["doc"], r["group"]) for _, r in ok.iterrows()}) * 2

    summary = out["doc_summary"]
    assert list(summary[summary["run"] == "1"]["group"]) == [g for g in GROUPS if g.startswith("D")]
    assert {"2", "2-1", "|2-1|"} <= set(summary["run"])
    assert (results_dir / "doc_summary.csv").exists()
    assert summary.loc[summary["group"] == "D1", "failed"].iloc[0] == 1

    sentence = pd.read_csv(results_dir / "sentence_metrics.csv", encoding="utf-8-sig").set_index("mode")
    assert sentence.loc["fast", "ok"] == 4 and sentence.loc["fast", "n"] == 5
    assert sentence.loc["standard", "review_trigger_rate"] == pytest.approx(0.25)
    assert sentence.loc["fast", "review_trigger_rate"] == 0

    # 再跑一次：全部命中缓存
    llm2 = FakeLLM()
    aggregate.run(results_dir=results_dir, judge=MqmJudge(llm2, model="fake", cache_dir=results_dir / "mqm_cache"))
    assert llm2.calls == 0

    figs = plots.run(results_dir / "doc_metrics.csv", tmp_path / "figures")
    assert {p.name for p in figs} == {"ablation_bars.png", "quality_cost.png", "strategy_compare.png"}
    assert all(p.stat().st_size > 10_000 for p in figs)


def test_setup_style_finds_chinese_font():
    font = plots.setup_style()
    assert font in plots.FONT_CANDIDATES or font is None


def test_assemble_translation_falls_back_to_source():
    segs = [
        {"seq": 1, "prefix": "", "source": "B", "suffix": "\n", "translatable": True, "target": None},
        {"seq": 0, "prefix": "# ", "source": "A", "suffix": "\n\n", "translatable": True, "target": "甲"},
        {"seq": 2, "prefix": "```\n", "source": "code", "suffix": "\n```\n", "translatable": False, "target": None},
    ]
    assert aggregate.assemble_translation(segs) == "# 甲\n\nB\n```\ncode\n```\n"


def test_improve_summary_and_figures(tmp_path):
    from eval.ablation import improve

    rows = []
    for g, lock in (("D3", [True, False]), ("D4", [False, False]), ("D6", [True, True]),
                    ("I1", [False, False]), ("I2", [False, False]), ("I3", [False, False])):
        for run, (doc, locked) in enumerate(zip(("pods", "volumes"), lock, strict=True), 1):
            rows.append({"doc": doc, "group": g, "run": 1, "status": "COMPLETED", "chrf": 60 + run, "bleu": 40,
                         "mqm": 10, "mqm_major": 1, "term_accuracy": 0.9, "term_consistency": 0.95,
                         "total_tokens": 1000 * run, "wall_ms": 50000, "lockin": locked, "chunks": 3,
                         "refined": 1 if g == "I2" else 0})
            if g.startswith("I"):
                rows.append({**rows[-1], "run": 2, "chrf": 58 + run})
    rows.append({"doc": "pods", "group": "D5", "run": 1, "status": "COMPLETED", "chrf": 60, "lockin": True,
                 "chunks": 3, "refined": 0})
    rows.append({"doc": "pods", "group": "I1", "run": 3, "status": "FAILED", "lockin": True})
    csv = tmp_path / "doc_metrics.csv"
    pd.DataFrame(rows).to_csv(csv, index=False)
    out = improve.run(metrics_csv=csv, results_dir=tmp_path, figures=tmp_path / "fig")

    summary = out["summary"].set_index("group")
    assert list(summary.index) == ["D3", "D4", "D6", "I1", "I2", "I3", "D3–D6"]
    assert summary.loc["D6", "lockin_rate"] == 1.0 and summary.loc["I1", "lockin_rate"] == 0.0
    assert summary.loc["D3–D6", "lockin_runs"] == 4 and summary.loc["D3–D6", "n_runs"] == 7
    assert summary.loc["I2", "refine_rate"] == pytest.approx(1 / 3)
    assert summary.loc["I1", "chrf_run_absdiff"] == pytest.approx(2.0)
    assert pd.isna(summary.loc["D3", "chrf_run_absdiff"])
    assert out["lockin"].loc["D5", "locked"] == 1
    assert (tmp_path / "improve_summary.csv").exists()
    assert {p.name for p in out["figures"]} == {"improve_lockin.png", "improve_quality_cost.png"}
