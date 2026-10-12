"""E1 翻译记忆留一法：用专用评测用户，模拟"其余 4 篇已经后编辑过"的历史译文，检验翻译记忆对第 5 篇的作用。

步骤：
1. 来源：评测用户按 I3 配置（模拟人工确认）把 5 篇各翻译一次，记录任务 id（`results/context/tm_sources.json`）
   ——I3 结果属于管理员账号，翻译记忆按用户隔离，因此由评测用户重新生成同配置的译文
2. 对每篇 d：清空评测用户的翻译记忆 → 把其余 4 篇来源任务的译文写入记忆 → 按 I1 配置分别以
   translationMemory 关（TM0）与开（TM1）翻译 d
3. 结果：`results/context/doc/{doc}__TM0__run1.json` / `__TM1__run1.json`，已存在则跳过

命令行：uv run --no-sync python -m eval.context.tm_loo [--docs pods volumes]
"""

from __future__ import annotations

import argparse
import json
from collections.abc import Callable
from pathlib import Path

from eval.ablation.runner import GROUPS, DocJob, GroupConfig, git_commit, model_info, result_path, run_doc_job
from eval.client import PlatformClient, PlatformError
from eval.config import RESULTS_DIR, get_config
from eval.dataset.k8s import DOCS, K8S_DIR
from eval.dataset.terms import TERMS_PATH, load_terms

CONTEXT_RESULTS = RESULTS_DIR / "context"
TM_DOC_RESULTS = CONTEXT_RESULTS / "doc"
SOURCES_PATH = CONTEXT_RESULTS / "tm_sources.json"
DOC_IDS = tuple(d.doc_id for d in DOCS)

SOURCE_GROUP = GROUPS["I3"]
TM_GROUPS: dict[str, GroupConfig] = {
    "TM0": GroupConfig(True, True, True, False, "hybrid", translation_memory=False),
    "TM1": GroupConfig(True, True, True, False, "hybrid", translation_memory=True),
}


def eval_client() -> PlatformClient:
    """专用评测用户的客户端；账号不存在时先注册。"""
    cfg = get_config()
    client = PlatformClient(username=cfg.context_username, password=cfg.context_password)
    try:
        client.login()
    except PlatformError:
        client.register(cfg.context_username, cfg.context_password, "翻译记忆评测")
        client.login()
    return client


def memory_docs(held_out: str, docs: tuple[str, ...] = DOC_IDS) -> list[str]:
    return [d for d in docs if d != held_out]


def ensure_sources(
    client: PlatformClient,
    *,
    texts: dict[str, str],
    gold: dict,
    model_id: int | None,
    commit: str,
    model: dict,
    path: Path = SOURCES_PATH,
    log: Callable[[str], None] = print,
) -> dict[str, int]:
    sources: dict[str, int] = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    for doc in DOC_IDS:
        if doc in sources:
            continue
        job = DocJob(doc, "SRC", 1)
        result = run_doc_job(
            client,
            job,
            texts[doc],
            model_config_id=model_id,
            max_retries=2,
            commit=commit,
            model=model,
            root=CONTEXT_RESULTS / "sources",
            gold=gold.get(doc, []),
            group=SOURCE_GROUP,
            log=log,
        )
        if result["status"] != "COMPLETED":
            raise RuntimeError(f"来源任务 {doc} 失败：{result.get('error')}")
        sources[doc] = result["taskId"]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(sources, indent=1), encoding="utf-8")
    return sources


def load_memory(
    client: PlatformClient, held_out: str, sources: dict[str, int], log: Callable[[str], None] = print
) -> dict:
    removed = client.tm_clear()
    written = {doc: client.doc_task_memory(sources[doc]) for doc in memory_docs(held_out)}
    log(f"[{held_out}] 清空记忆 {removed} 条，写入 {written}")
    return {"removed": removed, "written": written}


def run(docs: list[str] | None = None, *, log: Callable[[str], None] = print) -> list[dict]:
    cfg = get_config()
    docs = docs or list(DOC_IDS)
    texts = {d: (K8S_DIR / f"{d}.en.md").read_text(encoding="utf-8") for d in DOC_IDS}
    gold = load_terms(TERMS_PATH)
    commit = git_commit()
    results = []
    with eval_client() as client:
        model = model_info(client, cfg.translator_model_id)
        sources = ensure_sources(
            client, texts=texts, gold=gold, model_id=cfg.translator_model_id, commit=commit, model=model, log=log
        )
        for doc in docs:
            jobs = [DocJob(doc, g, 1) for g in TM_GROUPS]
            if all(result_path(j, TM_DOC_RESULTS).exists() for j in jobs):
                continue
            memory = load_memory(client, doc, sources, log)
            for job in jobs:
                if result_path(job, TM_DOC_RESULTS).exists():
                    continue
                result = run_doc_job(
                    client,
                    job,
                    texts[doc],
                    model_config_id=cfg.translator_model_id,
                    max_retries=2,
                    commit=commit,
                    model=model,
                    root=TM_DOC_RESULTS,
                    group=TM_GROUPS[job.group],
                    log=log,
                )
                result["memory"] = {**memory, "sources": {d: sources[d] for d in memory_docs(doc)}}
                if result["status"] == "COMPLETED":
                    result_path(job, TM_DOC_RESULTS).write_text(
                        json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8"
                    )
                results.append(result)
    return results


def tm_hit_stats(segments: list[dict]) -> dict:
    """段落级命中统计：命中段数、每块平均命中数（按 chunkIndex 分组）。"""
    hits = [s for s in segments if s.get("translatable") and s.get("tmHits")]
    chunks = {s.get("chunkIndex") for s in segments if s.get("translatable")}
    return {
        "hit_segments": len(hits),
        "hits_per_chunk": len(hits) / len(chunks) if chunks else None,
        "mean_fuzzy": sum(s["tmHits"][0].get("fuzzy") or 0 for s in hits) / len(hits) if hits else None,
    }


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="E1 翻译记忆留一法")
    parser.add_argument("--docs", nargs="+", choices=DOC_IDS)
    args = parser.parse_args(argv)
    results = run(args.docs)
    failed = [r for r in results if r.get("status") != "COMPLETED"]
    print(f"本次执行 {len(results)} 个组合，失败 {len(failed)} 个")


if __name__ == "__main__":
    main()
