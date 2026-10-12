"""3.6 / 4.1 / 4.2：worker 经由真实 Redis（独立 db 与流名前缀）驱动篇章图，检查点使用测试库的 AsyncPostgresSaver。

覆盖：完整流程与契约样例的事件结构一致、排队、取消（含在途 LLM 调用被中止）、术语确认中断期间释放并发槽、
重复命令幂等、取消并清理、进程重启后续译（已完成的块以 cached 上报且不再调用 LLM）。
"""

import asyncio
import json
import random
import uuid

import pytest
import redis.asyncio as aioredis
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

from app.core.config import get_settings
from app.core.db import Database
from app.doc.graph import compile_doc_graph, thread_config
from app.doc.parser import join_segments
from app.doc.store import PgChunkStore, make_checkpoint_pool
from app.lang.detector import LanguageDetector
from app.worker.doc_worker import DocWorker
from tests.doc_fakes import DocFakeLLM, FakeGlossaryRepo, doc_payload, fixture_text, load_sample_events
from tests.fakes import resolved

REDIS_TEST_DB = 14
WAIT_SECONDS = 20.0


@pytest.fixture
async def infra():
    """每个测试一套独立的流名前缀；共享测试库的检查点表与分块缓存（任务 id 随机）。"""
    prefix = f"tlt:{uuid.uuid4().hex[:8]}:"
    base = get_settings()
    settings = base.model_copy(
        update={
            "doc_stream_prefix": prefix,
            "redis_db": REDIS_TEST_DB,
            "doc_read_block_ms": 100,
            "doc_worker_concurrency": 2,
        }
    )
    redis = aioredis.Redis(host=base.redis_host, port=base.redis_port, db=REDIS_TEST_DB, decode_responses=True)
    db = Database(settings)
    await db.open()
    pool = make_checkpoint_pool(settings)
    await pool.open()
    saver = AsyncPostgresSaver(conn=pool)
    env = Infra(settings, redis, db, pool, saver)
    try:
        yield env
    finally:
        await env.stop_all()
        keys = [k async for k in redis.scan_iter(match=f"{prefix}*")]
        if keys:
            await redis.delete(*keys)
        await redis.aclose()
        await pool.close()
        await db.close()


class Infra:
    def __init__(self, settings, redis, db, pool, saver):
        self.settings = settings
        self.redis = redis
        self.db = db
        self.pool = pool
        self.saver = saver
        self.store = PgChunkStore(db)
        self.workers: list[DocWorker] = []

    async def worker(self, fake: DocFakeLLM, *, consumer: str = "test-worker", **overrides) -> DocWorker:
        settings = self.settings.model_copy(update=overrides)

        async def resolver(_model_config_id):
            return resolved(fake)

        w = DocWorker(
            settings=settings,
            redis=self.redis,
            graph=compile_doc_graph(self.saver),
            checkpointer=self.saver,
            store=self.store,
            registry=None,
            detector=LanguageDetector(settings),
            glossary_repo=FakeGlossaryRepo(),
            consumer=consumer,
            llm_resolver=resolver,
        )
        await w.start()
        await asyncio.wait_for(w.ready.wait(), WAIT_SECONDS)
        self.workers.append(w)
        return w

    async def stop_all(self) -> None:
        for w in self.workers:
            await w.stop()
        self.workers.clear()

    async def send(self, cmd: str, task_id: int, trace_id: str = "", **fields) -> str:
        msg = {"cmd": cmd, "taskId": str(task_id)}
        if trace_id:
            msg["traceId"] = trace_id
        for k, v in fields.items():
            msg[k] = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
        return await self.redis.xadd(self.settings.doc_task_stream, msg)

    async def events(self, task_id: int | None = None) -> list[dict[str, str]]:
        rows = await self.redis.xrange(self.settings.doc_event_stream)
        out = [fields for _, fields in rows]
        return [e for e in out if task_id is None or e["taskId"] == str(task_id)]

    async def wait(self, predicate, timeout: float = WAIT_SECONDS) -> list[dict[str, str]]:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while True:
            events = await self.events()
            if predicate(events):
                return events
            if loop.time() > deadline:
                raise AssertionError(f"等待超时，当前事件：{[(e['taskId'], e['type']) for e in events]}")
            await asyncio.sleep(0.05)

    async def pending_count(self) -> int:
        info = await self.redis.xpending(self.settings.doc_task_stream, self.settings.doc_consumer_group)
        return int(info["pending"])

    async def wait_acked(self, timeout: float = WAIT_SECONDS) -> None:
        """处理完成后才 XACK：等待任务流上没有未确认的消息。"""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while await self.pending_count() > 0:
            if loop.time() > deadline:
                raise AssertionError("仍有未确认的任务消息")
            await asyncio.sleep(0.05)


def new_task_id() -> int:
    return random.randint(10**9, 2 * 10**9)


def has(task_id: int, type_: str, count: int = 1):
    return lambda events: sum(1 for e in events if e["taskId"] == str(task_id) and e["type"] == type_) >= count


def datas(events, type_: str) -> list[dict]:
    return [json.loads(e["data"]) for e in events if e["type"] == type_]


def collapse(types: list[str]) -> list[str]:
    """把连续重复的 (chunk_done, trace) 对合并为一个，便于与块数不同的契约样例比较结构。"""
    out: list[str] = []
    i = 0
    while i < len(types):
        pair = types[i : i + 2]
        if pair == ["chunk_done", "trace"] and out[-2:] == pair:
            i += 2
            continue
        out.append(types[i])
        i += 1
    return out


K8S_TERMS = [
    {"source": "Pod", "target": "容器组", "type": "term", "count": 9},
    {"source": "Deployment", "target": "部署", "type": "term", "count": 6},
    {"source": "kubelet", "target": "kubelet", "type": "name", "count": 1},
]


# ---------------------------------------------------------------- 3.6 / 4.1 完整流程


async def test_full_pipeline_matches_contract_sample(infra):
    text = fixture_text("k8s-guide.md")
    fake = DocFakeLLM(terms=K8S_TERMS)
    await infra.worker(fake)
    task_id = new_task_id()
    payload = doc_payload(text, confirmTerms=True)
    await infra.send("start", task_id, "doc-a", payload=payload)
    events = await infra.wait(has(task_id, "awaiting_confirm"))
    await infra.wait_acked()  # 中断后确认了 start 消息

    await infra.send(
        "resume",
        task_id,
        "doc-b",
        data={"terms": [{"source": "Pod", "target": "Pod"}, {"source": "kubelet", "target": "kubelet"}]},
    )
    events = await infra.wait(has(task_id, "completed"))
    events = [e for e in events if e["taskId"] == str(task_id)]

    # 每条消息的字段与类型：全部是字符串，data 是单行 JSON，eventSeq 从 1 开始连续递增
    for e in events:
        assert set(e) == {"taskId", "eventSeq", "type", "traceId", "data"}
        assert all(isinstance(v, str) for v in e.values())
        assert "\n" not in e["data"]
        json.loads(e["data"])
    assert [int(e["eventSeq"]) for e in events] == list(range(1, len(events) + 1))
    assert {e["traceId"] for e in events[:9]} == {"doc-a"} and {e["traceId"] for e in events[9:]} == {"doc-b"}

    # 事件序列结构与契约样例 2.1 一致
    sample = load_sample_events()[1]
    assert collapse([e["type"] for e in events]) == collapse([s["type"] for s in sample])
    assert sum(1 for e in events if e["type"] == "chunk_done") == 4
    sample_by_type: dict[str, dict] = {}
    for s in sample:
        sample_by_type.setdefault(s["type"], s["data"])
    for e in events:
        data = json.loads(e["data"])
        expected = sample_by_type[e["type"]]
        if e["type"] == "trace":
            assert (
                {"seq", "node", "status", "summary"}
                <= set(data)
                <= {"seq", "node", "status", "summary", "chunk", "latencyMs", "usage"}
            )
        else:
            # improve-agent-from-experiments D7 新增的字段（契约样例之后加入）
            added = {"reviewIssues"} if e["type"] == "chunk_done" else set()
            assert set(data) == set(expected) | added, (e["type"], data)
    phases = [json.loads(e["data"])["phase"] for e in events if e["type"] == "phase"]
    assert phases == ["parsing", "analyzing", "awaiting_confirm", "translating", "consistency", "assembling"]

    parsed = datas(events, "parsed")[0]
    assert join_segments(parsed["segments"]) == text  # 解析结果可以逐字节拼回原文
    assert set(parsed["segments"][0]) == set(sample_by_type["parsed"]["segments"][0])
    assert set(parsed["chunks"][0]) == {"index", "segSeqs", "group"}
    assert len(parsed["chunks"]) == 4
    done = datas(events, "chunk_done")
    assert [d["chunk"] for d in done] == [0, 1, 2, 3] and not any(d["cached"] for d in done)
    # tmHits 为 add-session-context-and-memory 契约 E 新增（该段命中的翻译记忆，0–1 条）
    assert set(done[0]["segments"][0]) == {"seq", "target", "reviewScore", "reviewRounds", "compliance", "tmHits"}
    awaiting = datas(events, "awaiting_confirm")[0]
    # kubelet 只出现在行内代码中，不算术语出现，被过滤
    assert {c["source"] for c in awaiting["candidates"]} == {"Pod", "Deployment"}
    traces = datas(events, "trace")
    assert [t["seq"] for t in traces] == list(range(1, len(traces) + 1))
    assert [t["node"] for t in traces][:4] == ["parse", "analyze", "align_terms", "confirm_terms"]
    completed = datas(events, "completed")[0]
    assert set(completed["stats"]) == {"chunks", "cachedChunks", "refined", "compliance"}
    assert completed["stats"]["chunks"] == 4
    await infra.wait_acked()


async def test_consumer_groups_created_idempotently(infra):
    fake = DocFakeLLM()
    await infra.worker(fake)
    await infra.stop_all()
    await infra.worker(fake)  # 再次启动：BUSYGROUP 被忽略
    groups = await infra.redis.xinfo_groups(infra.settings.doc_task_stream)
    assert [g["name"] for g in groups] == ["ai-worker"]
    event_groups = await infra.redis.xinfo_groups(infra.settings.doc_event_stream)
    assert [g["name"] for g in event_groups] == ["spring"]


# ---------------------------------------------------------------- 4.1 排队、取消、中断释放并发、幂等


def block_translate(kind, n, payload):
    return kind == "translate"


async def test_queue_respects_global_concurrency(infra):
    fake = DocFakeLLM(gate=block_translate)
    await infra.worker(fake)
    ids = [new_task_id() for _ in range(3)]
    for tid in ids:
        await infra.send("start", tid, payload=doc_payload("Hello world.\n", sourceLang="en"))
    await infra.wait(
        lambda ev: (
            has(ids[0], "chunk_done", 0)(ev)
            and sum(1 for e in ev if e["type"] == "phase" and json.loads(e["data"])["phase"] == "translating") >= 2
        )
    )
    await asyncio.sleep(0.3)
    events = await infra.events()
    assert {e["taskId"] for e in events} == {str(ids[0]), str(ids[1])}  # 第 3 个任务仍在排队（PENDING）
    fake.release.set()
    await infra.wait(lambda ev: all(has(t, "completed")(ev) for t in ids))
    await infra.wait_acked()


async def test_cancel_running_task_aborts_llm_and_can_retry(infra):
    fake = DocFakeLLM(gate=block_translate)
    await infra.worker(fake)
    tid = new_task_id()
    payload = doc_payload(fixture_text("short-note.txt"), format="txt", sourceLang="en")
    await infra.send("start", tid, "doc-a", payload=payload)
    await asyncio.wait_for(fake.blocked.wait(), WAIT_SECONDS)
    await infra.send("cancel", tid, "doc-c")
    events = await infra.wait(has(tid, "cancelled"))
    assert fake.cancelled.is_set()  # 在途的 LLM 调用被取消
    assert not has(tid, "completed")(events)
    assert datas([e for e in events if e["taskId"] == str(tid)], "cancelled") == [{}]
    await infra.wait_acked()

    # 取消后继续：从检查点恢复（不再解析与分析），完成翻译
    fake.gate = None
    analyze_before = fake.count("analyze")
    await infra.send("retry", tid, "doc-d", payload=payload)
    events = await infra.wait(has(tid, "completed"))
    assert fake.count("analyze") == analyze_before
    retry_events = [e for e in events if e["traceId"] == "doc-d"]
    assert retry_events[0]["type"] == "phase" and json.loads(retry_events[0]["data"]) == {"phase": "translating"}
    seqs = [int(e["eventSeq"]) for e in events if e["taskId"] == str(tid)]
    assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)  # retry 后 eventSeq 继续递增


async def test_cancel_queued_task(infra):
    fake = DocFakeLLM(gate=block_translate)
    await infra.worker(fake, doc_worker_concurrency=1)
    running, queued = new_task_id(), new_task_id()
    await infra.send("start", running, payload=doc_payload("One.\n", sourceLang="en"))
    await infra.send("start", queued, payload=doc_payload("Two.\n", sourceLang="en"))
    await asyncio.wait_for(fake.blocked.wait(), WAIT_SECONDS)
    await infra.send("cancel", queued)
    events = await infra.wait(has(queued, "cancelled"))
    assert [e["type"] for e in events if e["taskId"] == str(queued)] == ["cancelled"]
    fake.release.set()
    await infra.wait(has(running, "completed"))


async def test_awaiting_confirm_releases_slot(infra):
    """并发为 1：任务 A 待确认期间，任务 B 仍能执行完成；随后确认 A 并完成。"""
    fake = DocFakeLLM(terms=[{"source": "world", "target": "世界", "type": "term", "count": 2}])
    await infra.worker(fake, doc_worker_concurrency=1)
    a, b = new_task_id(), new_task_id()
    await infra.send("start", a, payload=doc_payload("Hello world. The world.\n", sourceLang="en", confirmTerms=True))
    await infra.wait(has(a, "awaiting_confirm"))
    await infra.send("start", b, payload=doc_payload("Another document.\n", sourceLang="en"))
    await infra.wait(has(b, "completed"))
    await infra.send("resume", a, data={"terms": [{"source": "world", "target": "世界"}]})
    events = await infra.wait(has(a, "completed"))
    a_types = [e["type"] for e in events if e["taskId"] == str(a)]
    assert a_types.index("awaiting_confirm") < a_types.index("completed")


async def test_duplicate_and_invalid_commands(infra):
    fake = DocFakeLLM()
    await infra.worker(fake)
    tid = new_task_id()
    payload = doc_payload("Hello world.\n", sourceLang="en")
    await infra.send("start", tid, payload=payload)
    await infra.send("start", tid, payload=payload)  # 重复投递
    await infra.wait(has(tid, "completed"))
    await infra.send("resume", tid, data={"terms": []})  # 不在待确认状态：忽略
    await infra.send("bogus", tid)
    await infra.redis.xadd(infra.settings.doc_task_stream, {"cmd": "start"})  # 缺少 taskId
    await asyncio.sleep(0.5)
    events = await infra.events(tid)
    assert sum(1 for e in events if e["type"] == "completed") == 1
    assert sum(1 for e in events if e["type"] == "parsed") == 1
    assert fake.count("analyze") == 1
    await infra.wait_acked()


async def test_invalid_payload_fails_without_retry(infra):
    fake = DocFakeLLM()
    await infra.worker(fake)
    tid = new_task_id()
    await infra.send("start", tid, payload={"text": "x"})  # 缺少 targetLang
    events = await infra.wait(has(tid, "failed"))
    failed = datas(events, "failed")[0]
    assert failed["code"] == "A0410" and failed["retryable"] is False


async def test_llm_failure_emits_failed_then_retry_completes(infra):
    from app.llm.base import LLMError, LLMErrorKind

    state = {"fail": True}

    def translate(req, payload, n):
        if state["fail"] and n == 1:
            raise LLMError(LLMErrorKind.TIMEOUT)
        return json.dumps({"segments": [{"id": s["id"], "text": "译:" + s["text"]} for s in payload["segments"]]})

    fake = DocFakeLLM(handlers={"translate": translate})
    await infra.worker(fake)
    tid = new_task_id()
    payload = doc_payload(fixture_text("k8s-guide.md"), options={"review": False, "termExtraction": False})
    await infra.send("start", tid, "doc-a", payload=payload)
    events = await infra.wait(has(tid, "failed"))
    assert datas(events, "failed")[0] == {"code": "C0122", "message": "LLM 调用超时", "retryable": True}
    state["fail"] = False
    before = fake.count("translate")
    await infra.send("retry", tid, "doc-b", payload=payload)
    events = await infra.wait(has(tid, "completed"))
    retried = [json.loads(e["data"]) for e in events if e["traceId"] == "doc-b" and e["type"] == "chunk_done"]
    assert [(d["chunk"], d["cached"]) for d in retried] == [(0, True), (1, False), (2, False), (3, False)]
    assert fake.count("translate") - before == 3


async def test_cancel_awaiting_confirm_with_purge(infra):
    fake = DocFakeLLM(terms=[{"source": "world", "target": "世界", "type": "term", "count": 2}])
    await infra.worker(fake)
    tid = new_task_id()
    await infra.send("start", tid, payload=doc_payload("Hello world. The world.\n", sourceLang="en", confirmTerms=True))
    await infra.wait(has(tid, "awaiting_confirm"))
    await infra.store.put(tid, 0, {"index": 0, "segments": []}, {})
    await infra.send("cancel", tid, purge="true")
    await infra.wait(has(tid, "cancelled"))
    await asyncio.sleep(0.2)
    graph = compile_doc_graph(infra.saver)
    assert (await graph.aget_state(thread_config(tid))).created_at is None  # 检查点已删除
    assert await infra.store.get(tid, 0) is None  # 分块缓存已删除
    assert not await infra.redis.exists(f"{infra.settings.doc_stream_prefix}doc-seq:{tid}")


async def test_completed_task_is_purged_and_cancel_still_reports(infra):
    """完成后清理检查点与分块缓存；之后的重复 start 被忽略；删除时的 cancel 仍回报 cancelled 且 eventSeq 继续递增。"""
    fake = DocFakeLLM()
    await infra.worker(fake)
    tid = new_task_id()
    payload = doc_payload("Hello world.\n", sourceLang="en")
    await infra.send("start", tid, payload=payload)
    await infra.wait(has(tid, "completed"))
    await infra.wait_acked()
    graph = compile_doc_graph(infra.saver)
    for _ in range(100):  # 确认消息之后才清理
        if (await graph.aget_state(thread_config(tid))).created_at is None:
            break
        await asyncio.sleep(0.05)
    assert (await graph.aget_state(thread_config(tid))).created_at is None
    assert await infra.store.get(tid, 0) is None
    prefix = infra.settings.doc_stream_prefix
    assert 0 < await infra.redis.ttl(f"{prefix}doc-seq:{tid}") <= infra.settings.doc_done_ttl_seconds

    await infra.send("start", tid, payload=payload)  # 完成后的重复投递
    await infra.wait_acked()
    await asyncio.sleep(0.2)
    assert fake.count("analyze") == 1

    await infra.send("cancel", tid, purge="true")  # 用户删除任务
    events = await infra.wait(has(tid, "cancelled"))
    mine = [e for e in events if e["taskId"] == str(tid)]
    assert [e["type"] for e in mine].count("parsed") == 1
    assert int(mine[-1]["eventSeq"]) == int(mine[-2]["eventSeq"]) + 1
    await infra.wait_acked()
    assert not await infra.redis.exists(f"{prefix}doc-seq:{tid}", f"{prefix}doc-done:{tid}")


async def test_cancel_unknown_task_reports_cancelled(infra):
    await infra.worker(DocFakeLLM())
    tid = new_task_id()
    await infra.send("cancel", tid, "doc-x")
    events = await infra.wait(has(tid, "cancelled"))
    assert [(e["type"], e["eventSeq"], e["traceId"]) for e in events if e["taskId"] == str(tid)] == [
        ("cancelled", "1", "doc-x")
    ]
    await infra.wait_acked()


# ---------------------------------------------------------------- 4.2 断点续译


@pytest.mark.parametrize("same_consumer", [True, False], ids=["reread-own-pending", "xautoclaim"])
async def test_restart_resumes_and_skips_completed_chunks(infra, same_consumer):
    """在第 3 块执行时强制终止 worker；重启后前 2 块以 cached 上报且不再调用 LLM，从第 3 块继续直到完成。"""
    text = fixture_text("k8s-guide.md")
    payload = doc_payload(text, options={"review": False, "termExtraction": False})
    first = DocFakeLLM(gate=lambda kind, n, p: kind == "translate" and n == 2)
    worker = await infra.worker(first, consumer="worker-a")
    tid = new_task_id()
    await infra.send("start", tid, "doc-a", payload=payload)
    await asyncio.wait_for(first.blocked.wait(), WAIT_SECONDS)
    await worker.stop()  # 模拟进程被终止：消息未确认
    infra.workers.remove(worker)
    before = await infra.events(tid)
    assert [json.loads(e["data"])["chunk"] for e in before if e["type"] == "chunk_done"] == [0, 1]
    assert await infra.pending_count() == 1

    second = DocFakeLLM()
    if same_consumer:
        await infra.worker(second, consumer="worker-a")
    else:
        await infra.worker(second, consumer="worker-b", doc_claim_idle_ms=0)
    events = await infra.wait(has(tid, "completed"))
    after = [e for e in events if e["taskId"] == str(tid)][len(before) :]
    assert after[0]["type"] == "phase" and json.loads(after[0]["data"]) == {"phase": "translating"}
    done = [json.loads(e["data"]) for e in after if e["type"] == "chunk_done"]
    assert [(d["chunk"], d["cached"]) for d in done] == [(0, True), (1, True), (2, False), (3, False)]
    assert done[0]["usage"] == {"promptTokens": 0, "completionTokens": 0}
    # 重启后只翻译了第 3、4 块；解析与分析没有重做
    assert second.kinds() == ["translate", "translate"]
    seqs = [int(e["eventSeq"]) for e in events if e["taskId"] == str(tid)]
    assert seqs == list(range(1, len(seqs) + 1))  # 跨重启 eventSeq 不回退、不重复
    completed = json.loads(after[-1]["data"])
    assert completed["stats"]["cachedChunks"] == 2
    await infra.wait_acked()


async def test_restart_after_resume_continues_from_checkpoint(infra):
    """确认术语（resume）生效后、翻译途中进程被终止：重新投递的 resume 必须从检查点继续，而不是被当作无效命令确认掉。

    联调回归：之前 worker 发现任务已不在待确认状态就忽略 resume 并 ACK，任务永远停在 TRANSLATING。
    """
    text = fixture_text("k8s-guide.md")
    payload = doc_payload(text, confirmTerms=True, options={"review": False})
    first = DocFakeLLM(terms=K8S_TERMS, gate=lambda kind, n, p: kind == "translate" and n == 1)
    worker = await infra.worker(first, consumer="worker-a")
    tid = new_task_id()
    await infra.send("start", tid, "doc-a", payload=payload)
    await infra.wait(has(tid, "awaiting_confirm"))
    await infra.wait_acked()
    await infra.send("resume", tid, "doc-b", data={"terms": [{"source": "Pod", "target": "Pod"}]})
    await asyncio.wait_for(first.blocked.wait(), WAIT_SECONDS)
    await worker.stop()  # resume 消息未确认
    infra.workers.remove(worker)
    before = await infra.events(tid)
    assert [json.loads(e["data"])["chunk"] for e in before if e["type"] == "chunk_done"] == [0]

    second = DocFakeLLM(terms=K8S_TERMS)
    await infra.worker(second, consumer="worker-a")
    events = await infra.wait(has(tid, "completed"))
    after = [e for e in events if e["taskId"] == str(tid)][len(before) :]
    done = [json.loads(e["data"]) for e in after if e["type"] == "chunk_done"]
    assert [(d["chunk"], d["cached"]) for d in done] == [(0, True), (1, False), (2, False), (3, False)]
    # 没有重新解析、分析，也没有再次进入待确认
    assert "awaiting_confirm" not in [e["type"] for e in after]
    assert set(second.kinds()) <= {"translate", "consistency"}
    await infra.wait_acked()
