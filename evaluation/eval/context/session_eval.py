"""E2 会话上下文实验：12 段 × 5 轮对话，分无会话（每轮独立）与有会话（同一会话逐轮）两组翻译，再由评审模型
逐项判定标注现象并做成对偏好。

- 有会话组的会话关闭歧义追问（clarifyEnabled=false），只测上下文本身的作用
- 两组使用同一译者模型与同一模式（config.toml [context] session_mode）
- 结果：`results/context/session/{dialogue}__{cond}.json`，已存在则跳过（续跑）

命令行：uv run --no-sync python -m eval.context.session_eval [run|judge] [--dialogues d01 d02]
"""

from __future__ import annotations

import argparse
import json
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from eval.ablation.runner import RateLimiter, git_commit, now_iso
from eval.client import PlatformClient, StreamResult
from eval.config import DATA_DIR, RESULTS_DIR, get_config
from eval.context.judge import ContextJudge

DIALOGUES = DATA_DIR / "session" / "dialogues.jsonl"
SESSION_RESULTS = RESULTS_DIR / "context" / "session"
CONDITIONS = ("nosession", "session")


def load_dialogues(path: Path = DIALOGUES) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def result_path(dialogue_id: str, cond: str, root: Path = SESSION_RESULTS) -> Path:
    return root / f"{dialogue_id}__{cond}.json"


def _translate(
    client: PlatformClient,
    text: str,
    *,
    mode: str,
    model_id: int | None,
    session_id: int | None,
    limiter: RateLimiter,
    attempts: int = 4,
    sleep: Callable[[float], None] = time.sleep,
) -> StreamResult:
    last: StreamResult | None = None
    for i in range(attempts):
        limiter.wait()
        try:
            res = client.translate_stream(
                text, source_lang="en", target_lang="zh", mode=mode, model_config_id=model_id, session_id=session_id
            )
        except Exception:  # noqa: BLE001 限流或网络抖动时退避重试
            sleep(10.0 * (i + 1))
            continue
        if res.ok:
            return res
        last = res
        sleep(5.0 * (i + 1))
    if last is not None:
        return last
    raise RuntimeError(f"翻译失败：{text[:40]}")


def session_turns_used(res: StreamResult) -> int | None:
    """retrieve 节点 detail 中的 sessionTurns：本轮注入的会话轮数。"""
    for event, data in res.events:
        if event == "node" and data.get("node") == "retrieve" and isinstance(data.get("detail"), dict):
            return data["detail"].get("sessionTurns")
    return None


def run_dialogue(
    client: PlatformClient,
    dialogue: dict,
    cond: str,
    *,
    mode: str,
    model_id: int | None,
    limiter: RateLimiter,
    commit: str,
) -> dict:
    session_id = None
    if cond == "session":
        session = client.create_session(
            source_lang="en",
            target_lang="zh",
            title=f"eval-{dialogue['id']}",
            clarifyEnabled=False,
            modelConfigId=model_id,
        )
        session_id = session["id"]
    turns: list[dict[str, Any]] = []
    started = now_iso()
    for idx, turn in enumerate(dialogue["turns"]):
        res = _translate(client, turn["source"], mode=mode, model_id=model_id, session_id=session_id, limiter=limiter)
        final = res.final or {}
        turns.append(
            {
                "index": idx,
                "source": turn["source"],
                "translation": final.get("translation"),
                "ok": res.ok,
                "error": res.error,
                "path": final.get("path"),
                "usage": final.get("usage"),
                "latencyMs": final.get("latencyMs"),
                "recordId": final.get("recordId"),
                "sessionTurns": session_turns_used(res),
            }
        )
    return {
        "dialogue": dialogue["id"],
        "condition": cond,
        "sessionId": session_id,
        "mode": mode,
        "modelConfigId": model_id,
        "gitCommit": commit,
        "startedAt": started,
        "finishedAt": now_iso(),
        "turns": turns,
    }


def run_all(
    dialogue_ids: list[str] | None = None,
    *,
    root: Path = SESSION_RESULTS,
    client_factory: Callable[[], PlatformClient] = PlatformClient,
    log: Callable[[str], None] = print,
    interval: float = 3.2,
) -> list[dict]:
    cfg = get_config()
    dialogues = [d for d in load_dialogues() if not dialogue_ids or d["id"] in dialogue_ids]
    limiter = RateLimiter(interval)
    commit = git_commit()
    out = []
    with client_factory() as client:
        for d in dialogues:
            for cond in CONDITIONS:
                path = result_path(d["id"], cond, root)
                if path.exists():
                    continue
                data = run_dialogue(
                    client,
                    d,
                    cond,
                    mode=cfg.context_session_mode,
                    model_id=cfg.translator_model_id,
                    limiter=limiter,
                    commit=commit,
                )
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
                failed = sum(1 for t in data["turns"] if not t["ok"])
                log(f"[{d['id']}__{cond}] 完成，失败 {failed} 轮")
                out.append(data)
    return out


def judge_all(root: Path = SESSION_RESULTS, judge: ContextJudge | None = None) -> dict:
    """返回 {phenomena: [逐项记录], pairwise: [逐段结论]}，并写入 results/context/session_judgement.json。"""
    judge = judge or ContextJudge()
    items: list[dict] = []
    pairs: list[dict] = []
    for d in load_dialogues():
        runs = {}
        for cond in CONDITIONS:
            path = result_path(d["id"], cond, root)
            if path.exists():
                runs[cond] = json.loads(path.read_text(encoding="utf-8"))
        sources = [t["source"] for t in d["turns"]]
        for cond, run in runs.items():
            for idx, turn in enumerate(d["turns"]):
                phenomena = turn["phenomena"]
                translation = run["turns"][idx].get("translation") or ""
                verdicts = judge.phenomena(sources[:idx], turn["source"], translation, phenomena)
                for p, ok in zip(phenomena, verdicts or [None] * len(phenomena), strict=True):
                    items.append(
                        {
                            "dialogue": d["id"],
                            "turn": idx,
                            "condition": cond,
                            "type": p["type"],
                            "span": p["span"],
                            "correct": ok,
                        }
                    )
        if len(runs) == 2:
            x = [t.get("translation") or "" for t in runs["session"]["turns"]]
            y = [t.get("translation") or "" for t in runs["nosession"]["turns"]]
            verdict = judge.pairwise(sources, x, y)
            pairs.append({"dialogue": d["id"], "winner": {"X": "session", "Y": "nosession"}.get(verdict, "tie")})
    result = {"phenomena": items, "pairwise": pairs, "judgeCalls": judge.calls}
    (root.parent / "session_judgement.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    return result


def summarize(judgement: dict, root: Path = SESSION_RESULTS) -> list[dict]:
    """每组一行：现象准确率（已判定项）、偏好胜/平/负、平均 token。"""
    rows = []
    for cond in CONDITIONS:
        judged = [i for i in judgement["phenomena"] if i["condition"] == cond and i["correct"] is not None]
        tokens = []
        for path in root.glob(f"*__{cond}.json"):
            for t in json.loads(path.read_text(encoding="utf-8"))["turns"]:
                u = t.get("usage") or {}
                if u:
                    tokens.append((u.get("promptTokens") or 0) + (u.get("completionTokens") or 0))
        wins = sum(1 for p in judgement["pairwise"] if p["winner"] == cond)
        ties = sum(1 for p in judgement["pairwise"] if p["winner"] == "tie")
        rows.append(
            {
                "condition": cond,
                "phenomena_judged": len(judged),
                "phenomena_accuracy": sum(i["correct"] for i in judged) / len(judged) if judged else None,
                "pairwise_wins": wins,
                "pairwise_ties": ties,
                "pairwise_total": len(judgement["pairwise"]),
                "mean_tokens_per_turn": sum(tokens) / len(tokens) if tokens else None,
            }
        )
    return rows


def accuracy_by_type(judgement: dict) -> dict[str, dict[str, float | None]]:
    out: dict[str, dict[str, float | None]] = {}
    for item in judgement["phenomena"]:
        if item["correct"] is None:
            continue
        bucket = out.setdefault(item["type"], {})
        key = item["condition"]
        n, k = bucket.get(f"{key}_n", 0), bucket.get(f"{key}_ok", 0)
        bucket[f"{key}_n"], bucket[f"{key}_ok"] = n + 1, k + (1 if item["correct"] else 0)
    for bucket in out.values():
        for cond in CONDITIONS:
            n = bucket.get(f"{cond}_n", 0)
            bucket[cond] = bucket.get(f"{cond}_ok", 0) / n if n else None
    return out


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="E2 会话上下文实验")
    parser.add_argument("cmd", choices=["run", "judge"])
    parser.add_argument("--dialogues", nargs="+")
    args = parser.parse_args(argv)
    if args.cmd == "run":
        run_all(args.dialogues)
    else:
        judgement = judge_all()
        for row in summarize(judgement):
            print(row)
        print(f"评审调用 {judgement['judgeCalls']} 次")


if __name__ == "__main__":
    main()
