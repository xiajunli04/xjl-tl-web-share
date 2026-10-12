"""文档任务吞吐（design D7 场景 3）：批量提交 short-note 任务，测量全部完成的时间与 tasks/min。

平台限制每个用户同时最多 2 个运行中（含排队）的任务，因此任务平均分给 ceil(N/2) 个压测账号提交。
需在 mock 模型为默认模型时执行（由 run.py 负责切换与恢复）。
"""

from __future__ import annotations

import json
import math
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from pathlib import Path

from eval.client import PlatformClient
from eval.config import REPO_ROOT

SHORT_NOTE = REPO_ROOT / "docs" / "contracts" / "fixtures" / "short-note.txt"
PER_USER_LIMIT = 2


@dataclass
class DocThroughputResult:
    tasks: int
    users: int
    completed: int
    failed: int
    wall_seconds: float
    tasks_per_min: float
    latency_ms_p50: float | None
    latency_ms_max: float | None
    task_ids: list[int] = field(default_factory=list)
    statuses: dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


def _percentile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    s = sorted(values)
    k = (len(s) - 1) * q
    lo, hi = math.floor(k), math.ceil(k)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def run_doc_throughput(
    usernames: list[str],
    password: str,
    *,
    tasks: int = 20,
    text: str | None = None,
    timeout: float = 900.0,
    poll: float = 1.0,
) -> DocThroughputResult:
    body = text if text is not None else SHORT_NOTE.read_text(encoding="utf-8")
    n_users = min(len(usernames), math.ceil(tasks / PER_USER_LIMIT))
    if n_users * PER_USER_LIMIT < tasks:
        raise ValueError(f"{tasks} 个任务至少需要 {math.ceil(tasks / PER_USER_LIMIT)} 个账号")
    clients = [PlatformClient(username=u, password=password) for u in usernames[:n_users]]
    for c in clients:
        c.login()

    assignments = [(clients[i % n_users], i) for i in range(tasks)]
    started = time.perf_counter()

    def submit(args):
        client, i = args
        task = client.create_doc_task(body, title=f"perf-short-note-{i}", fmt="txt", source_lang="en")
        return client, task["id"]

    with ThreadPoolExecutor(max_workers=min(tasks, 10)) as pool:
        submitted = list(pool.map(submit, assignments))

    pending = {tid: client for client, tid in submitted}
    finished: dict[int, dict] = {}
    deadline = time.monotonic() + timeout
    while pending and time.monotonic() < deadline:
        for tid, client in list(pending.items()):
            task = client.doc_task(tid)
            if task["status"] in ("COMPLETED", "FAILED", "CANCELLED"):
                finished[tid] = task
                pending.pop(tid)
        if pending:
            time.sleep(poll)
    wall = time.perf_counter() - started
    for c in clients:
        c.close()

    statuses: dict[str, int] = {}
    for t in finished.values():
        statuses[t["status"]] = statuses.get(t["status"], 0) + 1
    if pending:
        statuses["TIMEOUT"] = len(pending)
    completed = statuses.get("COMPLETED", 0)
    latencies = [float(t["latencyMs"]) for t in finished.values() if t.get("latencyMs")]
    return DocThroughputResult(
        tasks=tasks,
        users=n_users,
        completed=completed,
        failed=tasks - completed,
        wall_seconds=round(wall, 2),
        tasks_per_min=round(completed / wall * 60, 2) if wall > 0 else 0.0,
        latency_ms_p50=_percentile(latencies, 0.5),
        latency_ms_max=max(latencies) if latencies else None,
        task_ids=sorted(tid for _, tid in submitted),
        statuses=statuses,
    )


def save_result(result: DocThroughputResult, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"doc_{result.tasks}.json"
    path.write_text(json.dumps(result.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
    return path
