"""消融实验执行器（design D5）。

篇章级：5 篇 × D0–D6，D4 额外跑 run=2；改进验证 I1–I3 各跑 2 轮（I2 使用独立评审模型，I3 由执行器
模拟人工确认术语）；并发 2（线程池，每个线程一个 PlatformClient）；任务失败时调用继续接口
最多 2 次；结果写 `results/doc/{doc}__{group}__run{n}.json`，已存在则跳过（断点续跑）；最终仍失败的组合写
`{stem}.failed.json`（不阻止下次重跑）。

句子级：FLORES 100 句 × {fast, standard, standard_review}，调用短文本流式接口，
逐句追加到 `results/sentence/{mode}.jsonl`，
已成功的句子跳过（续跑）。平台限流为每用户每分钟 20 次翻译，执行器按最小间隔节流。

命令行：
  uv run --no-sync python -m eval.ablation.runner doc [--docs pods volumes] [--groups D0 D4] [--runs 1 2]
  uv run --no-sync python -m eval.ablation.runner sentence [--modes fast standard standard_review] [--limit 10]
  加 --dry-run 只打印计划
"""

from __future__ import annotations

import argparse
import json
import subprocess
import threading
import time
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from eval.client import PlatformClient, PlatformError
from eval.config import REPO_ROOT, RESULTS_DIR, get_config
from eval.dataset.flores import load_sentence_pairs
from eval.dataset.k8s import DOCS, K8S_DIR
from eval.dataset.terms import TERMS_PATH, load_terms
from eval.metrics.terminology import TermEntry

DOC_RESULTS = RESULTS_DIR / "doc"
SENTENCE_RESULTS = RESULTS_DIR / "sentence"
CONCURRENCY_LIMIT_CODE = "A0213"  # 用户并发任务数超限
RATE_LIMIT_CODE = "A0212"  # 翻译调用限流


@dataclass(frozen=True)
class GroupConfig:
    context_window: bool
    global_summary: bool
    term_extraction: bool
    review: bool
    strategy: str
    confirm: str = "none"  # none：不确认（自动采用）；oracle：执行器按金标术语表模拟人工确认
    review_model: bool = False  # 是否指定独立评审模型（config.toml [improve]）
    translation_memory: bool | None = None  # None：不提交该选项（D/I 系列沿用平台缺省）

    @property
    def options(self) -> dict[str, bool]:
        opts = {
            "contextWindow": self.context_window,
            "globalSummary": self.global_summary,
            "termExtraction": self.term_extraction,
            "review": self.review,
        }
        if self.translation_memory is not None:
            opts["translationMemory"] = self.translation_memory
        return opts


# design D5 配置表
GROUPS: dict[str, GroupConfig] = {
    "D0": GroupConfig(False, False, False, False, "parallel"),
    "D1": GroupConfig(True, False, False, False, "serial"),
    "D2": GroupConfig(True, True, False, False, "serial"),
    "D3": GroupConfig(True, True, True, False, "serial"),
    "D4": GroupConfig(True, True, True, True, "serial"),
    "D5": GroupConfig(True, True, True, True, "parallel"),
    "D6": GroupConfig(True, True, True, True, "hybrid"),
    # 改进验证（improve-agent-from-experiments design D6）
    "I1": GroupConfig(True, True, True, False, "hybrid"),
    "I2": GroupConfig(True, True, True, True, "hybrid", review_model=True),
    "I3": GroupConfig(True, True, True, False, "hybrid", confirm="oracle"),
}
REPEAT_GROUPS = {"D4": 2, "I1": 2, "I2": 2, "I3": 2}  # 组 → 轮数（其余组 1 轮）
DOC_IDS = tuple(d.doc_id for d in DOCS)


@dataclass(frozen=True)
class DocJob:
    doc: str
    group: str
    run: int

    @property
    def stem(self) -> str:
        return f"{self.doc}__{self.group}__run{self.run}"


def plan_doc_jobs(
    docs: Iterable[str] = DOC_IDS, groups: Iterable[str] = GROUPS, runs: Iterable[int] | None = None
) -> list[DocJob]:
    """生成（文档、组、轮次）组合；runs 为空时按 REPEAT_GROUPS（D4 与 I1–I3 两轮，其余一轮）。"""
    docs, groups = list(docs), list(groups)
    for g in groups:
        if g not in GROUPS:
            raise ValueError(f"未知配置组：{g}")
    jobs = []
    for run_no in sorted(set(runs) if runs else set(range(1, max(REPEAT_GROUPS.values()) + 1))):
        for doc in docs:
            for g in groups:
                if runs or run_no <= REPEAT_GROUPS.get(g, 1):
                    jobs.append(DocJob(doc, g, run_no))
    return jobs


def result_path(job: DocJob, root: Path = DOC_RESULTS) -> Path:
    return root / f"{job.stem}.json"


def pending_jobs(jobs: Iterable[DocJob], root: Path = DOC_RESULTS) -> list[DocJob]:
    return [j for j in jobs if not result_path(j, root).exists()]


def git_commit() -> str:
    try:
        sha = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=REPO_ROOT, capture_output=True, text=True, check=True
        ).stdout.strip()
        dirty = subprocess.run(
            ["git", "status", "--porcelain", "--untracked-files=no"], cwd=REPO_ROOT, capture_output=True, text=True
        ).stdout.strip()
        return sha + ("-dirty" if dirty else "")
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds")


def model_info(client: PlatformClient, model_config_id: int | None) -> dict:
    """记录译者模型（管理员接口）；查询失败不阻塞实验。"""
    try:
        for m in client.model_configs():
            if m.get("id") == model_config_id or (model_config_id is None and m.get("isDefault")):
                keys = ("id", "name", "provider", "modelName", "baseUrl", "params")
                return {k: m[k] for k in keys if k in m}
    except PlatformError as e:
        return {"id": model_config_id, "error": str(e)}
    return {"id": model_config_id}


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)


def oracle_decisions(terms: list[dict], gold: list[TermEntry]) -> tuple[list[dict], list[dict]]:
    """模拟"只纠正自己确定的词"的用户：源词在金标表中（不区分大小写）的待确认候选改为金标译法，其余原样接受。

    返回（确认请求的 terms，被纠正的条目 [{source, from, to}]）。
    """
    golden = {e.source.lower(): e.target for e in gold}
    decisions, corrected = [], []
    for t in terms:
        if t.get("status") != "PENDING":
            continue
        target = golden.get(t["source"].lower(), t["target"])
        if target != t["target"]:
            corrected.append({"source": t["source"], "from": t["target"], "to": target})
        decisions.append({"id": t.get("id"), "source": t["source"], "target": target, "status": "CONFIRMED"})
    return decisions, corrected


def _with_slot(fn: Callable[[], Any], sleep: Callable[[float], None], wait: float = 30.0, attempts: int = 40) -> Any:
    """并发数超限（A0213，可能来自其他压测或残留任务）时等待后重试。"""
    for i in range(attempts):
        try:
            return fn()
        except PlatformError as e:
            if e.code != CONCURRENCY_LIMIT_CODE or i == attempts - 1:
                raise
            sleep(wait)
    raise AssertionError("unreachable")


def run_doc_job(
    client: PlatformClient,
    job: DocJob,
    text: str,
    *,
    model_config_id: int | None,
    max_retries: int,
    commit: str,
    model: dict,
    root: Path = DOC_RESULTS,
    gold: list[TermEntry] | None = None,
    review_model_config_id: int | None = None,
    group: GroupConfig | None = None,
    sleep: Callable[[float], None] = time.sleep,
    log: Callable[[str], None] = print,
) -> dict:
    """执行一个组合并写结果文件；返回结果字典（失败时 status != COMPLETED）。

    group 为空时按 job.group 查 GROUPS；其他实验（如翻译记忆留一法）可直接传入自己的配置。
    """
    group = group or GROUPS[job.group]
    confirm = group.confirm == "oracle"
    review_id = review_model_config_id if group.review_model else None
    if group.review_model and review_id is None:
        raise ValueError(f"{job.group} 需要评审模型：请在 config.toml [improve] 中设置 review_model_config_id")
    config = {
        "title": f"eval-{job.stem}",
        "format": "md",
        "sourceLang": "en",
        "targetLang": "zh",
        "style": "faithful",
        "strategy": group.strategy,
        "options": group.options,
        "confirmTerms": confirm,
        "glossaryIds": [],
        "modelConfigId": model_config_id,
        "reviewModelConfigId": review_id,
    }
    started = now_iso()
    retries: list[dict] = []
    task = _with_slot(
        lambda: client.create_doc_task(
            text,
            title=config["title"],
            target_lang="zh",
            source_lang="en",
            fmt="md",
            style="faithful",
            strategy=group.strategy,
            options=group.options,
            confirm_terms=confirm,
            model_config_id=model_config_id,
            glossary_ids=[],
            review_model_config_id=review_id,
        ),
        sleep,
    )
    task_id = task["id"]
    log(f"[{job.stem}] 已创建任务 {task_id}")
    error: str | None = None
    confirmation: dict | None = None
    while True:
        try:
            task = client.wait_doc_task(task_id, until={"AWAITING_CONFIRM"} if confirm else None)
        except TimeoutError as e:
            error = str(e)
            break
        if task["status"] == "AWAITING_CONFIRM":
            decisions, corrected = oracle_decisions(client.doc_terms(task_id), gold or [])
            client.confirm_doc_terms(task_id, decisions)
            confirmation = {"at": now_iso(), "terms": decisions, "corrected": corrected}
            log(f"[{job.stem}] 模拟确认 {len(decisions)} 条术语，纠正 {len(corrected)} 条")
            continue
        if task["status"] == "COMPLETED":
            break
        if task["status"] == "FAILED" and task.get("retryable") and len(retries) < max_retries:
            retries.append(
                {"at": now_iso(), "errorCode": task.get("errorCode"), "errorMessage": task.get("errorMessage")}
            )
            log(f"[{job.stem}] 任务失败（{task.get('errorCode')}），第 {len(retries)} 次继续")
            _with_slot(lambda: client.retry_doc_task(task_id), sleep)
            continue
        error = f"{task['status']}: [{task.get('errorCode')}] {task.get('errorMessage')}"
        break
    segments = client.doc_segments(task_id)
    traces = client.doc_traces(task_id)
    try:
        terms = client.doc_terms(task_id)
    except PlatformError:
        terms = []
    result = {
        "doc": job.doc,
        "group": job.group,
        "run": job.run,
        "config": config,
        "model": model,
        "gitCommit": commit,
        "startedAt": started,
        "finishedAt": now_iso(),
        "taskId": task_id,
        "status": task["status"],
        "error": error,
        "retries": len(retries),
        "retryHistory": retries,
        "confirmation": confirmation,
        "usage": {
            "promptTokens": task.get("promptTokens"),
            "completionTokens": task.get("completionTokens"),
            "latencyMs": task.get("latencyMs"),
        },
        "task": task,
        "segments": segments,
        "traces": traces,
        "terms": terms,
    }
    failed = root / f"{job.stem}.failed.json"
    if task["status"] == "COMPLETED" and error is None:
        _write_json(result_path(job, root), result)
        failed.unlink(missing_ok=True)
        log(f"[{job.stem}] 完成（重试 {len(retries)} 次）")
    else:
        _write_json(failed, result)
        log(f"[{job.stem}] 最终失败：{error}")
    return result


def run_doc_jobs(
    jobs: list[DocJob],
    *,
    client_factory: Callable[[], PlatformClient] = PlatformClient,
    concurrency: int | None = None,
    model_config_id: int | None = None,
    max_retries: int | None = None,
    root: Path = DOC_RESULTS,
    k8s_dir: Path = K8S_DIR,
    terms_path: Path = TERMS_PATH,
    sleep: Callable[[float], None] = time.sleep,
    log: Callable[[str], None] = print,
) -> list[dict]:
    cfg = get_config()
    concurrency = concurrency or cfg.ablation_concurrency
    model_config_id = model_config_id if model_config_id is not None else cfg.translator_model_id
    max_retries = cfg.ablation_max_retries if max_retries is None else max_retries
    todo = pending_jobs(jobs, root)
    log(f"共 {len(jobs)} 个组合，待执行 {len(todo)} 个，并发 {concurrency}")
    if not todo:
        return []
    commit = git_commit()
    local = threading.local()
    clients: list[PlatformClient] = []
    lock = threading.Lock()

    def client() -> PlatformClient:
        if not hasattr(local, "client"):
            local.client = client_factory()
            with lock:
                clients.append(local.client)
        return local.client

    model = model_info(client(), model_config_id)
    texts = {doc: (k8s_dir / f"{doc}.en.md").read_text(encoding="utf-8") for doc in {j.doc for j in todo}}
    gold = load_terms(terms_path) if any(GROUPS[j.group].confirm == "oracle" for j in todo) else {}

    def work(job: DocJob) -> dict:
        try:
            return run_doc_job(
                client(),
                job,
                texts[job.doc],
                model_config_id=model_config_id,
                max_retries=max_retries,
                commit=commit,
                model=model,
                root=root,
                gold=gold.get(job.doc, []),
                review_model_config_id=cfg.improve_review_model_id,
                sleep=sleep,
                log=log,
            )
        except Exception as e:  # noqa: BLE001 单个组合出错不影响其余组合
            log(f"[{job.stem}] 异常：{e!r}")
            return {"doc": job.doc, "group": job.group, "run": job.run, "status": "ERROR", "error": repr(e)}

    results = []
    try:
        with ThreadPoolExecutor(max_workers=concurrency) as pool:
            futures = [pool.submit(work, j) for j in todo]
            for f in as_completed(futures):
                results.append(f.result())
    finally:
        for c in clients:
            c.close()
    return results


# ---------------------------------------------------------------- 句子级

MODES = ("fast", "standard")
# 句子级变体 → （接口 mode，是否指定独立评审模型）；standard_review 为改进后的标准路径（新评审规则 + 独立评审模型）
SENTENCE_VARIANTS: dict[str, tuple[str, bool]] = {
    "fast": ("fast", False),
    "standard": ("standard", False),
    "standard_review": ("standard", True),
}


class RateLimiter:
    """保证相邻两次调用的开始时间至少间隔 interval 秒（线程安全）。"""

    def __init__(self, interval: float, clock: Callable[[], float] = time.monotonic, sleep=time.sleep):
        self.interval = interval
        self._clock, self._sleep = clock, sleep
        self._next = 0.0
        self._lock = threading.Lock()

    def wait(self) -> None:
        with self._lock:
            now = self._clock()
            start = max(now, self._next)
            self._next = start + self.interval
        if start > now:
            self._sleep(start - now)


def sentence_path(mode: str, root: Path = SENTENCE_RESULTS) -> Path:
    return root / f"{mode}.jsonl"


def done_sentence_ids(path: Path) -> set[int]:
    if not path.exists():
        return set()
    done = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rec = json.loads(line)
            if rec.get("ok"):
                done.add(rec["id"])
    return done


def severity_counts(issues: list[dict] | None) -> dict[str, int]:
    counts = {"critical": 0, "major": 0, "minor": 0}
    for i in issues or []:
        if i.get("severity") in counts:
            counts[i["severity"]] += 1
    return counts


def summarize_stream(events: list[tuple[str, dict]]) -> dict:
    """从事件流中提取评审信息：refine 节点完成次数即修正轮次；首轮评审的问题按严重度计数。"""
    reviews = [d for e, d in events if e == "review"]
    rounds = sum(1 for e, d in events if e == "node" and d.get("node") == "refine" and d.get("status") == "completed")
    scores = [r.get("score") for r in reviews]
    return {
        "reviewRounds": rounds,
        "reviewScores": scores,
        "firstScore": scores[0] if scores else None,
        "finalScore": scores[-1] if scores else None,
        "firstIssues": severity_counts(reviews[0].get("issues")) if reviews else None,
        "reviewer": reviews[0].get("reviewer") if reviews else None,
        "reviewerFallback": reviews[0].get("fallback") if reviews else None,
    }


def translate_sentence(
    client: PlatformClient,
    row: dict,
    mode: str,
    *,
    model_config_id: int | None,
    limiter: RateLimiter,
    commit: str,
    review_model_config_id: int | None = None,
    attempts: int = 4,
    sleep: Callable[[float], None] = time.sleep,
) -> dict:
    """mode 为句子级变体名（见 SENTENCE_VARIANTS）。"""
    api_mode, with_reviewer = SENTENCE_VARIANTS[mode]
    review_id = review_model_config_id if with_reviewer else None
    rec: dict[str, Any] = {
        "id": row["id"],
        "mode": mode,
        "source": row["source"],
        "reference": row["reference"],
        "modelConfigId": model_config_id,
        "reviewModelConfigId": review_id,
        "gitCommit": commit,
        "startedAt": now_iso(),
    }
    last_error = None
    for i in range(attempts):
        limiter.wait()
        try:
            res = client.translate_stream(
                row["source"],
                target_lang="zh",
                source_lang="en",
                mode=api_mode,
                model_config_id=model_config_id,
                review_model_config_id=review_id,
            )
        except PlatformError as e:
            last_error = str(e)
            sleep(30.0 if e.code == RATE_LIMIT_CODE else 5.0 * (i + 1))
            continue
        except Exception as e:  # noqa: BLE001 网络抖动
            last_error = repr(e)
            sleep(5.0 * (i + 1))
            continue
        if res.ok:
            final = res.final or {}
            rec.update(
                ok=True,
                translation=final.get("translation", ""),
                path=final.get("path"),
                usage=final.get("usage"),
                latencyMs=final.get("latencyMs"),
                recordId=final.get("recordId"),
                ttfeMs=res.ttfe_ms,
                totalMs=res.total_ms,
                attempts=i + 1,
                **summarize_stream(res.events),
            )
            return rec
        last_error = json.dumps(res.error, ensure_ascii=False)
        sleep(5.0 * (i + 1))
    rec.update(ok=False, error=last_error, attempts=attempts)
    return rec


def run_sentences(
    modes: Iterable[str] = MODES,
    *,
    limit: int | None = None,
    client_factory: Callable[[], PlatformClient] = PlatformClient,
    concurrency: int = 2,
    interval: float = 3.2,
    model_config_id: int | None = None,
    root: Path = SENTENCE_RESULTS,
    rows: list[dict] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    log: Callable[[str], None] = print,
) -> None:
    cfg = get_config()
    model_config_id = model_config_id if model_config_id is not None else cfg.translator_model_id
    modes = list(modes)
    if any(SENTENCE_VARIANTS[m][1] for m in modes) and cfg.improve_review_model_id is None:
        raise ValueError("standard_review 需要评审模型：请在 config.toml [improve] 中设置 review_model_config_id")
    rows = rows if rows is not None else load_sentence_pairs()
    if limit:
        rows = rows[:limit]
    commit = git_commit()
    limiter = RateLimiter(interval, sleep=sleep)
    local = threading.local()
    clients: list[PlatformClient] = []
    lock = threading.Lock()

    def client() -> PlatformClient:
        if not hasattr(local, "client"):
            local.client = client_factory()
            with lock:
                clients.append(local.client)
        return local.client

    try:
        for mode in modes:
            path = sentence_path(mode, root)
            path.parent.mkdir(parents=True, exist_ok=True)
            done = done_sentence_ids(path)
            todo = [r for r in rows if r["id"] not in done]
            log(f"[{mode}] 共 {len(rows)} 句，待执行 {len(todo)} 句")

            def work(row: dict, mode: str = mode, path: Path = path) -> dict:
                rec = translate_sentence(
                    client(),
                    row,
                    mode,
                    model_config_id=model_config_id,
                    limiter=limiter,
                    commit=commit,
                    review_model_config_id=cfg.improve_review_model_id,
                    sleep=sleep,
                )
                with lock, path.open("a", encoding="utf-8") as f:
                    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                return rec

            with ThreadPoolExecutor(max_workers=concurrency) as pool:
                for n, f in enumerate(as_completed([pool.submit(work, r) for r in todo]), 1):
                    rec = f.result()
                    if not rec.get("ok") or n % 10 == 0:
                        log(f"[{mode}] {n}/{len(todo)} id={rec['id']} ok={rec.get('ok')}")
    finally:
        for c in clients:
            c.close()


# ---------------------------------------------------------------- 命令行


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="消融实验执行器")
    sub = parser.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("doc", help="篇章级消融实验")
    d.add_argument("--docs", nargs="+", default=list(DOC_IDS), choices=DOC_IDS)
    d.add_argument("--groups", nargs="+", default=list(GROUPS), choices=list(GROUPS))
    d.add_argument("--runs", nargs="+", type=int, help="指定轮次（缺省：D4 与 I1–I3 两轮，其余一轮）")
    d.add_argument("--concurrency", type=int)
    d.add_argument("--dry-run", action="store_true")
    s = sub.add_parser("sentence", help="句子级 fast / standard 对比")
    s.add_argument("--modes", nargs="+", default=list(MODES), choices=list(SENTENCE_VARIANTS))
    s.add_argument("--limit", type=int)
    s.add_argument("--concurrency", type=int, default=2)
    s.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    if args.cmd == "doc":
        jobs = plan_doc_jobs(args.docs, args.groups, args.runs)
        if args.dry_run:
            todo = set(pending_jobs(jobs))
            for j in jobs:
                print(f"{j.stem:<28} {'待执行' if j in todo else '已完成'}  {GROUPS[j.group]}")
            return
        results = run_doc_jobs(jobs, concurrency=args.concurrency)
        failed = [r for r in results if r.get("status") != "COMPLETED" or r.get("error")]
        print(f"本次执行 {len(results)} 个组合，失败 {len(failed)} 个")
        for r in failed:
            print(f"  {r['doc']}__{r['group']}__run{r['run']}: {r.get('error')}")
    else:
        if args.dry_run:
            rows = load_sentence_pairs()[: args.limit] if args.limit else load_sentence_pairs()
            for m in args.modes:
                done = done_sentence_ids(sentence_path(m))
                print(f"[{m}] 待执行 {sum(r['id'] not in done for r in rows)} / {len(rows)} 句")
            return
        run_sentences(args.modes, limit=args.limit, concurrency=args.concurrency)


if __name__ == "__main__":
    main()
