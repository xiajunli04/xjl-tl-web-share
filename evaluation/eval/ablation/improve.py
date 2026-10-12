"""改进验证汇总（improve-agent-from-experiments design D6）：在 aggregate 生成的 `results/doc_metrics.csv` 与
`results/sentence_metrics.csv` 之上，输出 I 系列与基线的对比。

- `results/improve_summary.csv`：D3 / D4 / D6 与 I1 / I2 / I3 的全部轮次均值（chrF、BLEU、MQM、术语、成本、
  锁定率、修正触发率），另有一行"D3–D6"汇总开启术语抽取的 D 系列锁定率
- `docs/experiments/figures/improve_lockin.png`：各组锁定率
- `docs/experiments/figures/improve_quality_cost.png`：质量—成本散点（D 系列与 I 系列分色）

命令行：先 `python -m eval.ablation.aggregate`，再 `uv run --no-sync python -m eval.ablation.improve`
"""

from __future__ import annotations

import argparse
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import pandas as pd  # noqa: E402

from eval.ablation.plots import BAR, DOT, INK, setup_style  # noqa: E402
from eval.config import FIGURES_DIR, RESULTS_DIR  # noqa: E402

BASELINES = ("D3", "D4", "D6")
IMPROVED = ("I1", "I2", "I3")
EXTRACTION_GROUPS = ("D3", "D4", "D5", "D6")  # 开启术语抽取的 D 系列
ACCENT = "#d9822b"  # I 系列：与主色区分
LABELS = {
    "D3": "D3 +术语抽取",
    "D4": "D4 +评审（串行）",
    "D5": "D5 并行",
    "D6": "D6 混合",
    "I1": "I1 改进后自动",
    "I2": "I2 +独立评审",
    "I3": "I3 +模拟人工确认",
}
SUMMARY_COLUMNS = [
    "chrf",
    "bleu",
    "mqm",
    "mqm_major",
    "term_accuracy",
    "term_consistency",
    "total_tokens",
    "wall_ms",
]


def _completed(metrics: pd.DataFrame) -> pd.DataFrame:
    df = metrics[metrics["status"] == "COMPLETED"].copy()
    df["group"] = df["group"].astype(str)
    df["lockin"] = df["lockin"].astype(str).str.lower().isin(("true", "1"))
    return df


def _row(label: str, sub: pd.DataFrame) -> dict:
    cols = [c for c in SUMMARY_COLUMNS if c in sub.columns]
    chunks = sub["chunks"].fillna(0).sum() if "chunks" in sub else 0
    refined = sub["refined"].fillna(0).sum() if "refined" in sub else 0
    row = {"group": label, "n_runs": len(sub), **sub[cols].mean(numeric_only=True).to_dict()}
    row["lockin_rate"] = float(sub["lockin"].mean()) if len(sub) else None
    row["lockin_runs"] = int(sub["lockin"].sum())
    row["refine_rate"] = float(refined / chunks) if chunks else None
    # 同一文档两轮之间 chrF 之差的绝对值均值：估计随机波动
    runs = sub.pivot_table(index="doc", columns="run", values="chrf")
    row["chrf_run_absdiff"] = float((runs[2] - runs[1]).abs().mean()) if {1, 2} <= set(runs.columns) else None
    return row


def build_improve_summary(metrics: pd.DataFrame) -> pd.DataFrame:
    df = _completed(metrics)
    rows = [_row(g, df[df["group"] == g]) for g in (*BASELINES, *IMPROVED) if (df["group"] == g).any()]
    extraction = df[df["group"].isin(EXTRACTION_GROUPS)]
    if not extraction.empty:
        rows.append(_row("D3–D6", extraction))
    return pd.DataFrame(rows)


def lockin_by_group(metrics: pd.DataFrame) -> pd.DataFrame:
    df = _completed(metrics)
    groups = [g for g in (*EXTRACTION_GROUPS, *IMPROVED) if (df["group"] == g).any()]
    out = df[df["group"].isin(groups)].groupby("group")["lockin"].agg(["mean", "sum", "count"]).reindex(groups)
    return out.rename(columns={"mean": "rate", "sum": "locked", "count": "runs"})


def plot_lockin(metrics: pd.DataFrame, out: Path) -> Path | None:
    data = lockin_by_group(metrics)
    if data.empty:
        return None
    fig, ax = plt.subplots(figsize=(8, 4))
    colors = [ACCENT if g.startswith("I") else BAR for g in data.index]
    bars = ax.bar([LABELS.get(g, g) for g in data.index], data["rate"] * 100, color=colors, width=0.6, zorder=3)
    for b, (_, r) in zip(bars, data.iterrows(), strict=True):
        ax.annotate(
            f"{int(r['locked'])}/{int(r['runs'])}",
            (b.get_x() + b.get_width() / 2, b.get_height()),
            xytext=(0, 3),
            textcoords="offset points",
            ha="center",
            fontsize=9,
            color=INK,
        )
    ax.set_ylabel("发生锁定的运行占比（%）")
    ax.set_ylim(0, max(100, float((data["rate"] * 100).max()) + 10))
    ax.set_title("术语锁定率：改进前（蓝）与改进后（橙）")
    ax.tick_params(axis="x", labelrotation=15)
    fig.tight_layout()
    path = out / "improve_lockin.png"
    fig.savefig(path)
    plt.close(fig)
    return path


def plot_quality_cost(metrics: pd.DataFrame, out: Path) -> Path | None:
    df = _completed(metrics)
    groups = [g for g in (*BASELINES, *IMPROVED) if (df["group"] == g).any()]
    if not groups:
        return None
    mean = df.groupby("group")[["total_tokens", "wall_ms", "chrf", "term_accuracy"]].mean().reindex(groups)
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.5))
    panels = [
        ("total_tokens", "chrf", "平均总 token（输入 + 输出）", "d-chrF", 1.0),
        ("wall_ms", "term_accuracy", "平均墙钟时间（秒）", "术语准确率", 1000.0),
    ]
    for ax, (xc, yc, xl, yl, scale) in zip(axes, panels, strict=True):
        sub = mean[[xc, yc]].dropna()
        for g, r in sub.iterrows():
            color = ACCENT if g.startswith("I") else BAR
            ax.scatter(r[xc] / scale, r[yc], s=64, color=color, edgecolors="white", linewidths=2, zorder=3)
            ax.annotate(g, (r[xc] / scale, r[yc]), xytext=(6, 4), textcoords="offset points", fontsize=9, color=INK)
        ax.set_xlabel(xl)
        ax.set_ylabel(yl)
    axes[0].set_title("质量与 token 成本（蓝：改进前，橙：改进后）")
    axes[1].set_title("术语准确率与耗时")
    for ax in axes:
        ax.grid(color=DOT, alpha=0.2)
    fig.tight_layout()
    path = out / "improve_quality_cost.png"
    fig.savefig(path)
    plt.close(fig)
    return path


def run(
    metrics_csv: Path = RESULTS_DIR / "doc_metrics.csv",
    results_dir: Path = RESULTS_DIR,
    figures: Path = FIGURES_DIR,
) -> dict:
    metrics = pd.read_csv(metrics_csv)
    summary = build_improve_summary(metrics)
    summary.to_csv(results_dir / "improve_summary.csv", index=False, encoding="utf-8-sig")
    setup_style()
    figures.mkdir(parents=True, exist_ok=True)
    paths = [p for p in (plot_lockin(metrics, figures), plot_quality_cost(metrics, figures)) if p]
    return {"summary": summary, "lockin": lockin_by_group(metrics), "figures": paths}


def main() -> None:
    argparse.ArgumentParser(description="改进验证汇总").parse_args()
    out = run()
    pd.set_option("display.width", 220)
    print(out["summary"].to_string())
    print(out["lockin"].to_string())
    for p in out["figures"]:
        print(f"已生成 {p}")


if __name__ == "__main__":
    main()
