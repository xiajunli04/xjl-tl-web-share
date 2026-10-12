"""汇总评审结果，输出单个版本的指标或两个版本的对比（Markdown）。"""

import functools
import json
import re
import statistics
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any

from . import RESULTS_DIR

_LATIN_WORD = re.compile(r"[A-Za-zÀ-ÿ0-9]+(?:['’-][A-Za-zÀ-ÿ0-9]+)*")
_CJK = re.compile(r"[぀-ヿ㐀-鿿가-힯]")


def count_words(text: str) -> int:
    """词数：拉丁文字按词计，中日韩文字每 2 个字折算 1 个词。"""
    return len(_LATIN_WORD.findall(text or "")) + len(_CJK.findall(text or "")) // 2


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _rate(rows: Iterable[dict[str, Any]], key: str) -> float | None:
    vals = [r[key] for r in rows if isinstance(r.get(key), bool)]
    return sum(vals) / len(vals) if vals else None


def _mean(rows: Iterable[dict[str, Any]], key: str) -> float | None:
    vals = [float(r[key]) for r in rows if isinstance(r.get(key), int | float) and not isinstance(r.get(key), bool)]
    return statistics.fmean(vals) if vals else None


@functools.cache
def _joined(label: str, kind: str) -> list[dict[str, Any]]:
    root = RESULTS_DIR / label
    judged = {(j["id"], j["run"]): j for j in read_jsonl(root / f"judge_{kind}.jsonl")}
    return [{**r, **judged.get((r["id"], r["run"]), {})} for r in read_jsonl(root / f"{kind}.jsonl")]


@functools.cache
def _chat_turns(label: str) -> list[dict[str, Any]]:
    root = RESULTS_DIR / label
    judged = {(j["dialogue"], j["i"]): j for j in read_jsonl(root / "judge_chat.jsonl")}
    out = []
    for path in sorted((root / "chat").glob("*.json")):
        d = json.loads(path.read_text(encoding="utf-8"))
        for t in d["turns"]:
            out.append({**t, "dialogue": d["id"], "coach_on": d["my"] != d["ai"], **judged.get((d["id"], t["i"]), {})})
    return out


# (指标名, 计算函数, 目标说明)
Metric = tuple[str, Callable[[str], float | None], str]


def _interpret_metrics() -> list[Metric]:
    def by(cat: str | None, key: str, fn=_rate) -> Callable[[str], float | None]:
        return lambda label: fn([r for r in _joined(label, "interpret") if cat is None or r["category"] == cat], key)

    return [
        ("同传：回答或执行原话的比例", by(None, "answered"), "= 0"),
        ("同传：增译率", by(None, "added_info"), "≤ 10%"),
        ("同传：半句补全率（fragment）", by("fragment", "completed_fragment"), "≤ 10%"),
        ("同传：人称保持率（person）", by("person", "person_kept"), "= 100%"),
        ("同传：数字一致率（numbers）", by("numbers", "numbers_ok"), "= 100%"),
        ("同传：双向对话问答指代正确率（converse）", by("converse", "meets_expect"), "= 100%"),
        ("同传：同音误识别纠正率（homophone）", by("homophone", "meets_expect"), "—"),
        ("同传：符合预期处理方式（全部）", by(None, "meets_expect"), "—"),
        ("同传：忠实度均分（1–5）", by(None, "faithful", _mean), "—"),
    ]


def _subtitle_metrics() -> list[Metric]:
    def by(cat: str | None, key: str, fn=_rate) -> Callable[[str], float | None]:
        return lambda label: fn([r for r in _joined(label, "subtitle") if cat is None or r["category"] == cat], key)

    return [
        ("字幕：示范句保留率（coach）", by("coach", "coach_kept"), "≥ 90%"),
        ("字幕：只译本句的比例", by(None, "only_this"), "—"),
        ("字幕：符合预期处理方式", by(None, "meets_expect"), "—"),
        ("字幕：忠实度均分（1–5）", by(None, "faithful", _mean), "—"),
    ]


def _chat_metrics() -> list[Metric]:
    def tagged(tag: str, key: str, coach_only: bool = False, fn=_rate) -> Callable[[str], float | None]:
        return lambda label: fn(
            [t for t in _chat_turns(label) if tag in (t.get("tags") or []) and (t["coach_on"] or not coach_only)], key
        )

    def recall_at(i: int) -> Callable[[str], float | None]:
        return lambda label: _rate(
            [t for t in _chat_turns(label) if "recall" in (t.get("tags") or []) and t["i"] == i], "recall_correct"
        )

    def words(summary: bool, fn) -> Callable[[str], float | None]:
        def calc(label: str) -> float | None:
            turns = [t for t in _chat_turns(label) if ("summary" in (t.get("tags") or [])) == summary]
            vals = [count_words(t["reply"]) for t in turns]
            return float(fn(vals)) if vals else None

        return calc

    return [
        ("对话：实质性提问轮的示范占比（评审）", tagged("substantive", "coached", True), "≤ 20%"),
        ("对话：实质性提问轮的示范占比（正则）", tagged("substantive", "coached_regex", True), "≤ 20%"),
        ("对话：用户说错时的示范率（wrong_l2）", tagged("wrong_l2", "coached", True), "≥ 60%"),
        ("对话：总结要点覆盖率", tagged("summary", "coverage", fn=_mean), "≥ 0.8"),
        ("对话：第 16 轮回忆正确率", recall_at(16), "≥ 0.8"),
        ("对话：第 17 轮回忆正确率", recall_at(17), "≥ 0.8"),
        ("对话：打断后重复被打断内容的比例", tagged("after_interrupt", "repeated_interrupted"), "越低越好"),
        ("对话：非总结轮回复词数中位数", words(False, statistics.median), "≤ 60"),
        ("对话：总结轮回复词数中位数", words(True, statistics.median), "—"),
        (
            "对话：回复词数最大值",
            lambda label: max((count_words(t["reply"]) for t in _chat_turns(label)), default=None),
            "—",
        ),
    ]


def _fmt(v: float | None, name: str) -> str:
    if v is None:
        return "—"
    if "均分" in name or "覆盖率" in name or "词数" in name:
        return f"{v:.2f}" if "词数" not in name else f"{v:.0f}"
    return f"{v * 100:.1f}%"


def _meta(label: str) -> dict[str, Any]:
    path = RESULTS_DIR / label / "meta.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def render(labels: list[str]) -> str:
    metrics = _interpret_metrics() + _subtitle_metrics() + _chat_metrics()
    lines = ["| 指标 | " + " | ".join(labels) + " | 目标 |", "|---|" + "---|" * (len(labels) + 1)]
    for name, fn, goal in metrics:
        lines.append(f"| {name} | " + " | ".join(_fmt(fn(lb), name) for lb in labels) + f" | {goal} |")
    meta_lines = []
    for lb in labels:
        m = _meta(lb)
        meta_lines.append(
            f"- `{lb}`：适配 {m.get('adapter', '?')}，提示词版本 {m.get('prompt_version', '?')}，"
            f"被测模型 {m.get('model', '?')}，评审模型 {m.get('judge_model', '?')}，代码 {m.get('commit', '?')}"
        )
    return "\n".join(meta_lines) + "\n\n" + "\n".join(lines) + "\n"


def failures(label: str) -> str:
    """列出未达预期的同传与字幕用例，以及回忆失败的对话轮次，便于分析。"""
    out = [f"### `{label}` 未达预期的用例", ""]
    for kind in ("interpret", "subtitle"):
        for r in _joined(label, kind):
            bad = r.get("meets_expect") is False or r.get("answered") or r.get("added_info")
            if bad:
                out.append(f"- [{kind}/{r['id']}#{r['run']}] {r['text']} → {r['output']}（{r.get('note', '')}）")
    for t in _chat_turns(label):
        if t.get("recall_correct") is False or (t.get("coverage") is not None and t["coverage"] < 0.8):
            out.append(f"- [chat/{t['dialogue']}#{t['i']}] {t['text']} → {t['reply']}（{t.get('note', '')}）")
    return "\n".join(out) + "\n"
