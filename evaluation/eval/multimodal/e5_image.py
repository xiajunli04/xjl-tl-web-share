"""E5 图片翻译评测：两步法（平台：视觉 OCR → 术语 → 平台翻译）vs 单次视觉翻译（同一视觉模型一次完成识别与翻译）。

用法：
    uv run python -m eval.multimodal.e5_image run [--limit N] [--groups two_step,one_pass]
    uv run python -m eval.multimodal.e5_image summarize

- two_step：经 Spring `POST /api/image-translations`（engine=vision，带评测术语库）；
- one_pass：直接以 OpenAI 兼容协议调用同一视觉模型（TEST_LLM_*，模型名取 config.toml [image].vision_model），
  术语表整体放进提示词（无法先识别再匹配，只能"盲注入"）。
输出：results/multimodal/e5_runs.jsonl（逐图原始结果）、e5_summary.csv、e5_compare.png。
"""

from __future__ import annotations

import argparse
import base64
import csv
import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor

from sacrebleu.metrics import CHRF

from eval.client import PlatformClient
from eval.config import EVAL_ROOT, get_config
from eval.multimodal import image_dataset
from eval.multimodal.metrics import char_accuracy, match_boxes

OUT = EVAL_ROOT / "results" / "multimodal"
RUNS = OUT / "e5_runs.jsonl"
GROUPS = ("two_step", "one_pass")
LANG_NAME = {"zh": "中文", "en": "英语", "ja": "日语"}


def _image_cfg() -> dict:
    import tomllib

    toml = tomllib.loads((EVAL_ROOT / "config.toml").read_text(encoding="utf-8"))
    return toml.get("image", {})


# ---------------------------------------------------------------- 两步法（平台）


def glossary_ids(client: PlatformClient) -> dict[tuple[str, str], int]:
    """为每个语言对建立评测术语库（E5-<src>-<tgt>），返回 {(src, tgt): id}。"""
    terms = json.loads((image_dataset.DATA / "glossary.json").read_text(encoding="utf-8"))
    pairs: dict[tuple[str, str], list[tuple[str, str]]] = {}
    for t in terms:
        pairs.setdefault((t["sourceLang"], t["targetLang"]), []).append((t["source"], t["target"]))
    return {k: client.ensure_glossary(f"E5-{k[0]}-{k[1]}", k[0], k[1], v) for k, v in pairs.items()}


def run_two_step(row: dict, client: PlatformClient, gids: dict, model_id: int | None) -> dict:
    gid = gids.get((row["sourceLang"], row["targetLang"]))
    res = client.image_translate_stream(str(image_dataset.DATA / row["file"]), target_lang=row["targetLang"],
                                        engine="vision", model_config_id=model_id,
                                        glossary_ids=[gid] if gid else [])
    if res.error or not res.final:
        return {"error": res.error or {"code": "NO_DONE"}, "latencyMs": res.total_ms}
    usage = res.final.get("usage") or {}
    return {"blocks": res.final.get("blocks") or [], "latencyMs": res.final.get("latencyMs") or res.total_ms,
            "promptTokens": usage.get("promptTokens"), "completionTokens": usage.get("completionTokens"),
            "recordId": res.final.get("id")}


# ---------------------------------------------------------------- 单次视觉翻译（基线）

ONE_PASS_PROMPT = """你是图片翻译助手。图片宽 {w} 像素、高 {h} 像素。
识别图中每一行文字，并把它翻译成{target}。只输出 JSON：
{{"blocks":[{{"text":"原文","bbox":[x0,y0,x1,y1],"translation":"译文"}}]}}
- bbox 为该行文字的像素坐标（左上 x0,y0，右下 x1,y1）
- 一行文字一个块，按从上到下的顺序
{terms}"""


def run_one_pass(row: dict, llm, model: str) -> dict:
    terms = json.loads((image_dataset.DATA / "glossary.json").read_text(encoding="utf-8"))
    pair_terms = [t for t in terms if t["sourceLang"] == row["sourceLang"] and t["targetLang"] == row["targetLang"]]
    term_text = ("- 必须使用以下术语译法：" + "；".join(f"{t['source']} → {t['target']}" for t in pair_terms)
                 if pair_terms else "")
    prompt = ONE_PASS_PROMPT.format(w=row["width"], h=row["height"], target=LANG_NAME[row["targetLang"]],
                                    terms=term_text)
    b64 = base64.b64encode((image_dataset.DATA / row["file"]).read_bytes()).decode()
    started = time.perf_counter()
    resp = llm.chat.completions.create(model=model, messages=[{"role": "user", "content": [
        {"type": "text", "text": prompt},
        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}}]}])
    latency = (time.perf_counter() - started) * 1000
    text = resp.choices[0].message.content or ""
    m = re.search(r"\{.*\}", text, re.S)
    try:
        blocks = json.loads(m.group(0))["blocks"] if m else []
    except (json.JSONDecodeError, KeyError, TypeError):
        blocks = []
    w, h = row["width"], row["height"]
    norm = []
    for i, b in enumerate(blocks, 1):
        try:
            x0, y0, x1, y1 = (float(v) for v in b["bbox"])
        except (KeyError, TypeError, ValueError):
            continue
        norm.append({"id": i, "text": b.get("text", ""), "translation": b.get("translation", ""),
                     "bbox": [max(0, x0 / w), max(0, y0 / h), min(1, x1 / w), min(1, y1 / h)]})
    usage = resp.usage
    return {"blocks": norm, "latencyMs": latency, "promptTokens": getattr(usage, "prompt_tokens", None),
            "completionTokens": getattr(usage, "completion_tokens", None)}


# ---------------------------------------------------------------- 评分


def score(row: dict, out: dict) -> dict:
    """逐图评分：块召回（IoU≥0.5）、OCR 字符准确率（未匹配的真值块记 0）、术语遵循、逐块译文对。"""
    truth = row["blocks"]
    pred = out.get("blocks") or []
    pairs = match_boxes([t["bbox"] for t in truth], [p["bbox"] for p in pred])
    by_truth = {i: pred[j] for i, j, _ in pairs}
    accs, hyps = [], []
    for i, t in enumerate(truth):
        p = by_truth.get(i)
        accs.append(char_accuracy(t["text"], p["text"]) if p else 0.0)
        hyps.append((p or {}).get("translation", "") or "")
    term_total = term_ok = 0
    for term in row.get("terms") or []:
        for i, t in enumerate(truth):
            if term["source"] in t["text"]:
                term_total += 1
                term_ok += term["target"].lower() in hyps[i].lower()
    return {"truthBlocks": len(truth), "predBlocks": len(pred), "matched": len(pairs),
            "recall": len(pairs) / len(truth) if truth else 1.0, "ocrAcc": sum(accs) / len(accs) if accs else 1.0,
            "meanIou": sum(s for _, _, s in pairs) / len(pairs) if pairs else 0.0,
            "termTotal": term_total, "termOk": term_ok,
            "refs": [t["reference"] for t in truth], "hyps": hyps}


# ---------------------------------------------------------------- 运行与汇总


def run(groups: list[str], limit: int | None) -> None:
    cfg = get_config()
    rows = image_dataset.load_truth()[:limit] if limit else image_dataset.load_truth()
    OUT.mkdir(parents=True, exist_ok=True)
    done = set()
    if RUNS.exists():
        for line in RUNS.read_text(encoding="utf-8").splitlines():
            r = json.loads(line)
            if not r.get("error"):
                done.add((r["group"], r["id"]))
    img_cfg = _image_cfg()
    model_id = img_cfg.get("vision_model_config_id")

    def two(row):
        with PlatformClient() as c:
            return run_two_step(row, c, gids, model_id)

    def one(row):
        from openai import OpenAI

        llm = OpenAI(base_url=cfg.llm_base_url, api_key=cfg.llm_api_key, timeout=180, max_retries=2)
        return run_one_pass(row, llm, img_cfg.get("vision_model", "gpt-5.6-luna"))

    gids = {}
    if "two_step" in groups:
        with PlatformClient() as c:
            gids = glossary_ids(c)
    jobs = [(g, row) for g in groups for row in rows if (g, row["id"]) not in done]
    print(f"待运行 {len(jobs)} 项（已完成 {len(done)}）")

    def work(job):
        g, row = job
        try:
            out = two(row) if g == "two_step" else one(row)
        except Exception as e:  # noqa: BLE001  记录失败，便于续跑
            out = {"error": {"code": type(e).__name__, "message": str(e)[:300]}}
        rec = {"group": g, "id": row["id"], "scene": row["scene"], "sourceLang": row["sourceLang"],
               "targetLang": row["targetLang"], **out}
        if not out.get("error"):
            rec["score"] = score(row, out)
        return rec

    with ThreadPoolExecutor(max_workers=int(img_cfg.get("concurrency", 2))) as pool, \
            open(RUNS, "a", encoding="utf-8") as f:
        for rec in pool.map(work, jobs):
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            f.flush()
            s = rec.get("score")
            print(f"{rec['group']:9s} {rec['id']:14s} " + (
                f"recall={s['recall']:.2f} ocr={s['ocrAcc']:.2f} {rec['latencyMs'] / 1000:.1f}s" if s
                else f"ERROR {rec['error']}"))


def load_runs() -> list[dict]:
    latest: dict[tuple[str, str], dict] = {}
    for line in RUNS.read_text(encoding="utf-8").splitlines():
        r = json.loads(line)
        if r.get("error") and (r["group"], r["id"]) in latest:
            continue
        latest[(r["group"], r["id"])] = r
    return list(latest.values())


def summarize() -> list[dict]:
    runs = [r for r in load_runs() if r.get("score")]
    chrf = CHRF()
    rows = []
    for g in GROUPS:
        subsets = [("全部", None, None)] + [(s, "scene", s) for s in ("sign", "menu", "label")] + [
            (f"src={lang}", "sourceLang", lang) for lang in ("zh", "en", "ja")]
        for subset, key, value in subsets:
            rs = [r for r in runs if r["group"] == g and (key is None or r[key] == value)]
            if not rs:
                continue
            refs = [x for r in rs for x in r["score"]["refs"]]
            hyps = [x for r in rs for x in r["score"]["hyps"]]
            truth = sum(r["score"]["truthBlocks"] for r in rs)
            term_total = sum(r["score"]["termTotal"] for r in rs)
            lat = sorted(r["latencyMs"] for r in rs)
            rows.append({
                "group": g, "subset": subset, "images": len(rs), "truthBlocks": truth,
                "recall": round(sum(r["score"]["matched"] for r in rs) / truth, 4),
                "ocrAcc": round(sum(r["score"]["ocrAcc"] * r["score"]["truthBlocks"] for r in rs) / truth, 4),
                "meanIou": round(sum(r["score"]["meanIou"] for r in rs) / len(rs), 4),
                "chrF": round(chrf.corpus_score(hyps, [refs]).score, 2),
                # chrF 区分大小写：告示常用标题式大写（No Smoking / No smoking），另报不区分大小写的分数
                "chrFLower": round(chrf.corpus_score([h.lower() for h in hyps], [[r.lower() for r in refs]]).score, 2),
                "termAcc": round(sum(r["score"]["termOk"] for r in rs) / term_total, 4) if term_total else "",
                "termTotal": term_total,
                "latencyP50Ms": round(lat[len(lat) // 2]),
                "avgPromptTokens": round(sum(r.get("promptTokens") or 0 for r in rs) / len(rs)),
                "avgCompletionTokens": round(sum(r.get("completionTokens") or 0 for r in rs) / len(rs)),
            })
    with open(OUT / "e5_summary.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    plot(rows)
    return rows


def plot(rows: list[dict]) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei", "DejaVu Sans"]
    plt.rcParams["axes.unicode_minus"] = False
    overall = {r["group"]: r for r in rows if r["subset"] == "全部"}
    metrics = [("recall", "块召回"), ("ocrAcc", "OCR 字符准确率"), ("termAcc", "术语准确率")]
    labels = {"two_step": "两步法（平台）", "one_pass": "单次视觉翻译"}
    fig, axes = plt.subplots(1, 3, figsize=(12, 3.8))
    ax = axes[0]
    x = range(len(metrics))
    for k, g in enumerate(overall):
        vals = [float(overall[g][m] or 0) for m, _ in metrics]
        ax.bar([i + k * 0.38 for i in x], vals, width=0.38, label=labels[g])
    ax.set_xticks([i + 0.19 for i in x], [n for _, n in metrics])
    ax.set_ylim(0, 1.05)
    ax.legend(fontsize=8, loc="lower center")
    ax.set_title("识别与术语")
    axes[1].bar([labels[g] for g in overall], [overall[g]["chrF"] for g in overall], color=["#4C78A8", "#F58518"])
    axes[1].set_title("译文 chrF")
    axes[2].bar([labels[g] for g in overall], [overall[g]["latencyP50Ms"] / 1000 for g in overall],
                color=["#4C78A8", "#F58518"])
    axes[2].set_title("单图耗时 p50（秒）")
    fig.tight_layout()
    fig.savefig(OUT / "e5_compare.png", dpi=150)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["run", "summarize"])
    ap.add_argument("--groups", default=",".join(GROUPS))
    ap.add_argument("--limit", type=int)
    a = ap.parse_args()
    if a.cmd == "run":
        run([g for g in a.groups.split(",") if g], a.limit)
    for r in summarize():
        print(r)
    return 0


if __name__ == "__main__":
    sys.exit(main())
