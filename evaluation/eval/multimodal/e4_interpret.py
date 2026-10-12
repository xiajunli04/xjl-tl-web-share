"""E4 同传评测：把数据集音频按实时速度推入 Python 同传端点，统计识别错误率、语音翻译 chrF 与分段延迟。

用法：
    uv run python -m eval.multimodal.e4_interpret run [--groups ...] [--limit-scenes N]
    uv run python -m eval.multimodal.e4_interpret summarize

分组：
- cascade_full：平台级联，同一场景 5 句在一条发言流里连续说（带最近 3 句上下文）+ 评测术语库；
- cascade_plain：平台级联，每句单独一条发言流（无上下文）且不带术语库；
- qwen：百炼 qwen-livetranslate（术语库命中写入热词），同一场景一条发言流；无可用配置时跳过；
- text_upper：参考原文直接走平台文本快速路径（带术语库），作为"识别零错误"时的翻译上界。
直接连接 Python 内部 WS（绕过 Spring，令牌取自 .env 的 INTERNAL_TOKEN），音频 40 ms 一帧、按真实时间推送。
输出：results/multimodal/e4_runs.jsonl、e4_summary.csv、e4_latency.png（--out 可改输出目录）。
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import json
import sys
import time
from collections import defaultdict

from sacrebleu.metrics import CHRF

from eval.client import PlatformClient, PlatformError
from eval.config import EVAL_ROOT, get_config
from eval.multimodal import speech_dataset
from eval.multimodal.metrics import error_rate, percentile

OUT = EVAL_ROOT / "results" / "multimodal"
RUNS = OUT / "e4_runs.jsonl"
GROUPS = ("cascade_full", "cascade_plain", "qwen", "text_upper")
FRAME_BYTES = 1280  # 40 ms @ 16 kHz PCM16
# playMs 为客户端口径：e2eMs + 首包到首个可播放分包的等待（mp3 需等到 segLast/last，pcm16 首包即可播）
LATENCY_KEYS = ("asrMs", "mtFirstMs", "mtMs", "ttsFirstMs", "e2eMs", "playMs")


def _speech_cfg() -> dict:
    import tomllib

    return tomllib.loads((EVAL_ROOT / "config.toml").read_text(encoding="utf-8")).get("speech", {})


def glossary_ids(client: PlatformClient) -> dict[tuple[str, str], int]:
    terms = json.loads((speech_dataset.DATA / "glossary.json").read_text(encoding="utf-8"))
    pairs: dict[tuple[str, str], list[tuple[str, str]]] = defaultdict(list)
    for t in terms:
        pairs[(t["sourceLang"], t["targetLang"])].append((t["source"], t["target"]))
    return {k: client.ensure_glossary(f"E4-{k[0]}-{k[1]}", k[0], k[1], v) for k, v in pairs.items()}


# ---------------------------------------------------------------- 推流


async def run_stream(sentences: list[dict], *, engine: str, glossary: list[int], mt_model: int | None,
                     ws_url: str, token: str, tail_silence: float,
                     latency_mode: str | None = None) -> list[dict]:
    """一条发言流依次说完 sentences，返回每句的识别、译文与指标。"""
    import websockets

    lang, target = sentences[0]["lang"], sentences[0]["targetLang"]
    config = {
        "type": "config", "streamId": f"e4-{engine}-{sentences[0]['id']}", "sessionId": 0, "userId": 0,
        "mode": "LISTEN", "engine": engine, "sourceLangs": [lang], "targetLangs": [target],
        "converseRouting": "auto", "glossaryIds": glossary, "domainHint": None,
        "modelConfigId": mt_model if engine == "cascade" else None,
        "asrEngine": "local-sensevoice", "ttsEngine": "edge-tts", "tts": True, "voices": {}, "gender": "female",
    }
    if latency_mode:
        config["latencyMode"] = latency_mode
    events: list[tuple[float, dict]] = []
    owner: dict[int, int] = {}  # utteranceId → 句下标
    current = {"idx": 0}
    started = time.perf_counter()

    async with websockets.connect(ws_url, additional_headers={"X-Internal-Token": token}, max_size=None,
                                  open_timeout=20) as ws:
        await ws.send(json.dumps(config))

        async def reader():
            async for raw in ws:
                if isinstance(raw, bytes):
                    continue
                e = json.loads(raw)
                events.append((time.perf_counter() - started, e))
                uid = e.get("utteranceId")
                if uid is not None and uid not in owner:
                    owner[uid] = current["idx"]
                if e.get("type") == "error" and e.get("fatal"):
                    return

        task = asyncio.create_task(reader())
        silence = b"\0" * FRAME_BYTES
        for i, s in enumerate(sentences):
            current["idx"] = i
            pcm = speech_dataset.read_pcm16(speech_dataset.wav_path(s["id"]))
            t0 = time.perf_counter()
            frames = [pcm[k:k + FRAME_BYTES] for k in range(0, len(pcm), FRAME_BYTES)]
            frames += [silence] * int(tail_silence / 0.04)
            for n, fr in enumerate(frames):
                await ws.send(fr)
                await asyncio.sleep(max(0.0, t0 + (n + 1) * 0.04 - time.perf_counter()))
        # 等待最后几句处理完：所有已出现的句子都有译文定稿（或源=目标）且音频结束，最长 20 s
        deadline = time.perf_counter() + 20
        while time.perf_counter() < deadline:
            await asyncio.sleep(0.3)
            if _all_settled(events, target):
                break
        await ws.send(json.dumps({"type": "end"}))
        try:
            await asyncio.wait_for(task, 5)
        except TimeoutError:
            task.cancel()

    per: list[dict] = [{"transcripts": [], "translations": [], "metrics": [], "errors": []} for _ in sentences]
    wait = _playable_wait(events)
    for _, e in events:
        uid = e.get("utteranceId")
        if uid is None:
            if e.get("type") == "error":
                per[min(current["idx"], len(per) - 1)]["errors"].append(e)
            continue
        slot = per[owner.get(uid, 0)]
        t = e.get("type")
        if t == "transcript.final":
            slot["transcripts"].append(e.get("text", ""))
        elif t == "translation.final" and e.get("lang") == target:
            slot["translations"].append(e.get("text", ""))
        elif t == "metrics":
            m = {k: e.get(k) for k in LATENCY_KEYS if k != "playMs"}
            if m.get("e2eMs") is not None and uid in wait:
                m["playMs"] = m["e2eMs"] + wait[uid]
            slot["metrics"].append(m)
        elif t == "error":
            slot["errors"].append(e)
    joiner = " " if lang == "en" else ""
    tjoin = " " if target == "en" else ""
    return [{"id": s["id"], "transcript": joiner.join(p["transcripts"]).strip(),
             "translation": tjoin.join(p["translations"]).strip(), "metrics": p["metrics"], "errors": p["errors"],
             "utterances": len(p["transcripts"])} for s, p in zip(sentences, per, strict=True)]


def _playable_wait(events: list[tuple[float, dict]]) -> dict[int, int]:
    """每句首个 audio 到首个可播放分包的等待（毫秒）：pcm16 为 0；mp3 为首个 segLast/last 分包。"""
    first: dict[int, float] = {}
    playable: dict[int, float] = {}
    for t, e in events:
        if e.get("type") != "audio":
            continue
        uid = e["utteranceId"]
        first.setdefault(uid, t)
        if uid not in playable and (e.get("format") == "pcm16" or e.get("segLast") or e.get("last")):
            playable[uid] = t
    return {uid: round((playable[uid] - first[uid]) * 1000) for uid in playable}


def _all_settled(events: list[tuple[float, dict]], target: str) -> bool:
    seen, done = set(), set()
    for _, e in events:
        uid = e.get("utteranceId")
        if uid is None:
            continue
        seen.add(uid)
        if e.get("type") == "metrics":  # metrics 是每句最后一个事件
            done.add(uid)
    return bool(seen) and seen == done


# ---------------------------------------------------------------- 分组


def scenes(limit: int | None) -> list[list[dict]]:
    by: dict[str, list[dict]] = defaultdict(list)
    for s in speech_dataset.load_sentences():
        by[s["scene"]].append(s)
    out = [sorted(v, key=lambda r: r["order"]) for v in by.values()]
    return out[:limit] if limit else out


def qwen_available() -> bool:
    try:
        with PlatformClient() as c:
            engines = c.request("GET", "/api/speech/engines")
        return any(e["id"] == "qwen-livetranslate" and e["available"] for e in engines.get("interpret", []))
    except Exception:  # noqa: BLE001
        return False


async def run_group(group: str, scene_list: list[list[dict]], gids: dict, cfg: dict, token: str) -> list[dict]:
    kw = {"ws_url": cfg.get("ws_url", "ws://localhost:8000/internal/interpret/stream"), "token": token,
          "tail_silence": float(cfg.get("tail_silence_seconds", 1.2)), "mt_model": cfg.get("mt_model_config_id"),
          "latency_mode": cfg.get("latency_mode")}
    out = []
    for sc in scene_list:
        gid = gids.get((sc[0]["lang"], sc[0]["targetLang"]))
        if group == "cascade_plain":
            for s in sc:
                out += await run_stream([s], engine="cascade", glossary=[], **kw)
        else:
            engine = "qwen-livetranslate" if group == "qwen" else "cascade"
            out += await run_stream(sc, engine=engine, glossary=[gid] if gid else [], **kw)
        print(f"{group:13s} {sc[0]['scene']:12s} 完成")
    return out


def run_text_upper(scene_list: list[list[dict]], gids: dict, mt_model: int | None) -> list[dict]:
    out = []
    with PlatformClient() as c:
        for sc in scene_list:
            gid = gids.get((sc[0]["lang"], sc[0]["targetLang"]))
            for s in sc:
                for attempt in range(5):
                    try:
                        res = c.translate_stream(s["text"], source_lang=s["lang"], target_lang=s["targetLang"],
                                                 mode="fast", model_config_id=mt_model,
                                                 glossary_ids=[gid] if gid else [])
                        break
                    except PlatformError as e:  # 平台限流每用户每分钟 20 次（A0212）
                        if e.code != "A0212" or attempt == 4:
                            raise
                        time.sleep(20)
                time.sleep(3.2)
                text = (res.final or {}).get("translation") or (res.final or {}).get("targetText") or ""
                out.append({"id": s["id"], "transcript": s["text"], "translation": text,
                            "metrics": [{"e2eMs": res.total_ms}], "errors": [res.error] if res.error else [],
                            "utterances": 1})
    return out


def run(groups: list[str], limit: int | None, latency_mode: str | None = None, ws: str | None = None) -> None:
    cfg = {**_speech_cfg(), "latency_mode": latency_mode}
    if ws:
        cfg["ws_url"] = ws
    token = get_config().env("INTERNAL_TOKEN")
    OUT.mkdir(parents=True, exist_ok=True)
    scene_list = scenes(limit)
    with PlatformClient() as c:
        gids = glossary_ids(c)
    for g in groups:
        if g == "qwen" and not qwen_available():
            print("qwen-livetranslate 不可用（未配置百炼 REALTIME_TRANSLATE），跳过该组")
            rows = [{"id": s["id"], "skipped": True} for sc in scene_list for s in sc]
        elif g == "text_upper":
            rows = run_text_upper(scene_list, gids, cfg.get("mt_model_config_id"))
        else:
            rows = asyncio.run(run_group(g, scene_list, gids, cfg, token))
        with open(RUNS, "a", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps({"group": g, "ts": time.time(), **r}, ensure_ascii=False) + "\n")


# ---------------------------------------------------------------- 汇总


def load_runs() -> dict[tuple[str, str], dict]:
    latest: dict[tuple[str, str], dict] = {}
    for line in RUNS.read_text(encoding="utf-8").splitlines():
        r = json.loads(line)
        latest[(r["group"], r["id"])] = r
    return latest


def summarize() -> list[dict]:
    sentences = {s["id"]: s for s in speech_dataset.load_sentences()}
    runs = load_runs()
    chrf = CHRF()
    rows = []
    for g in GROUPS:
        for subset in ("全部", "zh→en", "en→zh", "ja→zh", "ko→zh"):
            rs = [r for (gg, sid), r in runs.items() if gg == g and not r.get("skipped")
                  and (subset == "全部" or f"{sentences[sid]['lang']}→{sentences[sid]['targetLang']}" == subset)]
            if not rs:
                if subset == "全部" and any(gg == g for gg, _ in runs):
                    rows.append({"group": g, "subset": subset, "sentences": 0, "note": "跳过（无可用配置）"})
                continue
            refs = [sentences[r["id"]]["reference"] for r in rs]
            hyps = [r["translation"] for r in rs]
            errs = [error_rate(sentences[r["id"]]["text"], r["transcript"], sentences[r["id"]]["lang"]) for r in rs]
            terms = [(t, r) for r in rs for t in sentences[r["id"]]["terms"]]
            lat = defaultdict(list)
            for r in rs:
                for m in r["metrics"]:
                    for k in LATENCY_KEYS:
                        if m.get(k) is not None:
                            lat[k].append(m[k])
            row = {"group": g, "subset": subset, "sentences": len(rs),
                   "asrErrorRate": round(sum(errs) / len(errs), 4),
                   "chrF": round(chrf.corpus_score(hyps, [refs]).score, 2),
                   "termAcc": round(sum(t["target"].lower() in r["translation"].lower() for t, r in terms)
                                    / len(terms), 4) if terms else "",
                   "emptyTranslations": sum(1 for h in hyps if not h),
                   "splitSentences": sum(1 for r in rs if r["utterances"] > 1)}
            for k in LATENCY_KEYS:
                p50, p90 = percentile(lat[k], 50), percentile(lat[k], 90)
                row[f"{k}P50"] = round(p50) if p50 is not None else ""
                row[f"{k}P90"] = round(p90) if p90 is not None else ""
            rows.append(row)
    keys = list(dict.fromkeys(k for r in rows for k in r))
    with open(OUT / "e4_summary.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=keys)
        w.writeheader()
        w.writerows(rows)
    context = []
    for sid, s in sentences.items():
        if s["context"]:
            context.append({"id": sid, "point": s["context"], "reference": s["reference"],
                            **{g: (runs.get((g, sid)) or {}).get("translation", "") for g in GROUPS}})
    (OUT / "e4_context_points.json").write_text(json.dumps(context, ensure_ascii=False, indent=2), encoding="utf-8")
    plot(runs)
    return rows


def plot(runs: dict) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei", "DejaVu Sans"]
    plt.rcParams["axes.unicode_minus"] = False
    labels = {"cascade_full": "级联（上下文+术语）", "cascade_plain": "级联（无上下文/术语）", "qwen": "千问同传"}
    data = {}
    for g in labels:
        vals = [m["e2eMs"] / 1000 for (gg, _), r in runs.items() if gg == g and not r.get("skipped")
                for m in r.get("metrics", []) if m.get("e2eMs") is not None]
        if vals:
            data[labels[g]] = vals
    if not data:
        return
    fig, ax = plt.subplots(figsize=(7, 3.8))
    ax.boxplot(list(data.values()), tick_labels=list(data.keys()), showfliers=True)
    ax.set_ylabel("说话结束 → 首段译音（秒）")
    ax.set_title("E4 端到端延迟分布")
    fig.tight_layout()
    fig.savefig(OUT / "e4_latency.png", dpi=150)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["run", "summarize"])
    ap.add_argument("--groups", default=",".join(GROUPS))
    ap.add_argument("--limit-scenes", type=int)
    ap.add_argument("--latency-mode", choices=["balanced", "fast"])
    ap.add_argument("--ws", help="Python 同传内部 WS 地址，缺省取 config.toml 的 speech.ws_url")
    ap.add_argument("--out", help="输出目录（相对 evaluation/），缺省 results/multimodal；延迟对比测量用单独目录，避免覆盖论文结果")
    a = ap.parse_args()
    if a.out:
        global OUT, RUNS
        OUT = EVAL_ROOT / a.out
        RUNS = OUT / "e4_runs.jsonl"
    if a.cmd == "run":
        run([g for g in a.groups.split(",") if g], a.limit_scenes, a.latency_mode, a.ws)
    for r in summarize():
        print(r)
    return 0


if __name__ == "__main__":
    sys.exit(main())
