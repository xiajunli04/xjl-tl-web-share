"""实验图表（design D9）：读取 `results/doc_metrics.csv`，输出 PNG 到 `docs/experiments/figures/`。

- ablation_bars.png：D0–D6 的 chrF、MQM、术语准确率、术语一致率（2×2，柱为跨文档均值，误差线为标准差，
  灰点为每篇的值；只用第 1 轮）
- quality_cost.png：质量-成本散点（左：总 token vs chrF；右：逐块耗时之和 vs MQM），每点为一组的均值
- strategy_compare.png：D4 串行 / D5 并行 / D6 混合 在 chrF、MQM、术语一致率、墙钟时间上的对比

中文字体按 Microsoft YaHei → SimHei → Noto Sans CJK SC / Noto Sans SC 的顺序回退。
命令行：`uv run --no-sync python -m eval.ablation.plots`
"""

from __future__ import annotations

import argparse
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import pandas as pd  # noqa: E402
from matplotlib import font_manager  # noqa: E402

from eval.ablation.runner import GROUPS  # noqa: E402
from eval.config import FIGURES_DIR, RESULTS_DIR  # noqa: E402

FONT_CANDIDATES = ["Microsoft YaHei", "SimHei", "Noto Sans CJK SC", "Noto Sans SC"]
BAR = "#2a78d6"  # 单一系列：主色
DOT = "#8a8985"  # 每篇的值：中性灰
INK = "#0b0b0b"
INK_2 = "#52514e"
GRID = "#e4e3df"
STRATEGY_LABELS = {"D4": "D4 串行", "D5": "D5 并行", "D6": "D6 混合"}

METRICS = {
    "chrf": ("d-chrF（越高越好）", False),
    "mqm": ("MQM 每千词罚分（越低越好）", True),
    "term_accuracy": ("术语准确率（越高越好）", False),
    "term_consistency": ("术语一致率（越高越好）", False),
}


def setup_style() -> str | None:
    available = {f.name for f in font_manager.fontManager.ttflist}
    font = next((f for f in FONT_CANDIDATES if f in available), None)
    plt.rcParams.update(
        {
            "font.sans-serif": [*([font] if font else []), *FONT_CANDIDATES, "DejaVu Sans"],
            "font.family": "sans-serif",
            "axes.unicode_minus": False,
            "axes.edgecolor": GRID,
            "axes.labelcolor": INK_2,
            "axes.titlecolor": INK,
            "axes.titlesize": 12,
            "axes.grid": True,
            "axes.axisbelow": True,
            "grid.color": GRID,
            "grid.linewidth": 0.8,
            "xtick.color": INK_2,
            "ytick.color": INK_2,
            "axes.spines.top": False,
            "axes.spines.right": False,
            "figure.dpi": 150,
            "savefig.bbox": "tight",
        }
    )
    return font


def _completed(metrics: pd.DataFrame, run: int = 1) -> pd.DataFrame:
    df = metrics[(metrics["status"] == "COMPLETED") & (metrics["run"] == run)].copy()
    df["group"] = df["group"].astype(str)
    return df


def _groups(df: pd.DataFrame) -> list[str]:
    """消融图只画 D 系列；I 系列（改进验证）由 eval.ablation.improve 单独出图。"""
    return [g for g in GROUPS if g.startswith("D") and g in set(df["group"])]


def _fmt(v: float) -> str:
    return f"{v:.2f}" if abs(v) < 10 else f"{v:.1f}"


def _bar_panel(ax, df: pd.DataFrame, groups: list[str], col: str, title: str, labels: dict[str, str] | None = None):
    stats = df.groupby("group")[col].agg(["mean", "std"]).reindex(groups)
    xs = range(len(groups))
    ax.bar(xs, stats["mean"], width=0.6, color=BAR, yerr=stats["std"].fillna(0), ecolor=INK_2, capsize=3, zorder=2)
    for i, g in enumerate(groups):
        vals = df.loc[df["group"] == g, col].dropna()
        ax.scatter([i] * len(vals), vals, s=14, color=DOT, zorder=3, linewidths=0)
        m = stats.loc[g, "mean"]
        if pd.notna(m):
            sd = stats.loc[g, "std"]
            top = max([m + (sd if pd.notna(sd) else 0), *vals.tolist()])  # 标在误差线与散点之上，避免重叠
            ax.annotate(
                _fmt(m),
                (i, top),
                xytext=(0, 3),
                textcoords="offset points",
                ha="center",
                va="bottom",
                fontsize=8,
                color=INK,
            )
    ax.set_xticks(list(xs), [labels.get(g, g) if labels else g for g in groups])
    ax.set_xlim(-0.6, max(len(groups), 3) - 0.4)  # 组数很少时不让柱子撑满整幅
    ax.set_title(title)
    ax.grid(axis="x", visible=False)


def plot_ablation(metrics: pd.DataFrame, out: Path) -> Path | None:
    df = _completed(metrics)
    groups = _groups(df)
    if not groups:
        return None
    fig, axes = plt.subplots(2, 2, figsize=(11, 7.5))
    for ax, (col, (title, _)) in zip(axes.flat, METRICS.items(), strict=True):
        if col in df and df[col].notna().any():
            _bar_panel(ax, df, groups, col, title)
        else:
            ax.set_title(f"{title}（无数据）")
    fig.suptitle("消融实验：各配置组的翻译质量（柱为均值，误差线为标准差，灰点为单篇）", color=INK)
    fig.tight_layout()
    path = out / "ablation_bars.png"
    fig.savefig(path)
    plt.close(fig)
    return path


def plot_quality_cost(metrics: pd.DataFrame, out: Path) -> Path | None:
    df = _completed(metrics)
    groups = _groups(df)
    if not groups:
        return None
    mean = df.groupby("group")[["total_tokens", "chunk_latency_ms", "chrf", "mqm"]].mean().reindex(groups)
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.5))
    panels = [
        ("total_tokens", "chrf", "平均总 token（输入 + 输出）", "d-chrF", 1.0),
        ("chunk_latency_ms", "mqm", "平均逐块耗时之和（秒）", "MQM 每千词罚分（越低越好）", 1000.0),
    ]
    for ax, (xc, yc, xl, yl, scale) in zip(axes, panels, strict=True):
        sub = mean[[xc, yc]].dropna()
        ax.scatter(sub[xc] / scale, sub[yc], s=64, color=BAR, edgecolors="white", linewidths=2, zorder=3)
        for g, r in sub.iterrows():
            ax.annotate(g, (r[xc] / scale, r[yc]), xytext=(6, 4), textcoords="offset points", fontsize=9, color=INK)
        ax.set_xlabel(xl)
        ax.set_ylabel(yl)
    axes[0].set_title("质量与 token 成本")
    axes[1].set_title("质量与耗时成本")
    fig.tight_layout()
    path = out / "quality_cost.png"
    fig.savefig(path)
    plt.close(fig)
    return path


def plot_strategy(metrics: pd.DataFrame, out: Path) -> Path | None:
    df = _completed(metrics)
    df = df[df["group"].isin(STRATEGY_LABELS)]
    groups = [g for g in STRATEGY_LABELS if g in set(df["group"])]
    if not groups:
        return None
    df = df.assign(wall_s=df["wall_ms"] / 1000.0)
    panels = [
        ("chrf", "d-chrF"),
        ("mqm", "MQM 每千词罚分（越低越好）"),
        ("term_consistency", "术语一致率"),
        ("wall_s", "墙钟时间（秒）"),
    ]
    fig, axes = plt.subplots(1, 4, figsize=(14, 4))
    for ax, (col, title) in zip(axes, panels, strict=True):
        if df[col].notna().any():
            _bar_panel(ax, df, groups, col, title, STRATEGY_LABELS)
        else:
            ax.set_title(f"{title}（无数据）")
    fig.suptitle("分块策略对比（全部 Agent 能力开启）", color=INK)
    fig.tight_layout()
    path = out / "strategy_compare.png"
    fig.savefig(path)
    plt.close(fig)
    return path


def run(metrics_csv: Path = RESULTS_DIR / "doc_metrics.csv", out: Path = FIGURES_DIR) -> list[Path]:
    setup_style()
    metrics = pd.read_csv(metrics_csv, encoding="utf-8-sig")
    out.mkdir(parents=True, exist_ok=True)
    paths = [plot_ablation(metrics, out), plot_quality_cost(metrics, out), plot_strategy(metrics, out)]
    return [p for p in paths if p is not None]


def main() -> None:
    parser = argparse.ArgumentParser(description="生成消融实验图表")
    parser.add_argument("--metrics", type=Path, default=RESULTS_DIR / "doc_metrics.csv")
    parser.add_argument("--out", type=Path, default=FIGURES_DIR)
    args = parser.parse_args()
    for p in run(args.metrics, args.out):
        print(f"已生成 {p}")


if __name__ == "__main__":
    main()
