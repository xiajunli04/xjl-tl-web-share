"""命令行：uv run python -m scripts.prompt_eval <命令> [选项]（在 python-backend 目录下执行）

- check                         校验评测数据
- interpret | subtitle | chat   用 adapters 构造请求并调用被测模型，结果写入 results/prompt/<label>/（已有条目跳过）
- judge                         评审尚未评审的条目
- report --label A [--compare B] [--out 文件]   输出指标表（对比时 A 为基线）与未达预期的用例
"""

import argparse
import asyncio
import json
import logging
import subprocess
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from . import DATA_DIR, REPO_ROOT, RESULTS_DIR, judge, report
from .client import EvalLLM, judge_model

log = logging.getLogger("prompt_eval")

INTERPRET_CATEGORIES = {
    "question": 8,
    "instruction": 6,
    "fragment": 8,
    "filler": 6,
    "homophone": 4,
    "converse": 4,
    "person": 4,
    "numbers": 4,
}
CHAT_TAGS = {"substantive", "summary", "recall", "wrong_l2", "after_interrupt"}


def load(name: str) -> list[dict[str, Any]]:
    return report.read_jsonl(DATA_DIR / name)


def append_jsonl(path: Path, row: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def _commit() -> str:
    try:
        return subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"], cwd=REPO_ROOT, capture_output=True, text=True, check=True
        ).stdout.strip()
    except Exception:  # noqa: BLE001
        return "?"


def write_meta(label: str, model: str) -> None:
    from . import adapters

    root = RESULTS_DIR / label
    root.mkdir(parents=True, exist_ok=True)
    path = root / "meta.json"
    meta = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    meta.update(
        label=label,
        adapter=adapters.ADAPTER,
        prompt_version=getattr(adapters, "PROMPT_VERSION", "baseline"),
        model=model,
        judge_model=judge_model(),
        commit=_commit(),
        updated_at=datetime.now(UTC).isoformat(timespec="seconds"),
    )
    path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")


# ---------------------------------------------------------------- check


def check() -> None:
    errors: list[str] = []
    cases = load("interpret_cases.jsonl")
    for c in cases:
        for k in ("id", "category", "src", "tgt", "text", "expect"):
            if not c.get(k):
                errors.append(f"interpret {c.get('id')} 缺少 {k}")
        for h in c.get("history") or []:
            if not h.get("lang") or not h.get("text"):
                errors.append(f"interpret {c['id']} 的 history 条目缺少 lang/text")
    counts = Counter(c["category"] for c in cases)
    if dict(counts) != INTERPRET_CATEGORIES:
        errors.append(f"interpret 类别配比不符：{dict(counts)}")
    pairs = Counter(f"{c['src']}->{c['tgt']}" for c in cases)
    subs = load("subtitle_cases.jsonl")
    for s in subs:
        for k in ("id", "category", "src", "tgt", "user", "text", "expect"):
            if not s.get(k):
                errors.append(f"subtitle {s.get('id')} 缺少 {k}")
    dialogues = load("chat_dialogues.jsonl")
    tag_counts: Counter[str] = Counter()
    for d in dialogues:
        turns = d.get("turns") or []
        if not 14 <= len(turns) <= 18:
            errors.append(f"chat {d.get('id')} 轮次数 {len(turns)} 不在 14–18 之间")
        for i, t in enumerate(turns, 1):
            tags = set(t.get("tags") or [])
            if tags - CHAT_TAGS:
                errors.append(f"chat {d['id']}#{i} 未知标签 {tags - CHAT_TAGS}")
            if "summary" in tags and not t.get("keypoints"):
                errors.append(f"chat {d['id']}#{i} 总结轮缺少 keypoints")
            if "recall" in tags and (not t.get("answer") or i < 15):
                errors.append(f"chat {d['id']}#{i} 回忆轮缺少 answer 或位于第 15 轮之前")
            tag_counts.update(tags)
    print(f"interpret {len(cases)} 条：{dict(counts)}；语言对 {dict(pairs)}")
    print(f"subtitle {len(subs)} 条：{dict(Counter(s['category'] for s in subs))}")
    shapes = [(d["id"], d["scenario"], len(d["turns"])) for d in dialogues]
    print(f"chat {len(dialogues)} 段：{shapes}；标签 {dict(tag_counts)}")
    if errors:
        raise SystemExit("校验失败：\n" + "\n".join(errors))
    print("校验通过")


# ---------------------------------------------------------------- run


async def run_cases(kind: str, label: str, model: str | None, runs: int, limit: int | None) -> None:
    from . import adapters  # 按需导入：评审与报告不依赖被测代码的提示词 API

    llm = EvalLLM(model)
    write_meta(label, llm.model)
    cases = load(f"{kind}_cases.jsonl")[:limit]
    path = RESULTS_DIR / label / f"{kind}.jsonl"
    done = {(r["id"], r["run"]) for r in report.read_jsonl(path)}
    build = adapters.interpret_request if kind == "interpret" else adapters.subtitle_request
    sem = asyncio.Semaphore(4)

    async def one(case: dict[str, Any], run: int) -> None:
        async with sem:
            req = build(case)
            raw = await llm.chat(req.messages, temperature=req.temperature, max_tokens=req.max_tokens)
            output = req.post(raw) if hasattr(req, "post") else raw
        append_jsonl(path, {**case, "run": run, "output": output})
        print(f"[{kind}] {case['id']}#{run} {case['text']} → {output}")

    await asyncio.gather(*(one(c, r) for c in cases for r in range(1, runs + 1) if (c["id"], r) not in done))


async def run_chat(label: str, model: str | None, limit: int | None, ids: list[str] | None) -> None:
    from . import adapters

    llm = EvalLLM(model)
    write_meta(label, llm.model)
    root = RESULTS_DIR / label / "chat"
    root.mkdir(parents=True, exist_ok=True)
    dialogues = [d for d in load("chat_dialogues.jsonl") if not ids or d["id"] in ids][:limit]

    async def one(d: dict[str, Any]) -> None:
        path = root / f"{d['id']}.json"
        if path.exists():
            return
        driver = adapters.ChatDriver(llm, d["scenario"], d["my"], d["ai"])
        greeting = await driver.greet()
        turns = []
        for i, t in enumerate(d["turns"], 1):
            kept = driver.interrupt_last() if "after_interrupt" in (t.get("tags") or []) else None
            reply = await driver.turn(t["text"])
            await driver.after_turn()
            turns.append({**t, "i": i, "interrupted_kept": kept, "reply": reply, "summary": driver.summary})
            print(f"[chat {d['id']}#{i}] {t['text']} → {reply}")
        result = {**d, "greeting": greeting, "turns": turns, "compressions": driver.compressions}
        path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    await asyncio.gather(*(one(d) for d in dialogues))


# ---------------------------------------------------------------- judge


def _transcripts(d: dict[str, Any]) -> list[list[dict[str, str]]]:
    """每一轮之前的真实对话（被打断的回复按打断后的样子呈现）。"""
    before: list[list[dict[str, str]]] = []
    convo = [{"role": "assistant", "content": d["greeting"]}]
    for t in d["turns"]:
        if t.get("interrupted_kept") is not None and convo and convo[-1]["role"] == "assistant":
            convo[-1] = {"role": "assistant", "content": t["interrupted_kept"] + "…（被用户打断）"}
        before.append(list(convo))
        convo += [{"role": "user", "content": t["text"]}, {"role": "assistant", "content": t["reply"]}]
    return before


async def run_judge(label: str) -> None:
    llm = EvalLLM(judge_model())
    root = RESULTS_DIR / label
    sem = asyncio.Semaphore(4)
    tasks = []
    for kind, fn in (("interpret", judge.judge_interpret), ("subtitle", judge.judge_subtitle)):
        path = root / f"judge_{kind}.jsonl"
        done = {(r["id"], r["run"]) for r in report.read_jsonl(path)}
        for row in report.read_jsonl(root / f"{kind}.jsonl"):
            if (row["id"], row["run"]) in done:
                continue

            async def one(row=row, fn=fn, path=path) -> None:
                async with sem:
                    out = await fn(llm, row)
                append_jsonl(path, {"id": row["id"], "run": row["run"], **out})

            tasks.append(one())
    chat_path = root / "judge_chat.jsonl"
    done_chat = {(r["dialogue"], r["i"]) for r in report.read_jsonl(chat_path)}
    for path in sorted((root / "chat").glob("*.json")):
        d = json.loads(path.read_text(encoding="utf-8"))
        for t, before in zip(d["turns"], _transcripts(d), strict=True):
            if not t.get("tags") or (d["id"], t["i"]) in done_chat:
                continue

            async def one_chat(d=d, t=t, before=before) -> None:
                async with sem:
                    out = await judge.judge_chat_turn(llm, d, t, before)
                append_jsonl(chat_path, {"dialogue": d["id"], "i": t["i"], **out})

            tasks.append(one_chat())
    print(f"待评审 {len(tasks)} 条")
    await asyncio.gather(*tasks)


# ---------------------------------------------------------------- main


def main() -> None:
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    p = argparse.ArgumentParser(prog="python -m scripts.prompt_eval")
    p.add_argument("command", choices=["check", "interpret", "subtitle", "chat", "judge", "report"])
    p.add_argument("--label", default="smoke")
    p.add_argument("--model", default=None, help="被测模型，缺省为 .env 的 TEST_LLM_MODEL")
    p.add_argument("--runs", type=int, default=2, help="interpret / subtitle 每条用例的重复次数")
    p.add_argument("--limit", type=int, default=None)
    p.add_argument("--ids", nargs="*", default=None, help="chat 只跑指定的对话")
    p.add_argument("--compare", default=None, help="report：与之对比的版本（--label 为基线）")
    p.add_argument("--out", default=None, help="report：同时写入的 Markdown 文件")
    a = p.parse_args()
    if a.command == "check":
        check()
    elif a.command in ("interpret", "subtitle"):
        asyncio.run(run_cases(a.command, a.label, a.model, a.runs, a.limit))
    elif a.command == "chat":
        asyncio.run(run_chat(a.label, a.model, a.limit, a.ids))
    elif a.command == "judge":
        asyncio.run(run_judge(a.label))
    else:
        labels = [a.label] + ([a.compare] if a.compare else [])
        text = report.render(labels) + "\n" + "\n".join(report.failures(lb) for lb in labels)
        print(text)
        if a.out:
            out = Path(a.out)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()
