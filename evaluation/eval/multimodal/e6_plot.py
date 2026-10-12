"""E6 停顿鲁棒性评测作图（improve-speech-endpointing-and-live-ux D10）。

评测本身在 python-backend 运行（uv run python -m scripts.endpoint_eval run / summary，需要断句组件与本地模型）；
本脚本只读 results/multimodal/e6_summary.csv 画图（python-backend 环境没有 matplotlib）：
    uv run python -m eval.multimodal.e6_plot
输出 results/multimodal/e6_latency.png：左为碎句率（越低越好），右为完整句判定延迟 p50（越低越好），
两图各用一个纵轴；柱上直接标注数值，另有 e6_summary.md 表格。
"""

import csv

from eval.config import EVAL_ROOT

OUT = EVAL_ROOT / "results" / "multimodal"
GROUPS = {"baseline": "改造前", "rules": "文本规则", "smart": "文本规则 + Smart Turn"}
PROFILES = {"interpret": "同传·均衡", "fast": "同传·极速", "chat": "对话·均衡"}
COLORS = {"baseline": "#2a78d6", "rules": "#eb6834", "smart": "#1baf7a"}  # 已用 dataviz 校验器验证（浅色）


def main() -> int:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei", "DejaVu Sans"]
    plt.rcParams["axes.unicode_minus"] = False
    rows = list(csv.DictReader((OUT / "e6_summary.csv").open(encoding="utf-8")))
    data = {(r["group"], r["profile"]): r for r in rows}
    groups = [g for g in GROUPS if any(k[0] == g for k in data)]
    fig, axes = plt.subplots(1, 2, figsize=(10, 3.8))
    width = 0.8 / max(1, len(groups))
    panels = (
        ("fragRate", "碎句率（V1/V2，越低越好）", 100, "%"),
        ("delayP50V0", "完整句判定延迟 p50（V0，越低越好）", 1, "ms"),
    )
    for ax, (field, title, scale, unit) in zip(axes, panels, strict=True):
        top = 0.0
        for gi, g in enumerate(groups):
            xs, ys = [], []
            for pi, p in enumerate(PROFILES):
                r = data.get((g, p))
                if r and r[field] not in ("", "None"):
                    xs.append(pi + (gi - (len(groups) - 1) / 2) * width)
                    ys.append(float(r[field]) * scale)
                    top = max(top, ys[-1])
            bars = ax.bar(xs, ys, width=width - 0.04, color=COLORS[g], label=GROUPS[g], edgecolor="white", linewidth=2)
            for b, y in zip(bars, ys, strict=True):
                ax.annotate(
                    f"{y:.0f}",
                    (b.get_x() + b.get_width() / 2, y),
                    ha="center",
                    va="bottom",
                    fontsize=7.5,
                    color="#3d3d3a",
                    xytext=(0, 2),
                    textcoords="offset points",
                )
        ax.set_xticks(range(len(PROFILES)), list(PROFILES.values()))
        ax.set_title(title, fontsize=11)
        ax.set_ylim(0, top * 1.15)
        ax.set_ylabel(unit, color="#5f5e5a")
        ax.grid(axis="y", color="#e5e4df", linewidth=0.8)
        ax.set_axisbelow(True)
        for side in ("top", "right"):
            ax.spines[side].set_visible(False)
        ax.spines["left"].set_color("#c3c2b7")
        ax.spines["bottom"].set_color("#c3c2b7")
    handles, labels = axes[0].get_legend_handles_labels()
    fig.suptitle("E6 停顿鲁棒性：句中停顿 600–1200 ms 与语气词（合成语音）", fontsize=12)
    fig.legend(
        handles, labels, loc="upper center", bbox_to_anchor=(0.5, 0.93), ncol=len(labels), frameon=False, fontsize=9
    )
    fig.tight_layout(rect=(0, 0, 1, 0.86))
    fig.savefig(OUT / "e6_latency.png", dpi=150)
    print(f"写入 {OUT / 'e6_latency.png'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
