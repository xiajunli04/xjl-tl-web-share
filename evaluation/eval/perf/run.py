"""性能测试执行器（design D7）。

    # 完整压测（主控执行）：10 / 50 / 100 并发各 60 秒 + 文档吞吐
    uv run --no-sync python -m eval.perf.run --users 10 50 100 --duration 60
    # 冒烟
    uv run --no-sync python -m eval.perf.run --users 10 --duration 15
    # 只验证 mock 链路（fast / standard 短文本各一次 + 一个 short-note 文档任务）
    uv run --no-sync python -m eval.perf.run verify
    # 异常退出后手动恢复默认模型
    uv run --no-sync python -m eval.perf.run restore

流程：启动 mock（未运行时）→ 注册压测账号（已存在跳过）→ 注册并启用 mock 模型配置、记录原默认模型并切换为 mock
→ 按档位调用 locust headless（CSV 输出到 results/perf/{scenario}_{users}）→ 文档吞吐 → 汇总 results/perf/summary.csv。
默认模型的恢复由 MockModelSwitch 保证（try/finally + atexit + SIGTERM/SIGBREAK），结束时打印恢复后的状态。
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import os
import subprocess
import sys
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from eval.client import PlatformClient, PlatformError
from eval.config import EVAL_ROOT, RESULTS_DIR, get_config
from eval.perf import doc_throughput
from eval.perf.mock_model import MockModelSwitch, mock_alive, restore_from_file

log = logging.getLogger("eval.perf")

PERF_DIR = RESULTS_DIR / "perf"
LOCUSTFILE = Path(__file__).resolve().parent / "locustfile.py"
SCENARIOS = {"rest": "RestUser", "stream": "StreamUser"}
USER_PREFIX = "perf_user_"
DEFAULT_PASSWORD = "Perf123456"
SUMMARY_FIELDS = [
    "scenario",
    "users",
    "duration_s",
    "name",
    "requests",
    "failures",
    "error_rate",
    "rps",
    "p50_ms",
    "p95_ms",
    "p99_ms",
    "avg_ms",
    "max_ms",
]


def perf_usernames(n: int) -> list[str]:
    return [f"{USER_PREFIX}{i}" for i in range(n)]


def prepare_accounts(n: int, password: str) -> tuple[int, int]:
    """注册 perf_user_0..n-1；已存在（A0111）的跳过。返回 (新建数, 已存在数)。"""
    created = existed = 0
    with PlatformClient(username="-", password="-") as anon:
        for name in perf_usernames(n):
            try:
                anon.register(name, password, nickname=f"压测账号 {name}")
                created += 1
            except PlatformError as e:
                if e.code != "A0111":
                    raise
                existed += 1
    return created, existed


@contextmanager
def mock_server(start: bool) -> Iterator[subprocess.Popen | None]:
    """mock 未运行且 start=True 时以子进程启动，退出时关闭。"""
    if mock_alive():
        yield None
        return
    if not start:
        raise SystemExit("mock LLM 未运行：先执行 uv run --no-sync python -m mock_llm.server，或去掉 --no-start-mock")
    proc = subprocess.Popen([sys.executable, "-m", "mock_llm.server"], cwd=EVAL_ROOT)
    try:
        for _ in range(100):
            if mock_alive(0.5):
                break
            if proc.poll() is not None:
                raise SystemExit(f"mock LLM 启动失败（退出码 {proc.returncode}）")
            time.sleep(0.2)
        else:
            raise SystemExit("mock LLM 启动超时")
        log.info("mock LLM 已启动（pid=%s）", proc.pid)
        yield proc
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.info("mock LLM 已关闭")


def run_locust(scenario: str, users: int, duration: int, spawn_rate: float, password: str, host: str) -> Path:
    prefix = PERF_DIR / f"{scenario}_{users}"
    prefix.mkdir(parents=True, exist_ok=True)
    csv_prefix = prefix / "locust"
    env = {
        **os.environ,
        "PERF_USER_PREFIX": USER_PREFIX,
        "PERF_PASSWORD": password,
        "PERF_USER_OFFSET": "0",
        "PYTHONIOENCODING": "utf-8",
    }
    cmd = [
        sys.executable,
        "-m",
        "locust",
        "-f",
        str(LOCUSTFILE),
        "--headless",
        "-u",
        str(users),
        "-r",
        str(spawn_rate),
        "-t",
        f"{duration}s",
        "--stop-timeout",
        "30",
        "--host",
        host,
        "--csv",
        str(csv_prefix),
        "--only-summary",
        "--loglevel",
        "WARNING",
        SCENARIOS[scenario],
    ]
    log.info("locust %s × %d 用户 × %d 秒", scenario, users, duration)
    proc = subprocess.run(cmd, cwd=EVAL_ROOT, env=env, timeout=duration + 300)
    # locust 有失败请求时退出码为 1，属于正常结果
    if proc.returncode not in (0, 1):
        raise RuntimeError(f"locust 异常退出（{proc.returncode}）")
    return Path(f"{csv_prefix}_stats.csv")


def _num(v: str) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def parse_stats(path: Path, scenario: str, users: int, duration: int) -> list[dict]:
    rows = []
    with path.open(encoding="utf-8") as f:
        for r in csv.DictReader(f):
            requests, failures = int(_num(r["Request Count"])), int(_num(r["Failure Count"]))
            name, rtype = r["Name"], r["Type"]
            if name != "Aggregated" and rtype and not name.startswith(rtype):
                name = f"{rtype} {name}"
            rows.append(
                {
                    "scenario": scenario,
                    "users": users,
                    "duration_s": duration,
                    "name": name,
                    "requests": requests,
                    "failures": failures,
                    "error_rate": round(failures / requests, 4) if requests else 0.0,
                    "rps": round(_num(r["Requests/s"]), 2),
                    "p50_ms": _num(r["50%"]),
                    "p95_ms": _num(r["95%"]),
                    "p99_ms": _num(r["99%"]),
                    "avg_ms": round(_num(r["Average Response Time"]), 1),
                    "max_ms": round(_num(r["Max Response Time"]), 1),
                }
            )
    return rows


def write_summary(rows: list[dict], path: Path = PERF_DIR / "summary.csv") -> Path:
    """合并写入：同一 (scenario, users) 的旧行被替换。"""
    existing: list[dict] = []
    keys = {(r["scenario"], str(r["users"])) for r in rows}
    if path.exists():
        with path.open(encoding="utf-8") as f:
            existing = [r for r in csv.DictReader(f) if (r["scenario"], r["users"]) not in keys]
    merged = existing + rows
    merged.sort(key=lambda r: (str(r["scenario"]), int(r["users"]), str(r["name"])))
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=SUMMARY_FIELDS)
        w.writeheader()
        for r in merged:
            w.writerow({k: r.get(k, "") for k in SUMMARY_FIELDS})
    return path


def doc_rows(result: doc_throughput.DocThroughputResult) -> list[dict]:
    return [
        {
            "scenario": "doc",
            "users": result.users,
            "duration_s": result.wall_seconds,
            "name": f"short-note x{result.tasks} (tasks/min={result.tasks_per_min})",
            "requests": result.tasks,
            "failures": result.failed,
            "error_rate": round(result.failed / result.tasks, 4) if result.tasks else 0.0,
            "rps": round(result.completed / result.wall_seconds, 3) if result.wall_seconds else 0.0,
            "p50_ms": result.latency_ms_p50 or "",
            "p95_ms": "",
            "p99_ms": "",
            "avg_ms": "",
            "max_ms": result.latency_ms_max or "",
        }
    ]


def verify_mock_chain(password: str) -> dict:
    """mock 为默认模型时：fast / standard 短文本各一次 + 一个 short-note 文档任务。"""
    out: dict = {}
    with PlatformClient(username=perf_usernames(1)[0], password=password) as c:
        for mode in ("fast", "standard"):
            r = c.translate_stream("Machine translation has come a long way.", mode=mode, source_lang="auto")
            out[mode] = {
                "ok": r.ok,
                "translation": (r.final or {}).get("translation"),
                "events": [e for e, _ in r.events],
                "error": r.error,
            }
        task = c.create_doc_task(
            doc_throughput.SHORT_NOTE.read_text(encoding="utf-8"), title="mock-verify-short-note", fmt="txt"
        )
        final = c.wait_doc_task(task["id"], timeout=300, poll=1)
        segs = c.doc_segments(task["id"])
        out["doc"] = {
            "id": task["id"],
            "status": final["status"],
            "segments": [(s.get("seq"), (s.get("target") or "")[:40]) for s in segs if s.get("translatable", True)],
        }
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="平台性能测试（mock LLM）")
    parser.add_argument("command", nargs="?", default="run", choices=["run", "verify", "restore"])
    parser.add_argument("--users", type=int, nargs="+", default=[10, 50, 100])
    parser.add_argument("--duration", type=int, default=60, help="每档秒数")
    parser.add_argument("--spawn-rate", type=float, default=10.0)
    parser.add_argument("--scenarios", nargs="+", default=["rest", "stream", "doc"], choices=["rest", "stream", "doc"])
    parser.add_argument("--doc-tasks", type=int, default=20)
    parser.add_argument("--password", default=os.environ.get("PERF_PASSWORD", DEFAULT_PASSWORD))
    parser.add_argument("--no-start-mock", action="store_true", help="不自动启动 mock（需已在 9100 端口运行）")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)

    cfg = get_config()
    admin = PlatformClient()
    if args.command == "restore":
        print(json.dumps(restore_from_file(admin), ensure_ascii=False))
        return 0

    n_accounts = max([*args.users, -(-args.doc_tasks // doc_throughput.PER_USER_LIMIT), 1])
    created, existed = prepare_accounts(n_accounts, args.password)
    log.info("压测账号：新建 %d，已存在 %d", created, existed)

    rows: list[dict] = []
    switch = MockModelSwitch(admin)
    with mock_server(start=not args.no_start_mock):
        try:
            with switch:
                if args.command == "verify":
                    result = verify_mock_chain(args.password)
                    print(json.dumps(result, ensure_ascii=False, indent=2))
                else:
                    for users in args.users:
                        for scenario in [s for s in args.scenarios if s in SCENARIOS]:
                            stats = run_locust(
                                scenario, users, args.duration, args.spawn_rate, args.password, cfg.base_url
                            )
                            batch = parse_stats(stats, scenario, users, args.duration)
                            rows += batch
                            write_summary(batch)
                    if "doc" in args.scenarios:
                        res = doc_throughput.run_doc_throughput(
                            perf_usernames(n_accounts), args.password, tasks=args.doc_tasks
                        )
                        doc_throughput.save_result(res, PERF_DIR)
                        rows += doc_rows(res)
                        write_summary(doc_rows(res))
                        log.info("文档吞吐：%s", res.to_dict())
        finally:
            state = switch.restore()
            print("恢复后状态：", json.dumps(state, ensure_ascii=False))
    for r in rows:
        if r["name"] in ("Aggregated", "SSE translate TTFE", "SSE translate total") or r["scenario"] == "doc":
            print({k: r[k] for k in ("scenario", "users", "name", "requests", "error_rate", "rps", "p50_ms", "p95_ms")})
    return 0 if state else 1


if __name__ == "__main__":
    sys.exit(main())
