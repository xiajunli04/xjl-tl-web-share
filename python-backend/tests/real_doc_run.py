"""4.4：用真实测试模型对 k8s-guide.md 跑一次 serial + 术语确认的完整流程（经由 Redis 命令驱动）。

不是 pytest 用例（会调用真实 LLM、耗时数分钟），手动执行：

    uv run --no-sync python -m tests.real_doc_run [--model-config-id 2] [--port 8002]

步骤：
1. 准备独立的数据库 xjl_tl_docrun（主库还没有 ai.doc_chunk_result）：建 biz.model_config / 术语库表 /
   ai.doc_chunk_result，从主库复制模型配置（密文原样复制，使用 .env 中的 MODEL_KEY_SECRET 解密）
2. 以子进程启动 AI 服务（python -m app --port 8002），环境变量把库指向 xjl_tl_docrun、
   Redis 指向 db 14 与独立流名前缀
3. 扮演 Spring：XADD start → 收到 awaiting_confirm 后自动 XADD resume（确认全部候选）→ 等待 completed；
   遇到可重试的 failed 自动 XADD retry（最多 3 次）
4. 事件按线上格式（字段全为字符串）保存到 tests/fixtures/real-doc-run.events.jsonl，
   打印关键统计并校验拼接后的 Markdown 结构
"""

import argparse
import asyncio
import json
import os
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path

import psycopg
import redis.asyncio as aioredis

from app.core.config import get_settings
from tests.doc_fakes import fixture_text

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(__file__).parent / "fixtures" / "real-doc-run.events.jsonl"
RUN_DB = "xjl_tl_docrun"
REDIS_DB = 14
TIMEOUT_SECONDS = 30 * 60

DDL = """
CREATE SCHEMA IF NOT EXISTS biz;
DROP TABLE IF EXISTS biz.glossary_term;
DROP TABLE IF EXISTS biz.glossary;
DROP TABLE IF EXISTS biz.model_config;
CREATE TABLE biz.model_config (
  id bigint PRIMARY KEY, name varchar(64) NOT NULL, provider varchar(32) NOT NULL, base_url varchar(255) NOT NULL,
  model_name varchar(128) NOT NULL, api_key_cipher text NOT NULL, api_key_mask varchar(32) NOT NULL,
  params jsonb NOT NULL DEFAULT '{}'::jsonb, is_default boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true, deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE biz.glossary (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name varchar(64) NOT NULL, source_lang varchar(8) NOT NULL,
  target_lang varchar(8) NOT NULL, deleted boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE biz.glossary_term (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, glossary_id bigint NOT NULL REFERENCES biz.glossary(id),
  source_term varchar(200) NOT NULL, target_term varchar(200) NOT NULL, case_sensitive boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT USAGE ON SCHEMA biz TO tl_ai;
GRANT SELECT ON biz.model_config, biz.glossary, biz.glossary_term TO tl_ai;
CREATE SCHEMA IF NOT EXISTS ai;
GRANT USAGE, CREATE ON SCHEMA ai TO tl_ai;
DROP TABLE IF EXISTS ai.doc_chunk_result;
CREATE TABLE ai.doc_chunk_result (
  task_id bigint NOT NULL, chunk_index int NOT NULL, result jsonb NOT NULL, usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (task_id, chunk_index)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON ai.doc_chunk_result TO tl_ai;
"""


def prepare_database(model_config_id: int) -> None:
    s = get_settings()
    su = {
        "host": s.postgres_host,
        "port": s.postgres_port,
        "user": os.environ.get("POSTGRES_SUPERUSER", "postgres"),
        "password": os.environ.get("POSTGRES_SUPERUSER_PASSWORD", "postgres"),
        "autocommit": True,
    }
    with psycopg.connect(dbname="postgres", **su) as c:
        if not c.execute("select 1 from pg_database where datname = %s", (RUN_DB,)).fetchone():
            c.execute(f'CREATE DATABASE "{RUN_DB}"')
    with psycopg.connect(dbname=s.postgres_db, **su) as src:
        row = src.execute(
            "select id, name, provider, base_url, model_name, api_key_cipher, api_key_mask, params::text "
            "from biz.model_config where id = %s and enabled and not deleted",
            (model_config_id,),
        ).fetchone()
    if row is None:
        raise SystemExit(f"主库中没有可用的模型配置 id={model_config_id}")
    with psycopg.connect(dbname=RUN_DB, **su) as c:
        c.execute(DDL)
        c.execute(
            "insert into biz.model_config (id, name, provider, base_url, model_name, api_key_cipher, api_key_mask, "
            "params, is_default) values (%s,%s,%s,%s,%s,%s,%s,%s::jsonb,true)",
            row,
        )
    print(f"[准备] 数据库 {RUN_DB} 就绪，模型配置 id={row[0]} {row[1]}（{row[4]}）")


def start_service(port: int, prefix: str) -> subprocess.Popen:
    env = dict(os.environ)
    env.update(
        {
            "POSTGRES_DB": RUN_DB,
            "REDIS_DB": str(REDIS_DB),
            "DOC_STREAM_PREFIX": prefix,
            "DOC_WORKER_ENABLED": "true",
            "DOC_CONSUMER_NAME": "real-run-worker",
            "PYTHONIOENCODING": "utf-8",
        }
    )
    log = open(ROOT / ".venv" / "real-doc-run.service.log", "w", encoding="utf-8")  # noqa: SIM115
    return subprocess.Popen(
        [sys.executable, "-m", "app", "--port", str(port)], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT
    )


async def drive(prefix: str, model_config_id: int) -> list[dict[str, str]]:
    s = get_settings()
    r = aioredis.Redis(host=s.redis_host, port=s.redis_port, db=REDIS_DB, decode_responses=True)
    tasks, events_stream = f"{prefix}doc-tasks", f"{prefix}doc-events"
    # 等待 worker 创建消费组（就绪）
    for _ in range(120):
        try:
            if any(g["name"] == "ai-worker" for g in await r.xinfo_groups(tasks)):
                break
        except Exception:  # noqa: BLE001 - 流尚未创建
            pass
        await asyncio.sleep(1)
    else:
        raise SystemExit("AI 服务未就绪（消费组未创建）")
    print("[驱动] worker 已就绪")

    task_id = int(time.time())
    payload = {
        "userId": 1,
        "title": "Kubernetes Deployment Guide",
        "format": "md",
        "text": fixture_text("k8s-guide.md"),
        "sourceLang": "auto",
        "targetLang": "zh",
        "style": "faithful",
        "domain": None,
        "glossaryIds": [],
        "modelConfigId": model_config_id,
        "strategy": "serial",
        "confirmTerms": True,
        "options": {"contextWindow": True, "globalSummary": True, "termExtraction": True, "review": True},
    }
    payload_json = json.dumps(payload, ensure_ascii=False)
    await r.xadd(
        tasks, {"cmd": "start", "taskId": str(task_id), "traceId": f"doc-{task_id}-a", "payload": payload_json}
    )
    print(f"[驱动] XADD start taskId={task_id}")

    seen: list[dict[str, str]] = []
    last_id = "0-0"
    retries = 0
    start = time.monotonic()
    while time.monotonic() - start < TIMEOUT_SECONDS:
        resp = await r.xread({events_stream: last_id}, count=100, block=2000)
        for _, messages in resp or []:
            for msg_id, fields in messages:
                last_id = msg_id
                if fields.get("taskId") != str(task_id):
                    continue
                seen.append(fields)
                data = json.loads(fields["data"])
                t = fields["type"]
                elapsed = time.monotonic() - start
                brief = data.get("phase") or data.get("summary") or data.get("chunk", "")
                print(f"  +{elapsed:6.1f}s #{fields['eventSeq']:>3} {t:<16} {str(brief)[:90]}")
                if t == "awaiting_confirm":
                    terms = [{"source": c["source"], "target": c["target"]} for c in data["candidates"]]
                    await asyncio.sleep(1)
                    await r.xadd(
                        tasks,
                        {
                            "cmd": "resume",
                            "taskId": str(task_id),
                            "traceId": f"doc-{task_id}-b",
                            "data": json.dumps({"terms": terms}, ensure_ascii=False),
                        },
                    )
                    print(f"[驱动] XADD resume，确认 {len(terms)} 条术语")
                elif t == "failed":
                    if data.get("retryable") and retries < 3:
                        retries += 1
                        await asyncio.sleep(3)
                        await r.xadd(
                            tasks,
                            {
                                "cmd": "retry",
                                "taskId": str(task_id),
                                "traceId": f"doc-{task_id}-r{retries}",
                                "payload": payload_json,
                            },
                        )
                        print(f"[驱动] 任务失败（{data['code']}），XADD retry 第 {retries} 次")
                    else:
                        await r.aclose()
                        return seen
                elif t == "completed":
                    await r.aclose()
                    return seen
    await r.aclose()
    raise SystemExit("等待超时")


def assemble(events: list[dict[str, str]]) -> tuple[str, list[dict]]:
    segments: list[dict] = []
    targets: dict[int, str] = {}
    for e in events:
        data = json.loads(e["data"])
        if e["type"] == "parsed":
            segments = data["segments"]
        elif e["type"] == "chunk_done":
            for s in data["segments"]:
                targets[s["seq"]] = s["target"]
        elif e["type"] == "consistency":
            for s in data["segments"]:
                targets[s["seq"]] = s["target"]
    out = "".join(s["prefix"] + targets.get(s["seq"], s["source"]) + s["suffix"] for s in segments)
    return out, segments


def check_structure(source: str, translated: str) -> list[str]:
    """拼接后的译文 Markdown 与原文结构一致：标题层级、列表标记、表格分隔、代码块、HTML 块。"""
    problems = []

    def headings(t):
        return [m.group(1) for m in re.finditer(r"^(#{1,6}) ", t, re.M)]

    def list_markers(t):
        return re.findall(r"^( *(?:[-*+]|\d+\.) )", t, re.M)

    def table_lines(t):
        return [line.count("|") for line in t.splitlines() if line.startswith("|")]

    fence = re.compile(r"```.*?```", re.S)
    if headings(source) != headings(translated):
        problems.append("标题层级不一致")
    if list_markers(source) != list_markers(translated):
        problems.append("列表标记不一致")
    if table_lines(source) != table_lines(translated):
        problems.append("表格分隔符数量不一致")
    if fence.findall(source) != fence.findall(translated):
        problems.append("代码块内容被改动")
    for tag in re.findall(r"^<div.*</div>$", source, re.M):
        if tag not in translated:
            problems.append("HTML 块被改动")
    for code in re.findall(r"`[^`\n]+`", source):
        if code not in translated:
            problems.append(f"行内代码丢失: {code}")
    for url in ("https://kubernetes.io/docs/reference/kubectl/", "https://dashboard.example.com", "{name}", "%d"):
        if url not in translated:
            problems.append(f"受保护内容丢失: {url}")
    if ("\r\n" in source) and not translated.count("\r\n"):
        problems.append("CRLF 段落的块间换行丢失")
    return problems


def report(events: list[dict[str, str]]) -> None:
    by_type: dict[str, list[dict]] = {}
    for e in events:
        by_type.setdefault(e["type"], []).append(json.loads(e["data"]))
    source = fixture_text("k8s-guide.md")
    translated, segments = assemble(events)
    print("\n========== 统计 ==========")
    print(f"事件数：{len(events)}（eventSeq {events[0]['eventSeq']}–{events[-1]['eventSeq']}）")
    parsed = by_type["parsed"][0]
    print(f"段落：{len(parsed['segments'])}，分块：{len(parsed['chunks'])}，识别语种：{parsed['detectedLang']}")
    analysis = by_type.get("analysis", [{}])[0]
    candidates = analysis.get("candidates", [])
    print(f"领域/文体：{analysis.get('domain')} / {analysis.get('genre')}；候选术语 {len(candidates)} 条")
    for c in candidates:
        print(f"  {c['source']} → {c['target']}（{c['origin']}，{c['frequency']} 次）")
    print(f"摘要：{analysis.get('summary')}")
    for d in by_type.get("chunk_done", []):
        scores = {s["reviewScore"] for s in d["segments"]}
        print(
            f"  块 {d['chunk']}：{len(d['segments'])} 段，评审 {scores}，耗时 {d['latencyMs']} ms，"
            f"用量 {d['usage']}，cached={d['cached']}"
        )
    if "consistency" in by_type:
        c = by_type["consistency"][-1]
        print(f"一致性问题：{len(c['issues'])}，修正段落：{len(c['segments'])}")
        for i in c["issues"]:
            print(f"  {i['term']} → {i['chosen']}，变体 {i['variants']}")
            print(f"    修正 {i['fixedSegs']}，未解决 {i['unresolvedSegs']}")
    if "completed" in by_type:
        done = by_type["completed"][-1]
        print(f"完成：耗时 {done['latencyMs']} ms，用量 {done['usage']}，统计 {done['stats']}")
    if "failed" in by_type:
        print(f"失败事件：{by_type['failed']}")
    problems = check_structure(source, translated)
    print("结构校验：" + ("通过" if not problems else "；".join(problems)))
    print("\n---------- 译文前 600 字 ----------")
    print(translated[:600])


async def cleanup_redis(prefix: str) -> None:
    s = get_settings()
    r = aioredis.Redis(host=s.redis_host, port=s.redis_port, db=REDIS_DB, decode_responses=True)
    keys = [k async for k in r.scan_iter(match=f"{prefix}*")]
    if keys:
        await r.delete(*keys)
    await r.aclose()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-config-id", type=int, default=2)
    parser.add_argument("--port", type=int, default=8002)
    args = parser.parse_args()
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    prepare_database(args.model_config_id)
    prefix = f"tlrun:{uuid.uuid4().hex[:8]}:"
    proc = start_service(args.port, prefix)
    try:
        events = asyncio.run(drive(prefix, args.model_config_id))
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            proc.kill()
        asyncio.run(cleanup_redis(prefix))
    OUT.write_text("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in events), encoding="utf-8", newline="\n")
    print(f"\n事件已保存到 {OUT}")
    report(events)


if __name__ == "__main__":
    main()
