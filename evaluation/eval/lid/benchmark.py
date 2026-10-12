"""语种识别对比（design D6）：lingua 高/低精度、fastText lid.176、langdetect、LLM 批量识别。

    uv run --no-sync python -m eval.lid.benchmark                 # 全部识别器
    uv run --no-sync python -m eval.lid.benchmark --skip llm      # 跳过 LLM
    uv run --no-sync python -m eval.lid.benchmark --plots-only    # 只根据已有预测重新汇总与画图

- 所有识别器的输出都映射到 15 种平台语种代码；范围外的预测（以及无法识别）记为 ``"other"``，计为错误
- lingua 限定 15 种语种（与平台一致）；fastText 与 langdetect 不限定（它们本身不支持限定候选集）
- LLM：每档每语种按固定种子抽 10 条（共 450 条），打乱后每次 25 条，返回 JSON 数组；失败重试。
  原始响应按批缓存到 results/lid_llm_raw.jsonl，重跑时已完成的批次不再调用
- 吞吐 = 条数 / 识别耗时（单线程逐条调用，不含模型加载）；LLM 另报告每次调用的平均延迟

输出：results/lid_predictions.csv、lid_metrics.csv（识别器 × 档位 × 语种）、lid_summary.csv（识别器 × 档位）、
lid_confusions.csv（混淆最多的语种对），图存到 docs/experiments/figures/。
"""

from __future__ import annotations

import argparse
import contextlib
import csv
import hashlib
import io
import json
import logging
import random
import re
import sys
import time
from collections import Counter, defaultdict
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path

from eval.config import FIGURES_DIR, RESULTS_DIR, get_config
from eval.lid.data import CACHE_DIR, CODES, SAMPLES_PATH, TIERS, download, load_samples

log = logging.getLogger("eval.lid")

OTHER = "other"
FASTTEXT_URL = "https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.ftz"
FASTTEXT_SHA256 = "8f3472cfe8738a7b6099e8e999c3cbfae0dcd15696aac7d7738a8039db603e83"
LLM_MODEL = "gpt-5.6-luna"
LLM_BATCH = 25
LLM_PER_CELL = 10
LLM_SEED = 20261003
LLM_RETRIES = 4

PREDICTIONS_CSV = RESULTS_DIR / "lid_predictions.csv"
METRICS_CSV = RESULTS_DIR / "lid_metrics.csv"
SUMMARY_CSV = RESULTS_DIR / "lid_summary.csv"
CONFUSIONS_CSV = RESULTS_DIR / "lid_confusions.csv"
LLM_RAW = RESULTS_DIR / "lid_llm_raw.jsonl"

RECOGNIZERS = ("lingua_high", "lingua_low", "fasttext", "langdetect", "llm")
RECOGNIZER_LABELS = {
    "lingua_high": "lingua 高精度",
    "lingua_low": "lingua 低精度",
    "fasttext": "fastText lid.176",
    "langdetect": "langdetect",
    "llm": "LLM（gpt-5.6-luna）",
}
TIER_LABELS = {"word": "单词", "phrase": "词组", "sentence": "整句"}
LANG_LABELS = {
    "zh": "中",
    "en": "英",
    "ja": "日",
    "ko": "韩",
    "fr": "法",
    "de": "德",
    "es": "西",
    "ru": "俄",
    "pt": "葡",
    "it": "意",
    "ar": "阿",
    "th": "泰",
    "vi": "越",
    "id": "印尼",
    "tr": "土",
    OTHER: "其他",
}


# ---------------------------------------------------------------- 语种映射


def normalize_code(raw: str | None) -> str:
    """把各识别器的原始标签映射到 15 种代码；范围外或无法识别时返回 other。

    - fastText：``__label__zh`` → zh（fastText 用 zh 表示中文，不区分简繁）
    - langdetect：``zh-cn`` / ``zh-tw`` → zh
    - lingua：ISO 639-1 名称（如 ``EN``）
    """
    if not raw:
        return OTHER
    code = raw.strip().lower().removeprefix("__label__")
    code = code.replace("_", "-").split("-")[0]
    return code if code in CODES else OTHER


# ---------------------------------------------------------------- 识别器


@dataclass
class RunResult:
    recognizer: str
    predictions: dict[str, tuple[str, str]]  # sample id → (映射后的代码, 原始输出)
    seconds_by_tier: dict[str, float] = field(default_factory=dict)
    count_by_tier: dict[str, int] = field(default_factory=dict)
    calls: int = 0
    call_latencies_ms: list[float] = field(default_factory=list)
    note: str = ""


def _timed_loop(name: str, samples: list[dict], predict: Callable[[str], str]) -> RunResult:
    res = RunResult(name, {})
    for tier in TIERS:
        items = [s for s in samples if s["tier"] == tier]
        started = time.perf_counter()
        for s in items:
            raw = predict(s["text"])
            res.predictions[s["id"]] = (normalize_code(raw), raw or "")
        res.seconds_by_tier[tier] = time.perf_counter() - started
        res.count_by_tier[tier] = len(items)
    return res


def lingua_predictor(low_accuracy: bool) -> Callable[[str], str]:
    from lingua import IsoCode639_1, Language, LanguageDetectorBuilder

    langs = [Language.from_iso_code_639_1(getattr(IsoCode639_1, c.upper())) for c in CODES]
    builder = LanguageDetectorBuilder.from_languages(*langs).with_preloaded_language_models()
    if low_accuracy:
        builder = builder.with_low_accuracy_mode()
    detector = builder.build()
    detector.detect_language_of("warm up")

    def predict(text: str) -> str:
        lang = detector.detect_language_of(text)
        return lang.iso_code_639_1.name if lang is not None else ""

    return predict


def fasttext_model_path() -> Path:
    return download(FASTTEXT_URL, CACHE_DIR / "lid.176.ftz", expected_sha256=FASTTEXT_SHA256)


def fasttext_predictor(model_path: Path) -> Callable[[str], str]:
    """fasttext-wheel 0.9.2 的 ``predict`` 内部调用 ``np.array(probs, copy=False)``，在 numpy 2 下报错；
    这里绕开 Python 包装，直接调用底层 ``model.f.predict``（返回 [(prob, label), ...]）。"""
    import fasttext

    with contextlib.redirect_stderr(io.StringIO()):  # 屏蔽 load_model 的弃用警告
        model = fasttext.load_model(str(model_path))

    def predict(text: str) -> str:
        line = text.replace("\n", " ") + "\n"
        preds = model.f.predict(line, 1, 0.0, "strict")
        return preds[0][1] if preds else ""

    return predict


def langdetect_predictor(seed: int = 0) -> Callable[[str], str]:
    from langdetect import DetectorFactory, LangDetectException, detect

    DetectorFactory.seed = seed

    def predict(text: str) -> str:
        try:
            return detect(text)
        except LangDetectException:
            return ""

    return predict


# ---------------------------------------------------------------- LLM


LLM_SYSTEM = (
    "You are a language identification system. You will receive a JSON array of items, each with an id and a text. "
    "For each item, identify the language of the text and answer with exactly one of these ISO 639-1 codes: "
    + ", ".join(CODES)
    + ', or "other" if it is none of them. Output only a JSON array like [{"id": 1, "lang": "en"}] '
    "with one entry per input item, in the same order, and nothing else."
)
_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)


def llm_subset(samples: list[dict], per_cell: int = LLM_PER_CELL, seed: int = LLM_SEED) -> list[dict]:
    """每档每语种按固定种子抽 per_cell 条，然后整体打乱（同一批中混合多种语种与档位）。"""
    cells: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for s in samples:
        cells[(s["lang"], s["tier"])].append(s)
    rng = random.Random(seed)
    chosen = []
    for key in sorted(cells):
        chosen += rng.sample(cells[key], per_cell)
    rng.shuffle(chosen)
    return chosen


def parse_llm_array(content: str, n: int) -> list[str] | None:
    """解析 [{"id": 1..n, "lang": ...}]；容忍代码块与前后多余文字。id 不完整时返回 None（触发重试）。"""
    s = _FENCE.sub("", (content or "").strip()).strip()
    start, end = s.find("["), s.rfind("]")
    if start < 0 or end <= start:
        return None
    try:
        arr = json.loads(s[start : end + 1])
    except ValueError:
        return None
    if not isinstance(arr, list):
        return None
    by_id: dict[int, str] = {}
    for item in arr:
        if isinstance(item, dict):
            try:
                by_id[int(item.get("id"))] = str(item.get("lang") or "")
            except (TypeError, ValueError):
                continue
    if set(by_id) != set(range(1, n + 1)):
        return None
    return [by_id[i] for i in range(1, n + 1)]


def _load_llm_cache(path: Path) -> dict[str, dict]:
    cache: dict[str, dict] = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                rec = json.loads(line)
                cache[rec["batch_key"]] = rec
    return cache


def run_llm(samples: list[dict], *, model: str = LLM_MODEL, cache_path: Path = LLM_RAW, chat=None) -> RunResult:
    """chat(messages) -> (content, usage dict)；缺省使用 .env 的 TEST_LLM_* 以 OpenAI 兼容协议调用。"""
    subset = llm_subset(samples)
    batches = [subset[i : i + LLM_BATCH] for i in range(0, len(subset), LLM_BATCH)]
    if chat is None:
        chat = _openai_chat(model)
    cache = _load_llm_cache(cache_path)
    res = RunResult("llm", {}, note=f"每档每语种 {LLM_PER_CELL} 条，每批 {LLM_BATCH} 条")
    tier_seconds: Counter[str] = Counter()
    tier_counts: Counter[str] = Counter()
    failed_batches = 0
    for batch in batches:
        # 缓存键包含文本哈希：样本内容变化时不会误用旧结果
        digest = hashlib.sha1("\n".join(s["text"] for s in batch).encode("utf-8")).hexdigest()[:12]
        key = ",".join(s["id"] for s in batch) + "#" + digest
        rec = cache.get(key)
        if rec is None:
            rec = _call_batch(chat, batch, key)
            if rec is not None:
                cache_path.parent.mkdir(parents=True, exist_ok=True)
                with cache_path.open("a", encoding="utf-8") as f:
                    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        if rec is None:
            failed_batches += 1
            labels = [""] * len(batch)
        else:
            labels = rec["labels"]
            res.calls += rec["attempts"]
            res.call_latencies_ms.append(rec["latency_ms"])
            # 批次耗时按条数均摊到各档，用于分档吞吐
            for s in batch:
                tier_seconds[s["tier"]] += rec["latency_ms"] / 1000 / len(batch)
        for s, raw in zip(batch, labels, strict=True):
            res.predictions[s["id"]] = (normalize_code(raw), raw)
            tier_counts[s["tier"]] += 1
    res.seconds_by_tier = dict(tier_seconds)
    res.count_by_tier = dict(tier_counts)
    if failed_batches:
        res.note += f"；{failed_batches} 批重试后仍失败，计为错误"
    return res


def _call_batch(chat, batch: list[dict], key: str) -> dict | None:
    items = [{"id": i, "text": s["text"]} for i, s in enumerate(batch, 1)]
    messages = [
        {"role": "system", "content": LLM_SYSTEM},
        {"role": "user", "content": json.dumps(items, ensure_ascii=False)},
    ]
    for attempt in range(1, LLM_RETRIES + 1):
        started = time.perf_counter()
        try:
            content, usage = chat(messages)
        except Exception as e:  # 网络抖动、TLS 失败等
            log.warning("LLM 调用失败（第 %d 次）：%s", attempt, e)
            time.sleep(min(2**attempt, 30))
            continue
        latency = (time.perf_counter() - started) * 1000
        labels = parse_llm_array(content, len(batch))
        if labels is not None:
            return {
                "batch_key": key,
                "labels": labels,
                "latency_ms": round(latency, 1),
                "attempts": attempt,
                "usage": usage,
                "content": content,
            }
        log.warning("LLM 输出无法解析（第 %d 次）：%.200r", attempt, content)
    return None


def _openai_chat(model: str):
    from openai import OpenAI

    cfg = get_config()
    if not cfg.llm_base_url or not cfg.llm_api_key:
        raise RuntimeError("缺少 TEST_LLM_BASE_URL / TEST_LLM_API_KEY")
    client = OpenAI(base_url=cfg.llm_base_url, api_key=cfg.llm_api_key, timeout=180, max_retries=0)

    def chat(messages):
        resp = client.chat.completions.create(model=model, messages=messages, temperature=0)
        usage = resp.usage.model_dump() if resp.usage else {}
        return resp.choices[0].message.content or "", {k: usage.get(k) for k in ("prompt_tokens", "completion_tokens")}

    return chat


# ---------------------------------------------------------------- 指标


def accuracy_rows(samples: list[dict], predictions: dict[str, dict[str, str]]) -> list[dict]:
    """predictions: recognizer → {sample id → 映射后的代码}。按识别器 × 档位 × 语种统计准确率。"""
    rows = []
    by_id = {s["id"]: s for s in samples}
    for rec, preds in predictions.items():
        cells: dict[tuple[str, str], list[bool]] = defaultdict(list)
        for sid, pred in preds.items():
            s = by_id[sid]
            cells[(s["tier"], s["lang"])].append(pred == s["lang"])
        for tier in TIERS:
            for lang in CODES:
                hits = cells.get((tier, lang))
                if not hits:
                    continue
                rows.append(
                    {
                        "recognizer": rec,
                        "tier": tier,
                        "lang": lang,
                        "n": len(hits),
                        "correct": sum(hits),
                        "accuracy": round(sum(hits) / len(hits), 4),
                    }
                )
    return rows


def confusion_pairs(samples: list[dict], preds: dict[str, str], tier: str | None = None) -> Counter[tuple[str, str]]:
    """(真实语种, 预测) → 次数，只统计错误。"""
    by_id = {s["id"]: s for s in samples}
    pairs: Counter[tuple[str, str]] = Counter()
    for sid, pred in preds.items():
        s = by_id[sid]
        if (tier is None or s["tier"] == tier) and pred != s["lang"]:
            pairs[(s["lang"], pred)] += 1
    return pairs


def summary_rows(samples: list[dict], runs: dict[str, RunResult]) -> list[dict]:
    rows = []
    by_id = {s["id"]: s for s in samples}
    for name, run in runs.items():
        for tier in [*TIERS, "all"]:
            ids = [sid for sid in run.predictions if tier == "all" or by_id[sid]["tier"] == tier]
            if not ids:
                continue
            correct = sum(run.predictions[sid][0] == by_id[sid]["lang"] for sid in ids)
            out_of_scope = sum(run.predictions[sid][0] == OTHER for sid in ids)
            secs = sum(run.seconds_by_tier.values()) if tier == "all" else run.seconds_by_tier.get(tier, 0.0)
            row = {
                "recognizer": name,
                "tier": tier,
                "n": len(ids),
                "accuracy": round(correct / len(ids), 4),
                "other_or_unknown": out_of_scope,
                "throughput_per_s": round(len(ids) / secs, 1) if secs > 0 else "",
                "llm_calls": run.calls if name == "llm" and tier == "all" else "",
                "llm_avg_latency_ms": (
                    round(sum(run.call_latencies_ms) / len(run.call_latencies_ms), 1)
                    if name == "llm" and tier == "all" and run.call_latencies_ms
                    else ""
                ),
                "note": run.note if tier == "all" else "",
            }
            rows.append(row)
    return rows


def write_csv(path: Path, rows: list[dict], fields: Iterable[str] | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = list(fields or (rows[0].keys() if rows else []))
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)


def read_predictions(path: Path = PREDICTIONS_CSV) -> dict[str, dict[str, str]]:
    preds: dict[str, dict[str, str]] = defaultdict(dict)
    with path.open(encoding="utf-8") as f:
        for r in csv.DictReader(f):
            preds[r["recognizer"]][r["id"]] = r["pred"]
    return dict(preds)


# ---------------------------------------------------------------- 图


SERIES_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4"]


def _setup_font():
    import matplotlib

    matplotlib.use("Agg")
    from matplotlib import font_manager

    available = {f.name for f in font_manager.fontManager.ttflist}
    for name in ("Microsoft YaHei", "SimHei", "Noto Sans CJK SC"):
        if name in available:
            matplotlib.rcParams["font.sans-serif"] = [name, "DejaVu Sans"]
            break
    matplotlib.rcParams["axes.unicode_minus"] = False
    import matplotlib.pyplot as plt

    return plt


def plot_tier_accuracy(summary: list[dict], path: Path) -> Path:
    plt = _setup_font()
    recs = [r for r in RECOGNIZERS if any(row["recognizer"] == r for row in summary)]
    acc = {(row["recognizer"], row["tier"]): float(row["accuracy"]) for row in summary}
    fig, ax = plt.subplots(figsize=(9, 4.8), dpi=150)
    width = 0.8 / len(recs)
    for i, rec in enumerate(recs):
        xs = [t + (i - (len(recs) - 1) / 2) * width for t in range(len(TIERS))]
        ys = [acc.get((rec, tier), 0) * 100 for tier in TIERS]
        bars = ax.bar(xs, ys, width * 0.92, label=RECOGNIZER_LABELS[rec], color=SERIES_COLORS[i], zorder=2)
        for b, y in zip(bars, ys, strict=True):
            ax.text(
                b.get_x() + b.get_width() / 2,
                y + 0.8,
                f"{y:.0f}",
                ha="center",
                va="bottom",
                fontsize=7.5,
                color="#52514e",
            )
    ax.set_xticks(range(len(TIERS)), [TIER_LABELS[t] for t in TIERS])
    ax.set_ylabel("准确率（%）")
    ax.set_ylim(0, 108)
    ax.set_title("语种识别分档准确率（15 种语种，LLM 为每档每语种 10 条的子集）", fontsize=11)
    ax.grid(axis="y", color="#e6e5e0", zorder=0)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    ax.legend(ncol=len(recs), fontsize=8, loc="upper center", bbox_to_anchor=(0.5, -0.1), frameon=False)
    fig.tight_layout()
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path)
    plt.close(fig)
    return path


def plot_confusion(samples: list[dict], preds: dict[str, str], recognizer: str, tier: str, path: Path) -> Path:
    plt = _setup_font()
    import numpy as np

    rows = list(CODES)
    cols = [*CODES, OTHER]
    by_id = {s["id"]: s for s in samples}
    m = np.zeros((len(rows), len(cols)))
    for sid, pred in preds.items():
        s = by_id[sid]
        if s["tier"] == tier:
            m[rows.index(s["lang"]), cols.index(pred)] += 1
    totals = m.sum(axis=1, keepdims=True)
    pct = np.divide(m, totals, out=np.zeros_like(m), where=totals > 0) * 100
    fig, ax = plt.subplots(figsize=(8.6, 7.2), dpi=150)
    im = ax.imshow(pct, cmap="Blues", vmin=0, vmax=100)
    ax.set_xticks(range(len(cols)), [LANG_LABELS[c] for c in cols])
    ax.set_yticks(range(len(rows)), [LANG_LABELS[c] for c in rows])
    ax.set_xlabel("预测语种")
    ax.set_ylabel("真实语种")
    for i in range(len(rows)):
        for j in range(len(cols)):
            if m[i, j]:
                ax.text(
                    j,
                    i,
                    f"{int(m[i, j])}",
                    ha="center",
                    va="center",
                    fontsize=7,
                    color="white" if pct[i, j] > 55 else "#0b0b0b",
                )
    ax.set_title(
        f"{RECOGNIZER_LABELS[recognizer]} 混淆矩阵（{TIER_LABELS[tier]}档，每行 100 条，格内为条数）", fontsize=11
    )
    fig.colorbar(im, ax=ax, fraction=0.04, label="占该语种样本的比例（%）")
    fig.tight_layout()
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path)
    plt.close(fig)
    return path


# ---------------------------------------------------------------- 主流程


def run_all(samples: list[dict], skip: set[str]) -> dict[str, RunResult]:
    runs: dict[str, RunResult] = {}
    if "lingua_high" not in skip:
        log.info("lingua 高精度 ...")
        runs["lingua_high"] = _timed_loop("lingua_high", samples, lingua_predictor(False))
    if "lingua_low" not in skip:
        log.info("lingua 低精度 ...")
        runs["lingua_low"] = _timed_loop("lingua_low", samples, lingua_predictor(True))
    if "fasttext" not in skip:
        log.info("fastText ...")
        try:
            runs["fasttext"] = _timed_loop("fasttext", samples, fasttext_predictor(fasttext_model_path()))
        except RuntimeError as e:
            log.error("fastText 不可用，跳过：%s", e)
            runs["fasttext"] = RunResult("fasttext", {}, note=f"跳过：{e}")
    if "langdetect" not in skip:
        log.info("langdetect ...")
        runs["langdetect"] = _timed_loop("langdetect", samples, langdetect_predictor())
    if "llm" not in skip:
        log.info("LLM ...")
        runs["llm"] = run_llm(samples)
    return runs


def report(samples: list[dict], preds: dict[str, dict[str, str]], summary: list[dict], heatmap: str) -> None:
    write_csv(METRICS_CSV, accuracy_rows(samples, preds))
    conf_rows = []
    for rec, p in preds.items():
        for (true, pred), n in confusion_pairs(samples, p).most_common(10):
            conf_rows.append({"recognizer": rec, "true": true, "pred": pred, "count": n})
    write_csv(CONFUSIONS_CSV, conf_rows, ["recognizer", "true", "pred", "count"])
    plot_tier_accuracy([r for r in summary if r["tier"] in TIERS], FIGURES_DIR / "lid_accuracy_by_tier.png")
    if heatmap in preds:
        plot_confusion(samples, preds[heatmap], heatmap, "word", FIGURES_DIR / f"lid_confusion_{heatmap}_word.png")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="语种识别对比")
    parser.add_argument("--skip", nargs="*", default=[], choices=RECOGNIZERS)
    parser.add_argument("--heatmap", default="lingua_high", choices=RECOGNIZERS, help="画混淆热力图的识别器")
    parser.add_argument("--plots-only", action="store_true", help="读取已有的预测与汇总，只重新统计与画图")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)

    if not SAMPLES_PATH.exists():
        print("缺少 data/lid/samples.jsonl，请先执行 python -m eval.lid.data", file=sys.stderr)
        return 2
    samples = load_samples()

    if args.plots_only:
        preds = read_predictions()
        with SUMMARY_CSV.open(encoding="utf-8") as f:
            summary = list(csv.DictReader(f))
        report(samples, preds, summary, args.heatmap)
        return 0

    runs = run_all(samples, set(args.skip))
    pred_rows = [
        {"recognizer": name, "id": sid, "pred": code, "raw": raw}
        for name, run in runs.items()
        for sid, (code, raw) in run.predictions.items()
    ]
    write_csv(PREDICTIONS_CSV, pred_rows, ["recognizer", "id", "pred", "raw"])
    summary = summary_rows(samples, runs)
    skipped = [{"recognizer": n, "tier": "all", "n": 0, "note": r.note} for n, r in runs.items() if not r.predictions]
    write_csv(SUMMARY_CSV, summary + skipped, list(summary[0].keys()))
    preds = {name: {sid: p[0] for sid, p in run.predictions.items()} for name, run in runs.items() if run.predictions}
    report(samples, preds, summary, args.heatmap)
    for r in summary:
        print({k: r[k] for k in ("recognizer", "tier", "n", "accuracy", "throughput_per_s")})
    return 0


if __name__ == "__main__":
    sys.exit(main())
