"""E3 歧义检测实验：20 句有歧义 + 20 句无歧义，每句在一个新的、允许追问的会话中以标准路径提交，统计追问触发的
精确率、召回率与歧义片段命中率；无歧义句另在关闭追问的会话中各提交一次，比较 plan 节点耗时以估计检测开销。

- 结果：`results/context/ambiguity.jsonl`（逐句追加，已有记录的（句子、条件）跳过）
- 每句结束后删除会话（待回答的追问检查点由 AI 服务按 24 小时规则清理）

命令行：uv run --no-sync python -m eval.context.ambiguity [run|report]
"""

from __future__ import annotations

import argparse
import json
from collections.abc import Callable
from pathlib import Path

from eval.ablation.runner import RateLimiter, git_commit, now_iso
from eval.client import PlatformClient, StreamResult
from eval.config import DATA_DIR, RESULTS_DIR, get_config

SENTENCES = DATA_DIR / "session" / "ambiguity.jsonl"
RESULT = RESULTS_DIR / "context" / "ambiguity.jsonl"


def load_sentences(path: Path = SENTENCES) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def plan_latency(res: StreamResult) -> int | None:
    for event, data in res.events:
        if event == "node" and data.get("node") == "plan" and data.get("status") == "completed":
            return data.get("latencyMs")
    return None


def span_hit(predicted: str | None, gold: str | None) -> bool:
    """追问片段与标注片段（不区分大小写）互相包含即视为命中。"""
    if not predicted or not gold:
        return False
    a, b = predicted.lower().strip(), gold.lower().strip()
    return a in b or b in a


def done_keys(path: Path = RESULT) -> set[tuple[str, str]]:
    if not path.exists():
        return set()
    keys = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rec = json.loads(line)
            if rec.get("ok"):
                keys.add((rec["id"], rec["condition"]))
    return keys


def run_one(
    client: PlatformClient, row: dict, condition: str, *, model_id: int | None, limiter: RateLimiter, commit: str
) -> dict:
    session = client.create_session(
        source_lang="en",
        target_lang="zh",
        title=f"eval-{row['id']}",
        clarifyEnabled=condition == "clarify_on",
        modelConfigId=model_id,
    )
    rec: dict = {
        "id": row["id"],
        "condition": condition,
        "ambiguous": row["ambiguous"],
        "gold_span": row.get("span"),
        "source": row["source"],
        "gitCommit": commit,
        "startedAt": now_iso(),
    }
    try:
        limiter.wait()
        res = client.translate_stream(
            row["source"],
            source_lang="en",
            target_lang="zh",
            mode="standard",
            model_config_id=model_id,
            session_id=session["id"],
        )
        clarify = res.clarify or {}
        rec.update(
            ok=res.ok or res.clarify is not None,
            asked=res.clarify is not None,
            span=clarify.get("span"),
            question=clarify.get("question"),
            options=clarify.get("options"),
            translation=(res.final or {}).get("translation"),
            planLatencyMs=plan_latency(res),
            error=res.error,
        )
    finally:
        try:
            client.delete_session(session["id"])
        except Exception:  # noqa: BLE001 清理失败不影响实验
            pass
    return rec


def run_all(
    *,
    client_factory: Callable[[], PlatformClient] = PlatformClient,
    path: Path = RESULT,
    log: Callable[[str], None] = print,
    interval: float = 3.2,
) -> None:
    cfg = get_config()
    rows = load_sentences()
    jobs = [(r, "clarify_on") for r in rows] + [(r, "clarify_off") for r in rows if not r["ambiguous"]]
    done = done_keys(path)
    limiter = RateLimiter(interval)
    commit = git_commit()
    path.parent.mkdir(parents=True, exist_ok=True)
    with client_factory() as client:
        for row, cond in jobs:
            if (row["id"], cond) in done:
                continue
            rec = run_one(client, row, cond, model_id=cfg.translator_model_id, limiter=limiter, commit=commit)
            with path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            log(f"[{row['id']}/{cond}] asked={rec.get('asked')} span={rec.get('span')}")


def load_records(path: Path = RESULT) -> list[dict]:
    latest: dict[tuple[str, str], dict] = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                rec = json.loads(line)
                latest[(rec["id"], rec["condition"])] = rec
    return list(latest.values())


def report(records: list[dict]) -> dict:
    on = [r for r in records if r["condition"] == "clarify_on" and r.get("ok")]
    tp = [r for r in on if r["ambiguous"] and r["asked"]]
    fp = [r for r in on if not r["ambiguous"] and r["asked"]]
    pos = [r for r in on if r["ambiguous"]]
    asked = len(tp) + len(fp)

    def mean(xs):
        xs = [x for x in xs if x is not None]
        return sum(xs) / len(xs) if xs else None

    plain_on = [r.get("planLatencyMs") for r in on if not r["ambiguous"]]
    plain_off = [r.get("planLatencyMs") for r in records if r["condition"] == "clarify_off" and r.get("ok")]
    return {
        "n_ambiguous": len(pos),
        "n_plain": len(on) - len(pos),
        "true_positive": len(tp),
        "false_positive": len(fp),
        "recall": len(tp) / len(pos) if pos else None,
        "precision": len(tp) / asked if asked else None,
        "span_hit_rate": sum(span_hit(r.get("span"), r.get("gold_span")) for r in tp) / len(tp) if tp else None,
        "plan_ms_clarify_on_plain": mean(plain_on),
        "plan_ms_clarify_off_plain": mean(plain_off),
        "false_positive_ids": [r["id"] for r in fp],
        "missed_ids": [r["id"] for r in pos if not r["asked"]],
    }


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="E3 歧义检测实验")
    parser.add_argument("cmd", choices=["run", "report"])
    args = parser.parse_args(argv)
    if args.cmd == "run":
        run_all()
    print(json.dumps(report(load_records()), ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
