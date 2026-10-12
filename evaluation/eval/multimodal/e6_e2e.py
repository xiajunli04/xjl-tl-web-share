"""E6 端到端抽检（improve-speech-endpointing-and-live-ux 7.4）：实时速度推流 V0 / V1（句中停顿 900 ms）各 10 句。

数据来自 python-backend 生成的 evaluation/data/speech_pause/（先运行 uv run python -m scripts.endpoint_eval data）。
直接连 Python 内部 WS（同 E4，令牌取自 .env 的 INTERNAL_TOKEN），每条样本一条发言流：
- LISTEN（级联同传）：统计每句定稿数、e2eMs、holdMs 与整句 chrF（参考译文来自 E4 数据集）
- CHAT（级联 AI 对话）：统计用户句定稿数、AI 回复条数（期望 1）与 e2eMs（用户说完 → AI 首段语音）
用法：
    uv run python -m eval.multimodal.e6_e2e run [--label new] [--modes LISTEN CHAT]
    uv run python -m eval.multimodal.e6_e2e summarize
输出：results/multimodal/e6_e2e.jsonl、e6_e2e.csv
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import json
import time
import wave
from collections import defaultdict
from pathlib import Path

from sacrebleu.metrics import CHRF

from eval.config import EVAL_ROOT, get_config
from eval.multimodal import speech_dataset
from eval.multimodal.metrics import percentile

OUT = EVAL_ROOT / "results" / "multimodal"
RUNS = OUT / "e6_e2e.jsonl"
PAUSE = EVAL_ROOT / "data" / "speech_pause"
FRAME_BYTES = 1280
TAIL_SECONDS = 2.5
BASES = [f"zh-0{i}" for i in range(1, 6)] + [f"en-0{i}" for i in range(1, 6)]
VARIANTS = {"V0": "{base}-v0", "V1": "{base}-v1-900"}


def _speech_cfg() -> dict:
    import tomllib

    return tomllib.loads((EVAL_ROOT / "config.toml").read_text(encoding="utf-8")).get("speech", {})


def read_pcm(path: Path) -> bytes:
    with wave.open(str(path)) as w:
        return w.readframes(w.getnframes())


async def stream_one(sample: dict, mode: str, cfg: dict, token: str) -> dict:
    import websockets

    lang = sample["lang"]
    if mode == "LISTEN":
        langs = {"sourceLangs": [lang], "targetLangs": [sample["targetLang"]]}
        chat = None
    else:
        ai = "en" if lang != "en" else "zh"
        langs = {"sourceLangs": [lang, ai], "targetLangs": []}
        chat = {"scenario": "free", "myLang": lang, "aiLang": ai, "persona": "Lumi", "greet": False}
    config = {
        "type": "config",
        "streamId": f"e6-{mode}-{sample['id']}-{int(time.time())}",
        "sessionId": 0,
        "userId": 0,
        "mode": mode,
        "engine": "cascade",
        **langs,
        "converseRouting": "auto",
        "glossaryIds": [],
        "domainHint": None,
        "modelConfigId": cfg.get("mt_model_config_id"),
        "asrEngine": "local-sensevoice",
        "ttsEngine": "edge-tts",
        "tts": True,
        "voices": {},
        "gender": "female",
        "chat": chat,
    }
    events: list[dict] = []
    async with websockets.connect(
        cfg["ws_url"], additional_headers={"X-Internal-Token": token}, max_size=None, open_timeout=20
    ) as ws:
        await ws.send(json.dumps(config))

        async def reader():
            async for raw in ws:
                if isinstance(raw, str):
                    events.append(json.loads(raw))

        task = asyncio.create_task(reader())
        pcm = read_pcm(PAUSE / "audio" / f"{sample['id']}.wav")
        frames = [pcm[k : k + FRAME_BYTES] for k in range(0, len(pcm), FRAME_BYTES)]
        frames += [b"\0" * FRAME_BYTES] * int(TAIL_SECONDS / 0.04)
        t0 = time.perf_counter()
        for n, fr in enumerate(frames):
            await ws.send(fr)
            await asyncio.sleep(max(0.0, t0 + (n + 1) * 0.04 - time.perf_counter()))
        deadline = time.perf_counter() + 25
        while time.perf_counter() < deadline:
            await asyncio.sleep(0.3)
            seen = {
                e["utteranceId"]
                for e in events
                if e.get("utteranceId") is not None and e["type"] != "transcript.discard"
            }
            done = {e["utteranceId"] for e in events if e.get("type") == "metrics"}
            discarded = {e["utteranceId"] for e in events if e.get("type") == "transcript.discard"}
            if seen and seen - discarded <= done:
                break
        await ws.send(json.dumps({"type": "end"}))
        try:
            await asyncio.wait_for(task, 5)
        except TimeoutError:
            task.cancel()

    user_finals = [e for e in events if e["type"] == "transcript.final" and e.get("role") != "assistant"]
    replies = [e for e in events if e["type"] == "transcript.final" and e.get("role") == "assistant"]
    target = sample.get("targetLang")
    translations = [
        e["text"]
        for e in events
        if e["type"] == "translation.final" and e.get("lang") == target and e.get("role") != "assistant"
    ]
    metrics = [e for e in events if e["type"] == "metrics" and e.get("e2eMs") is not None]
    holds = [e.get("holdMs") for e in events if e["type"] == "metrics" and e.get("holdMs") is not None]
    joiner = " " if target == "en" else ""
    return {
        "id": sample["id"],
        "variant": sample["variant"],
        "mode": mode,
        "lang": lang,
        "userFinals": [e["text"] for e in user_finals],
        "replies": [e["text"] for e in replies],
        "translation": joiner.join(translations).strip(),
        "e2eMs": [m["e2eMs"] for m in metrics],
        "holdMs": holds,
        "discards": sum(1 for e in events if e["type"] == "transcript.discard"),
        "errors": [e for e in events if e["type"] == "error"],
    }


def samples() -> list[dict]:
    refs = {s["id"]: s for s in speech_dataset.load_sentences()}
    manifest = {
        json.loads(line)["id"]: json.loads(line)
        for line in (PAUSE / "manifest.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    }
    out = []
    for base in BASES:
        for variant, pattern in VARIANTS.items():
            m = manifest[pattern.format(base=base)]
            out.append(
                {**m, "variant": variant, "targetLang": refs[base]["targetLang"], "reference": refs[base]["reference"]}
            )
    return out


async def run(label: str, modes: list[str]) -> None:
    cfg = _speech_cfg()
    token = get_config().env("INTERNAL_TOKEN")
    OUT.mkdir(parents=True, exist_ok=True)
    for mode in modes:
        for s in samples():
            r = await stream_one(s, mode, cfg, token)
            r.update(label=label, reference=s["reference"])
            with RUNS.open("a", encoding="utf-8") as f:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
            print(
                f"{label} {mode} {s['id']}: finals={len(r['userFinals'])} replies={len(r['replies'])} "
                f"e2e={r['e2eMs']} hold={r['holdMs']}"
            )


def summarize() -> list[dict]:
    rows = [json.loads(line) for line in RUNS.read_text(encoding="utf-8").splitlines() if line.strip()]
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for r in rows:
        groups[(r["label"], r["mode"], r["variant"])].append(r)
    chrf = CHRF()
    out = []
    for (label, mode, variant), items in sorted(groups.items()):
        e2e = [v for r in items for v in r["e2eMs"]]
        holds = [v for r in items for v in r["holdMs"]]
        row = {
            "label": label,
            "mode": mode,
            "variant": variant,
            "samples": len(items),
            "fragmented": sum(1 for r in items if len(r["userFinals"]) > 1),
            "finalsPerSample": round(sum(len(r["userFinals"]) for r in items) / len(items), 2),
            "repliesPerSample": round(sum(len(r["replies"]) for r in items) / len(items), 2)
            if mode == "CHAT"
            else None,
            "e2eP50": percentile(e2e, 50),
            "e2eP90": percentile(e2e, 90),
            "holdMsAvg": round(sum(holds) / len(holds)) if holds else 0,
            "chrF": round(
                chrf.corpus_score([r["translation"] for r in items], [[r["reference"] for r in items]]).score, 1
            )
            if mode == "LISTEN"
            else None,
            "errors": sum(len(r["errors"]) for r in items),
        }
        out.append(row)
    with (OUT / "e6_e2e.csv").open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(out[0].keys()))
        w.writeheader()
        w.writerows(out)
    return out


def main() -> int:
    parser = argparse.ArgumentParser(prog="eval.multimodal.e6_e2e")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("run")
    p.add_argument("--label", default="new")
    p.add_argument("--modes", nargs="+", default=["LISTEN", "CHAT"], choices=["LISTEN", "CHAT"])
    sub.add_parser("summarize")
    args = parser.parse_args()
    if args.cmd == "run":
        asyncio.run(run(args.label, args.modes))
        return 0
    for r in summarize():
        print(r)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
