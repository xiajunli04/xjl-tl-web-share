"""E6 汇总（D10）：按（组, 档位）统计。

- fragRate：V1 / V2 中一句原句产出多于 1 个定稿的比例（碎句率，越低越好）
- midFragRate：只看"切点在短语中间"的样本的碎句率（如"请问去…""新版本的…"），这是用户实际抱怨的半句；
  切点落在逗号等分句边界时前半句本身是完整分句（如"大家好，"），分开翻译可以接受。切点类型由 baseline 在
  600 ms 停顿下切出的前半句与参考原文的标点位置自动判定（前半句末 ±1 个字词内有分句标点即为分句边界）
- mergeRate：V3（两句间隔 700 ms）被并成 1 个定稿的比例（误合并率，越低越好）
- fillerFinals：只有语气词的定稿数（如"嗯。"，应为 0）
- delayP50 / delayP90：判定延迟（最后一段语音结束 → 定稿，含计算），分 V0（完整句）与 V1/V2（带停顿）
- errRate：定稿文本拼接后对参考原文的字错率（中日韩按字、其他按词；去标点与大小写）
- 达标线（D2）：smart 相对 baseline 碎句率下降 ≥ 50%，且 V0 判定延迟 p50 增加 ≤ 150 ms
"""

import csv
import json
import re
from collections import defaultdict
from typing import Any

from app.speech.endpointing import is_meaningful

from . import RESULTS_DIR
from .run import RUNS

SUMMARY = RESULTS_DIR / "e6_summary.csv"
REPORT_MD = RESULTS_DIR / "e6_summary.md"
_CJK = re.compile(r"[぀-ヿ㐀-䶿一-鿿가-힯]")
_TOKEN = re.compile(r"[぀-ヿ㐀-䶿一-鿿가-힯]|[^\W_]+", re.UNICODE)


def tokens(text: str) -> list[str]:
    return _TOKEN.findall((text or "").lower())


def edit_distance(a: list[str], b: list[str]) -> int:
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i]
        for j, y in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y)))
        prev = cur
    return prev[-1]


def pct(values: list[float], q: float) -> float | None:
    if not values:
        return None
    v = sorted(values)
    k = (len(v) - 1) * q
    lo, hi = int(k), min(int(k) + 1, len(v) - 1)
    return round(v[lo] + (v[hi] - v[lo]) * (k - lo))


_CLAUSE_PUNCT = "，,。.？?！!、；;：:"


def cut_kinds(runs: list[dict]) -> dict[str, str]:
    """每句原句的切点类型：clause（分句边界）/ mid（短语中间）。"""
    kinds: dict[str, str] = {}
    for r in runs:
        if r["group"] != "baseline" or r["profile"] != "interpret" or not r["id"].endswith("-v1-600"):
            continue
        commits = meaningful(r)
        base = r["id"].removesuffix("-v1-600")
        if len(commits) < 2:
            kinds[base] = "clause"  # 没有被切开（切点处原本就几乎没有停顿），按可接受处理
            continue
        k = len(tokens(commits[0]["text"]))
        punct_after: list[bool] = []
        for m in _TOKEN.finditer(r["text"].lower()):
            rest = r["text"][m.end() :].lstrip()
            punct_after.append(bool(rest) and rest[0] in _CLAUSE_PUNCT)
        near = [j for j in (k - 2, k - 1, k) if 0 <= j < len(punct_after)]
        kinds[base] = "clause" if any(punct_after[j] for j in near) else "mid"
    return kinds


def base_of(sample_id: str) -> str:
    return re.sub(r"-v[0-3](-\d+)?$", "", sample_id)


def load_runs() -> list[dict[str, Any]]:
    out = []
    for line in RUNS.read_text(encoding="utf-8").splitlines():
        if line.strip():
            r = json.loads(line)
            if "skipped" not in r:
                out.append(r)
    return out


def summarize() -> list[dict[str, Any]]:
    runs = load_runs()
    kinds = cut_kinds(runs)
    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for r in runs:
        groups[(r["group"], r["profile"])].append(r)
    rows = []
    for (group, profile), items in sorted(groups.items()):
        frag = [r for r in items if r["variant"] in ("V1", "V2")]
        mid = [r for r in frag if kinds.get(base_of(r["id"])) == "mid"]
        pairs = [r for r in items if r["variant"] == "V3"]
        fillers = sum(len(r["commits"]) - len(meaningful(r)) for r in items)
        delays_v0 = [
            c["delayMs"] for r in items if r["variant"] == "V0" for c in r["commits"] if c["delayMs"] is not None
        ]
        delays_pause = [c["delayMs"] for r in frag for c in r["commits"] if c["delayMs"] is not None]
        err_num = err_den = 0
        for r in items:
            ref = tokens(r["text"])
            hyp = tokens("".join(c["text"] for c in r["commits"]))
            err_num += edit_distance(hyp, ref)
            err_den += len(ref)
        holds = [c["holdMs"] for r in items for c in r["commits"] if c.get("holdMs")]
        rows.append(
            {
                "group": group,
                "profile": profile,
                "samples": len(items),
                "fragRate": round(sum(len(meaningful(r)) > 1 for r in frag) / len(frag), 3) if frag else None,
                "midFragRate": _rate(mid, lambda r: len(meaningful(r)) > 1),
                "midSamples": len(mid),
                "fragRateV1": _rate([r for r in frag if r["variant"] == "V1"], lambda r: len(meaningful(r)) > 1),
                "fragRateV2": _rate([r for r in frag if r["variant"] == "V2"], lambda r: len(meaningful(r)) > 1),
                "mergeRate": _rate(pairs, lambda r: len(meaningful(r)) < 2),
                "fillerFinals": fillers,
                "delayP50V0": pct(delays_v0, 0.5),
                "delayP90V0": pct(delays_v0, 0.9),
                "delayP50Pause": pct(delays_pause, 0.5),
                "delayP90Pause": pct(delays_pause, 0.9),
                "holdMsAvg": round(sum(holds) / len(holds)) if holds else 0,
                "errRate": round(err_num / err_den, 3) if err_den else None,
            }
        )
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    with SUMMARY.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    REPORT_MD.write_text(markdown(rows), encoding="utf-8")
    return rows


def meaningful(r: dict) -> list[dict]:
    """有实际内容的定稿（去掉只有语气词的）。"""
    return [c for c in r["commits"] if is_meaningful(c["text"])]


def _rate(items: list[dict], pred) -> float | None:
    return round(sum(1 for r in items if pred(r)) / len(items), 3) if items else None


def verdict(rows: list[dict], profile: str = "interpret", group: str = "smart") -> str:
    base = next((r for r in rows if r["group"] == "baseline" and r["profile"] == profile), None)
    cand = next((r for r in rows if r["group"] == group and r["profile"] == profile), None)
    if not base or not cand:
        return f"{group} / {profile}：缺少对照数据"
    drop = 1 - (cand["fragRate"] or 0) / base["fragRate"] if base["fragRate"] else 0
    mid_drop = 1 - (cand["midFragRate"] or 0) / base["midFragRate"] if base["midFragRate"] else 0
    extra = (cand["delayP50V0"] or 0) - (base["delayP50V0"] or 0)
    ok = drop >= 0.5 and extra <= 150
    return (
        f"{group} / {profile}：碎句率 {base['fragRate']:.1%} → {cand['fragRate']:.1%}（下降 {drop:.0%}；"
        f"短语中间切点 {base['midFragRate']:.1%} → {cand['midFragRate']:.1%}，下降 {mid_drop:.0%}），"
        f"V0 判定延迟 p50 {base['delayP50V0']} → {cand['delayP50V0']} ms（{extra:+} ms）——{'达标' if ok else '未达标'}"
    )


def markdown(rows: list[dict]) -> str:
    head = (
        "| 组 | 档位 | 样本 | 碎句率 | 短语中间切点 | V1 | V2 | 误合并率 | 语气词成句 "
        "| V0 p50/p90 (ms) | 停顿句 p50/p90 (ms) | 平均续说等待 | 字错率 |"
    )
    lines = [head, "|" + "---|" * 13]
    for r in rows:
        lines.append(
            f"| {r['group']} | {r['profile']} | {r['samples']} | {_p(r['fragRate'])} | {_p(r['midFragRate'])} | "
            f"{_p(r['fragRateV1'])} | {_p(r['fragRateV2'])} | "
            f"{_p(r['mergeRate'])} | {r['fillerFinals']} | {r['delayP50V0']}/{r['delayP90V0']} | "
            f"{r['delayP50Pause']}/{r['delayP90Pause']} | {r['holdMsAvg']} | {_p(r['errRate'])} |"
        )
    groups = {r["group"] for r in rows}
    lines.append("")
    for g in sorted(groups - {"baseline"}):
        for p in ("interpret", "fast", "chat"):
            lines.append("- " + verdict(rows, p, g))
    return "\n".join(lines) + "\n"


def _p(v: float | None) -> str:
    return "—" if v is None else f"{v:.1%}"
