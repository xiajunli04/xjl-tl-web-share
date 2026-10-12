"""汇总：读取结果文件，计算全部指标，输出 CSV（design D4 / D5）。

- `results/doc_metrics.csv`：每篇 × 每组 × 每轮的全部指标（最终失败的组合也列出，指标为空）
- `results/doc_summary.csv`：每组（第 1 轮）跨文档均值；另有 D4 第 2 轮均值、D4 两轮之差的均值与绝对值均值
- `results/sentence_metrics.csv`：句子级 fast / standard 的语料级 chrF / BLEU、评审修正触发率、平均评审分与 token

MQM 评审按块批量并发执行，命中缓存时不调用模型。

命令行：`uv run --no-sync python -m eval.ablation.aggregate [--no-mqm] [--judge-workers 4]`
"""

from __future__ import annotations

import argparse
import json
from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pandas as pd

from eval.ablation.runner import DOC_RESULTS, GROUPS, SENTENCE_RESULTS
from eval.config import RESULTS_DIR
from eval.dataset.k8s import K8S_DIR
from eval.dataset.terms import TERMS_PATH, load_terms
from eval.metrics.chrf_bleu import corpus_bleu, corpus_chrf, doc_bleu, doc_chrf
from eval.metrics.cost import task_cost
from eval.metrics.mqm_judge import ChunkJudgement, MqmJudge, chunk_pairs, summarize
from eval.metrics.terminology import TermEntry, detect_lockin, evaluate_terms

METRIC_COLUMNS = [
    "chrf",
    "bleu",
    "mqm",
    "term_accuracy",
    "term_consistency",
    "proper_noun_consistency",
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "node_latency_ms",
    "chunk_latency_ms",
    "wall_ms",
]
GROUP_ORDER = list(GROUPS)


def assemble_translation(segments: list[dict]) -> str:
    """按 prefix + 译文 + suffix 拼回整篇（与平台导出一致；没有译文的段落使用原文）。"""
    parts = []
    for s in sorted(segments, key=lambda s: s.get("seq", 0)):
        body = s.get("target") if s.get("translatable") and s.get("target") is not None else s.get("source")
        parts.append(f"{s.get('prefix') or ''}{body or ''}{s.get('suffix') or ''}")
    return "".join(parts)


def load_results(root: Path = DOC_RESULTS) -> tuple[list[dict], list[dict]]:
    ok, failed = [], []
    for p in sorted(root.glob("*.json")):
        data = json.loads(p.read_text(encoding="utf-8"))
        (failed if p.name.endswith(".failed.json") else ok).append(data)
    done = {(r["doc"], r["group"], r["run"]) for r in ok}
    failed = [f for f in failed if (f["doc"], f["group"], f["run"]) not in done]
    return ok, failed


def judge_results(results: list[dict], judge: MqmJudge, workers: int = 4) -> dict[tuple, list[ChunkJudgement]]:
    """对所有结果的所有块做 MQM 评审（并发、带缓存）。返回 {(doc, group, run): [块评审]}。"""
    jobs = []
    for r in results:
        for idx, pairs in chunk_pairs(r["segments"]).items():
            jobs.append(((r["doc"], r["group"], r["run"]), idx, pairs))

    def work(job):
        key, idx, pairs = job
        return key, judge.judge_chunk(key[0], key[1], idx, pairs)

    out: dict[tuple, list[ChunkJudgement]] = {}
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        for key, cj in pool.map(work, jobs):
            out.setdefault(key, []).append(cj)
    return out


def doc_row(
    result: dict,
    reference: str,
    entries: list[TermEntry],
    chunks: list[ChunkJudgement] | None,
) -> dict:
    segments = result["segments"]
    hyp = assemble_translation(segments)
    pairs = [(s["source"], s.get("target")) for s in segments if s.get("translatable")]
    terms = evaluate_terms(pairs, entries)
    locked = detect_lockin(pairs, entries)
    cost = task_cost(result.get("task") or {}, result.get("traces") or [])
    stats = (result.get("task") or {}).get("stats") or {}
    row = {
        "doc": result["doc"],
        "group": result["group"],
        "run": result["run"],
        "status": result.get("status"),
        "task_id": result.get("taskId"),
        "retries": result.get("retries", 0),
        "strategy": result["config"]["strategy"],
        "chrf": doc_chrf(hyp, reference),
        "bleu": doc_bleu(hyp, reference),
        "mqm": None,
        "mqm_chunks": None,
        "mqm_missing_chunks": None,
        "mqm_words": None,
        "mqm_critical": None,
        "mqm_major": None,
        "mqm_minor": None,
        "term_accuracy": terms.accuracy,
        "term_consistency": terms.consistency,
        "proper_noun_consistency": terms.proper_noun_consistency,
        "term_occurrences": terms.occurrences,
        "lockin": bool(locked),
        "lockin_terms": ";".join(f"{t.source}({t.kept}/{t.occurrences})" for t in locked),
        "prompt_tokens": cost.prompt_tokens,
        "completion_tokens": cost.completion_tokens,
        "total_tokens": cost.total_tokens,
        "node_latency_ms": cost.node_latency_ms,
        "chunk_latency_ms": cost.chunk_latency_ms,
        "wall_ms": cost.wall_ms,
        "chunks": stats.get("chunks"),
        "refined": stats.get("refined"),
        "segments": len(segments),
        "untranslated_segments": sum(1 for s in segments if s.get("translatable") and s.get("target") is None),
        "model": (result.get("model") or {}).get("modelName") or (result.get("model") or {}).get("name"),
        "git_commit": result.get("gitCommit"),
        "error": result.get("error"),
    }
    if chunks is not None:
        doc = summarize(sorted(chunks, key=lambda c: c.chunk_index))
        row.update(
            mqm=doc.score,
            mqm_chunks=len(chunks),
            mqm_missing_chunks=doc.missing_chunks,
            mqm_words=doc.judged_words,
            mqm_critical=doc.by_severity.get("critical", 0),
            mqm_major=doc.by_severity.get("major", 0),
            mqm_minor=doc.by_severity.get("minor", 0),
        )
    return row


def failed_row(result: dict) -> dict:
    return {
        "doc": result["doc"],
        "group": result["group"],
        "run": result["run"],
        "status": result.get("status", "FAILED"),
        "task_id": result.get("taskId"),
        "retries": result.get("retries", 0),
        "strategy": (result.get("config") or {}).get("strategy"),
        "error": result.get("error"),
    }


def build_doc_metrics(
    results: list[dict],
    failed: list[dict],
    *,
    judge: MqmJudge | None,
    judge_workers: int = 4,
    k8s_dir: Path = K8S_DIR,
    terms_path: Path = TERMS_PATH,
) -> pd.DataFrame:
    terms = load_terms(terms_path)
    refs = {doc: (k8s_dir / f"{doc}.zh.md").read_text(encoding="utf-8") for doc in {r["doc"] for r in results}}
    judged = judge_results(results, judge, judge_workers) if judge is not None else {}
    rows = []
    for r in results:
        chunks = judged.get((r["doc"], r["group"], r["run"])) if judge is not None else None
        rows.append(doc_row(r, refs[r["doc"]], terms.get(r["doc"], []), chunks))
    rows += [failed_row(f) for f in failed]
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df["group"] = pd.Categorical(df["group"], categories=GROUP_ORDER, ordered=True)
    return df.sort_values(["group", "doc", "run"]).reset_index(drop=True)


def build_doc_summary(metrics: pd.DataFrame) -> pd.DataFrame:
    if metrics.empty:
        return pd.DataFrame()
    ok = metrics[metrics["status"] == "COMPLETED"].copy()
    ok["group"] = ok["group"].astype(str)
    cols = [c for c in METRIC_COLUMNS if c in ok.columns]
    run1 = ok[ok["run"] == 1]
    rows = []
    for g in GROUP_ORDER:
        sub = run1[run1["group"] == g]
        if sub.empty:
            continue
        rows.append({"group": g, "run": "1", "n_docs": len(sub), **sub[cols].mean(numeric_only=True).to_dict()})
    d4 = ok[ok["group"] == "D4"]
    r1 = d4[d4["run"] == 1].set_index("doc")[cols]
    r2 = d4[d4["run"] == 2].set_index("doc")[cols]
    if not r2.empty:
        rows.append({"group": "D4", "run": "2", "n_docs": len(r2), **r2.mean(numeric_only=True).to_dict()})
        common = r1.index.intersection(r2.index)
        if len(common):
            diff = (r2.loc[common] - r1.loc[common]).astype(float)
            rows.append({"group": "D4", "run": "2-1", "n_docs": len(common), **diff.mean().to_dict()})
            rows.append({"group": "D4", "run": "|2-1|", "n_docs": len(common), **diff.abs().mean().to_dict()})
    failed = metrics[metrics["status"] != "COMPLETED"]
    summary = pd.DataFrame(rows)
    if not summary.empty:
        summary["failed"] = summary.apply(
            lambda r: int((failed["group"].astype(str) == r["group"]).sum()) if r["run"] == "1" else None, axis=1
        )
    return summary


# ---------------------------------------------------------------- 句子级


def load_sentence_records(path: Path) -> list[dict]:
    """同一句可能有失败后重跑的多条记录：取最后一条成功记录。"""
    latest: dict[int, dict] = {}
    if not path.exists():
        return []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        rec = json.loads(line)
        prev = latest.get(rec["id"])
        if rec.get("ok") or prev is None or not prev.get("ok"):
            latest[rec["id"]] = rec
    return [latest[k] for k in sorted(latest)]


def _mean(xs: Iterable[float | None]) -> float | None:
    vals = [x for x in xs if x is not None]
    return sum(vals) / len(vals) if vals else None


def _rate(recs: list[dict], pred) -> float | None:
    return sum(1 for r in recs if pred(r)) / len(recs) if recs else None


def build_sentence_metrics(
    root: Path = SENTENCE_RESULTS, modes: Iterable[str] = ("fast", "standard", "standard_review")
) -> pd.DataFrame:
    rows = []
    for mode in modes:
        recs = load_sentence_records(root / f"{mode}.jsonl")
        ok = [r for r in recs if r.get("ok")]
        if not recs:
            continue
        hyps = [r.get("translation") or "" for r in ok]
        refs = [r["reference"] for r in ok]
        usage = [r.get("usage") or {} for r in ok]
        rows.append(
            {
                "mode": mode,
                "n": len(recs),
                "ok": len(ok),
                "chrf": corpus_chrf(hyps, refs) if ok else None,
                "bleu": corpus_bleu(hyps, refs) if ok else None,
                "review_trigger_rate": _rate(ok, lambda r: (r.get("reviewRounds") or 0) >= 1),
                "first_major_rate": _rate(
                    [r for r in ok if r.get("firstIssues") is not None],
                    lambda r: (r["firstIssues"].get("critical", 0) + r["firstIssues"].get("major", 0)) > 0,
                ),
                "mean_review_rounds": _mean(r.get("reviewRounds") for r in ok),
                "mean_first_score": _mean(r.get("firstScore") for r in ok),
                "mean_final_score": _mean(r.get("finalScore") for r in ok),
                "standard_path_rate": _rate(ok, lambda r: r.get("path") == "standard"),
                "mean_prompt_tokens": _mean(u.get("promptTokens") for u in usage),
                "mean_completion_tokens": _mean(u.get("completionTokens") for u in usage),
                "total_tokens": sum((u.get("promptTokens") or 0) + (u.get("completionTokens") or 0) for u in usage),
                "mean_latency_ms": _mean(r.get("latencyMs") for r in ok),
                "mean_ttfe_ms": _mean(r.get("ttfeMs") for r in ok),
            }
        )
    columns = [
        "mode",
        "n",
        "ok",
        "chrf",
        "bleu",
        "review_trigger_rate",
        "first_major_rate",
        "mean_review_rounds",
        "mean_first_score",
        "mean_final_score",
        "standard_path_rate",
        "mean_prompt_tokens",
        "mean_completion_tokens",
        "total_tokens",
        "mean_latency_ms",
        "mean_ttfe_ms",
    ]
    return pd.DataFrame(rows, columns=columns)


def run(
    *,
    mqm: bool = True,
    judge_workers: int = 4,
    results_dir: Path = RESULTS_DIR,
    judge: MqmJudge | None = None,
    k8s_dir: Path = K8S_DIR,
    terms_path: Path = TERMS_PATH,
) -> dict[str, pd.DataFrame]:
    results, failed = load_results(results_dir / "doc")
    if mqm and judge is None:
        judge = MqmJudge(cache_dir=results_dir / "mqm_cache")
    metrics = build_doc_metrics(
        results,
        failed,
        judge=judge if mqm else None,
        judge_workers=judge_workers,
        k8s_dir=k8s_dir,
        terms_path=terms_path,
    )
    summary = build_doc_summary(metrics)
    sentence = build_sentence_metrics(results_dir / "sentence")
    results_dir.mkdir(parents=True, exist_ok=True)
    metrics.to_csv(results_dir / "doc_metrics.csv", index=False, encoding="utf-8-sig")
    summary.to_csv(results_dir / "doc_summary.csv", index=False, encoding="utf-8-sig")
    sentence.to_csv(results_dir / "sentence_metrics.csv", index=False, encoding="utf-8-sig")
    return {"doc_metrics": metrics, "doc_summary": summary, "sentence_metrics": sentence}


def main() -> None:
    parser = argparse.ArgumentParser(description="汇总消融实验结果")
    parser.add_argument("--no-mqm", action="store_true", help="跳过 MQM 评审（只算参考指标、术语与成本）")
    parser.add_argument("--judge-workers", type=int, default=4)
    args = parser.parse_args()
    judge = None if args.no_mqm else MqmJudge(cache_dir=RESULTS_DIR / "mqm_cache")
    out = run(mqm=not args.no_mqm, judge_workers=args.judge_workers, judge=judge)
    pd.set_option("display.width", 200)
    for name, df in out.items():
        print(f"== {name}（{len(df)} 行）")
        if not df.empty:
            print(df.head(20).to_string())
    if judge is not None:
        print(f"MQM 评审模型调用 {judge.calls} 次（其余命中缓存）")


if __name__ == "__main__":
    main()
