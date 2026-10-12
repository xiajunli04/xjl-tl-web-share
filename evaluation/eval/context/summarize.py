"""E1–E3 汇总：`results/context_summary.csv` 与 `docs/experiments/figures/context_experiments.png`。

CSV 为长表（experiment, group, metric, value），便于报告引用；图为三联：E1 翻译记忆开关的 chrF 与术语准确率、
E2 各现象类型的准确率（有/无会话）、E3 追问的精确率、召回率与片段命中率。

命令行：uv run --no-sync python -m eval.context.summarize
"""

from __future__ import annotations

import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import pandas as pd  # noqa: E402

from eval.ablation.aggregate import doc_row  # noqa: E402
from eval.ablation.plots import BAR, INK, setup_style  # noqa: E402
from eval.config import FIGURES_DIR, RESULTS_DIR  # noqa: E402
from eval.context import ambiguity, session_eval  # noqa: E402
from eval.context.tm_loo import TM_DOC_RESULTS, tm_hit_stats  # noqa: E402
from eval.dataset.k8s import K8S_DIR  # noqa: E402
from eval.dataset.terms import TERMS_PATH, load_terms  # noqa: E402

ACCENT = "#d9822b"
TYPE_LABELS = {
    "pronoun": "代词",
    "ellipsis": "省略",
    "gender": "性别",
    "entity": "专名",
    "polysemy": "多义词",
    "register": "称谓",
    "kinship": "亲属",
}


def e1_rows(root: Path = TM_DOC_RESULTS, k8s_dir: Path = K8S_DIR, terms_path: Path = TERMS_PATH) -> pd.DataFrame:
    terms = load_terms(terms_path)
    rows = []
    for path in sorted(root.glob("*__TM*__run1.json")):
        result = json.loads(path.read_text(encoding="utf-8"))
        ref = (k8s_dir / f"{result['doc']}.zh.md").read_text(encoding="utf-8")
        row = doc_row(result, ref, terms.get(result["doc"], []), None)
        rows.append({**row, **tm_hit_stats(result["segments"])})
    return pd.DataFrame(rows)


def build(results_dir: Path = RESULTS_DIR) -> dict:
    long: list[dict] = []
    e1 = e1_rows()
    e1_mean = pd.DataFrame()
    if not e1.empty:
        cols = ["chrf", "term_accuracy", "term_consistency", "total_tokens", "hits_per_chunk", "mean_fuzzy"]
        e1_mean = e1.groupby("group")[cols].mean()
        for group, r in e1_mean.iterrows():
            long += [{"experiment": "E1", "group": group, "metric": c, "value": r[c]} for c in cols]

    judgement_path = results_dir / "context" / "session_judgement.json"
    e2_rows: list[dict] = []
    by_type: dict = {}
    if judgement_path.exists():
        judgement = json.loads(judgement_path.read_text(encoding="utf-8"))
        e2_rows = session_eval.summarize(judgement, results_dir / "context" / "session")
        by_type = session_eval.accuracy_by_type(judgement)
        for r in e2_rows:
            long += [
                {"experiment": "E2", "group": r["condition"], "metric": k, "value": v}
                for k, v in r.items()
                if k != "condition"
            ]
        for t, b in by_type.items():
            long += [
                {"experiment": "E2", "group": c, "metric": f"accuracy_{t}", "value": b.get(c)}
                for c in session_eval.CONDITIONS
            ]

    e3 = ambiguity.report(ambiguity.load_records(results_dir / "context" / "ambiguity.jsonl"))
    long += [
        {"experiment": "E3", "group": "clarify", "metric": k, "value": v}
        for k, v in e3.items()
        if not isinstance(v, list)
    ]

    summary = pd.DataFrame(long, columns=["experiment", "group", "metric", "value"])
    summary.to_csv(results_dir / "context_summary.csv", index=False, encoding="utf-8-sig")
    return {"summary": summary, "e1": e1, "e1_mean": e1_mean, "e2": e2_rows, "by_type": by_type, "e3": e3}


def plot(data: dict, out: Path = FIGURES_DIR) -> Path:
    setup_style()
    fig, axes = plt.subplots(1, 3, figsize=(15, 4.4))

    ax = axes[0]
    e1 = data["e1_mean"]
    if not e1.empty:
        groups = [g for g in ("TM0", "TM1") if g in e1.index]
        metrics = [("chrf", "d-chrF", 1.0), ("term_accuracy", "术语准确率 ×100", 100.0)]
        width = 0.35
        for i, g in enumerate(groups):
            vals = [e1.loc[g, m] * s for m, _, s in metrics]
            xs = [j + (i - 0.5) * width for j in range(len(metrics))]
            bars = ax.bar(
                xs, vals, width, color=BAR if g == "TM0" else ACCENT, label="记忆关" if g == "TM0" else "记忆开"
            )
            for b, v in zip(bars, vals, strict=True):
                ax.annotate(
                    f"{v:.1f}",
                    (b.get_x() + b.get_width() / 2, v),
                    xytext=(0, 3),
                    textcoords="offset points",
                    ha="center",
                    fontsize=9,
                    color=INK,
                )
        ax.set_xticks(range(len(metrics)), [label for _, label, _ in metrics])
        ax.set_ylim(0, 118)
        ax.legend(frameon=False, ncol=2, loc="upper center")
    ax.set_title("E1 翻译记忆留一法（5 篇均值）")

    ax = axes[1]
    by_type = data["by_type"]
    types = [t for t in TYPE_LABELS if t in by_type]
    if types:
        width = 0.38
        for i, cond in enumerate(session_eval.CONDITIONS):
            vals = [(by_type[t].get(cond) or 0) * 100 for t in types]
            xs = [j + (i - 0.5) * width for j in range(len(types))]
            ax.bar(
                xs,
                vals,
                width,
                color=BAR if cond == "nosession" else ACCENT,
                label="无会话" if cond == "nosession" else "有会话",
            )
        ax.set_xticks(range(len(types)), [TYPE_LABELS[t] for t in types])
        ax.set_ylim(0, 118)
        ax.set_ylabel("现象准确率（%）")
        ax.legend(frameon=False, ncol=2, loc="upper center")
    ax.set_title("E2 会话上下文：各现象的正确率")

    ax = axes[2]
    e3 = data["e3"]
    names = [("precision", "精确率"), ("recall", "召回率"), ("span_hit_rate", "片段命中率")]
    vals = [(e3.get(k) or 0) * 100 for k, _ in names]
    bars = ax.bar([label for _, label in names], vals, color=ACCENT, width=0.55)
    for b, v in zip(bars, vals, strict=True):
        ax.annotate(
            f"{v:.0f}%",
            (b.get_x() + b.get_width() / 2, v),
            xytext=(0, 3),
            textcoords="offset points",
            ha="center",
            fontsize=9,
            color=INK,
        )
    ax.set_ylim(0, 105)
    ax.set_title("E3 歧义追问检测")

    fig.tight_layout()
    out.mkdir(parents=True, exist_ok=True)
    path = out / "context_experiments.png"
    fig.savefig(path)
    plt.close(fig)
    return path


def main() -> None:
    data = build()
    pd.set_option("display.width", 200)
    if not data["e1"].empty:
        print(
            data["e1"][
                [
                    "doc",
                    "group",
                    "chrf",
                    "term_accuracy",
                    "term_consistency",
                    "total_tokens",
                    "hit_segments",
                    "hits_per_chunk",
                ]
            ].to_string()
        )
    for r in data["e2"]:
        print(r)
    print(json.dumps(data["e3"], ensure_ascii=False))
    print(f"已生成 {plot(data)}")


if __name__ == "__main__":
    main()
