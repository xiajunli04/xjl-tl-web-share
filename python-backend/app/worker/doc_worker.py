"""文档任务 worker（design D1 / D6 / D7）。

- 运行在 FastAPI lifespan 中：``start()`` 启动读取循环，``stop()`` 取消循环与全部在途任务（不确认消息，重启后续跑）
- 启动时幂等创建消费组（任务流的 ``ai-worker``、事件流的 ``spring``，BUSYGROUP 忽略），然后
  先重读本消费者未确认的消息（固定消费者名），再 XAUTOCLAIM 认领其他消费者闲置超过 60 秒的消息
- 命令：start / retry / resume 生成任务协程；cancel 立即处理：取消排队或运行中的协程（在途 LLM 调用随之关闭），
  无论任务处于何种状态（排队、运行、待确认、未知、已终结）都发出 cancelled
- 并发：全局信号量 ``doc_worker_concurrency``；图在术语确认处中断后立即释放槽位，之后才发 awaiting_confirm
- 处理完成（完成、中断、失败、被用户取消）后才 XACK；同一任务的后续命令排在前一个命令之后执行
- 清理：任务完成并确认后删除检查点与分块缓存（eventSeq 计数键与完成标记设置 7 天过期）；
  cancel 带 ``purge=true``（任务被删除）时立即删除全部数据。普通 cancel 保留检查点，retry 可以续译
- eventSeq：Redis 计数键 ``{prefix}doc-seq:{taskId}``（见 app/doc/events.py），跨 retry 与进程重启单调递增
"""

import asyncio
import contextlib
import json
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from langgraph.graph.state import CompiledStateGraph
from langgraph.types import Command
from redis.exceptions import ResponseError

from app.core.config import Settings
from app.core.logging import new_trace_id, trace_id_var
from app.doc.events import RedisEmitter, seq_key, trace_seq_key
from app.doc.graph import PHASE_OF_NODE, initial_state, thread_config
from app.doc.llm import failure_payload
from app.doc.state import DocDeps, DocPayload
from app.doc.store import ChunkStore
from app.glossary.repository import GlossaryRepository
from app.lang.detector import LanguageDetector
from app.llm.registry import LLMRegistry
from app.llm.reviewer import ReviewerSource

log = logging.getLogger("app.worker.doc")

CANCEL_WAIT_SECONDS = 10.0
RETRY_BACKOFF_SECONDS = 2.0
READ_COUNT = 10


@dataclass
class _Job:
    msg_id: str
    cmd: str
    task: asyncio.Task | None = None
    outcome: str | None = None


@dataclass
class DocWorker:
    settings: Settings
    redis: Any  # redis.asyncio.Redis（decode_responses=True）
    graph: CompiledStateGraph
    checkpointer: Any
    store: ChunkStore
    registry: LLMRegistry
    detector: LanguageDetector
    glossary_repo: GlossaryRepository
    consumer: str | None = None
    llm_resolver: Callable[[int | None], Any] | None = None  # 测试注入：返回 ResolvedModel 的协程函数
    tm: Any = None  # 翻译记忆仓储（app.memory.tm.TranslationMemory）；为空时不检索
    _loop_task: asyncio.Task | None = None
    _slots: asyncio.Semaphore | None = None
    _jobs: dict[str, list[_Job]] = field(default_factory=dict)
    _inflight: set[str] = field(default_factory=set)
    _cancelling: set[str] = field(default_factory=set)
    _scripts_ready: bool = False
    ready: asyncio.Event = field(default_factory=asyncio.Event)

    def __post_init__(self) -> None:
        self.consumer = self.consumer or self.settings.doc_consumer_name
        self._slots = asyncio.Semaphore(max(1, self.settings.doc_worker_concurrency))

    # ------------------------------------------------------------ 生命周期

    async def start(self) -> None:
        self._loop_task = asyncio.create_task(self._run(), name="doc-worker")

    async def stop(self) -> None:
        """停止读取并取消在途任务；未完成的消息保持未确认，重启后由本消费者重读续跑。"""
        tasks = [j.task for jobs in self._jobs.values() for j in jobs if j.task is not None]
        if self._loop_task is not None:
            tasks.append(self._loop_task)
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._jobs.clear()
        self._inflight.clear()

    async def _run(self) -> None:
        s = self.settings
        while True:
            try:
                await self._ensure_groups()
                await self.checkpointer.setup()
                break
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - Redis / 数据库暂不可用时重试，不影响服务启动
                log.warning("文档 worker 初始化失败，%.0f 秒后重试: %s", RETRY_BACKOFF_SECONDS, e)
                await asyncio.sleep(RETRY_BACKOFF_SECONDS)
        log.info("文档 worker 已启动 consumer=%s concurrency=%s", self.consumer, s.doc_worker_concurrency)
        recovered = False
        while True:
            try:
                if not recovered:
                    await self._recover()
                    recovered = True
                    self.ready.set()
                resp = await self.redis.xreadgroup(
                    s.doc_consumer_group,
                    self.consumer,
                    {s.doc_task_stream: ">"},
                    count=READ_COUNT,
                    block=s.doc_read_block_ms,
                )
                for _, messages in resp or []:
                    for msg_id, fields in messages:
                        await self._dispatch(msg_id, fields)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("读取任务流失败，%.0f 秒后重试: %s", RETRY_BACKOFF_SECONDS, e)
                await asyncio.sleep(RETRY_BACKOFF_SECONDS)

    async def _ensure_groups(self) -> None:
        s = self.settings
        for stream, group in ((s.doc_task_stream, s.doc_consumer_group), (s.doc_event_stream, s.doc_event_group)):
            try:
                await self.redis.xgroup_create(stream, group, id="0", mkstream=True)
            except ResponseError as e:
                if "BUSYGROUP" not in str(e):
                    raise

    async def _recover(self) -> None:
        """重读本消费者未确认的消息，再认领其他消费者闲置超时的消息，按消息 id 顺序处理。"""
        s = self.settings
        pending: dict[str, dict] = {}
        resp = await self.redis.xreadgroup(s.doc_consumer_group, self.consumer, {s.doc_task_stream: "0"}, count=1000)
        for _, messages in resp or []:
            for msg_id, fields in messages:
                pending[msg_id] = fields
        start = "0-0"
        while True:
            res = await self.redis.xautoclaim(
                s.doc_task_stream, s.doc_consumer_group, self.consumer, s.doc_claim_idle_ms, start_id=start, count=100
            )
            start, messages = res[0], res[1]
            for msg_id, fields in messages:
                pending[msg_id] = fields
            if not messages or start in ("0-0", b"0-0"):
                break
        if pending:
            log.info("恢复未确认的任务消息 %d 条", len(pending))
        for msg_id in sorted(pending, key=_id_key):
            await self._dispatch(msg_id, pending[msg_id])

    # ------------------------------------------------------------ 分发

    async def _ack(self, msg_id: str) -> None:
        await self.redis.xack(self.settings.doc_task_stream, self.settings.doc_consumer_group, msg_id)

    async def _dispatch(self, msg_id: str, fields: dict | None) -> None:
        if msg_id in self._inflight:
            return
        if not fields:  # 消息已被删除（XAUTOCLAIM 返回空字段）
            await self._ack(msg_id)
            return
        cmd, task_id = fields.get("cmd"), fields.get("taskId")
        if cmd not in ("start", "retry", "resume", "cancel") or not task_id or not str(task_id).isdigit():
            log.warning("忽略无效的任务消息 id=%s cmd=%s taskId=%s", msg_id, cmd, task_id)
            await self._ack(msg_id)
            return
        if cmd == "cancel":
            await self._cancel(msg_id, task_id, fields)
            return
        job = _Job(msg_id, cmd)
        prev = [j.task for j in self._jobs.get(task_id, []) if j.task is not None]
        self._inflight.add(msg_id)
        self._jobs.setdefault(task_id, []).append(job)
        job.task = asyncio.create_task(self._job(job, task_id, fields, prev), name=f"doc-task-{task_id}-{cmd}")

    async def _job(self, job: _Job, task_id: str, fields: dict, prev: list[asyncio.Task]) -> None:
        trace_id = fields.get("traceId") or new_trace_id()
        trace_id_var.set(trace_id)
        emitter = self._emitter(task_id, trace_id)
        try:
            if prev:
                await asyncio.wait(prev)  # 同一任务的命令按顺序执行
            async with self._slots:
                outcome, info = await self._execute(job.cmd, task_id, fields, emitter)
            job.outcome = outcome
            if outcome == "interrupted":
                # 槽位已释放，再通知 Spring 进入待确认
                await emitter.phase("awaiting_confirm")
                await emitter.emit("awaiting_confirm", {"candidates": info.get("candidates") or []})
            await self._ack(job.msg_id)
            log.info("任务命令处理完成 taskId=%s cmd=%s outcome=%s", task_id, job.cmd, outcome)
            if outcome == "completed":
                # 先确认再清理：确认前崩溃时，重投的 start 仍能从检查点看出任务已完成
                await self._finish(task_id)
        except asyncio.CancelledError:
            if task_id in self._cancelling:
                # 用户取消：消息视为已处理；cancelled 事件由取消处理统一发出
                with contextlib.suppress(Exception):
                    await asyncio.shield(self._ack(job.msg_id))
            raise
        except Exception:
            # 例如 Redis 在执行中途不可用、连 failed 事件都发不出去：消息保持未确认，重启后由恢复流程重新处理
            log.exception("任务命令处理异常，消息保持未确认 taskId=%s cmd=%s", task_id, job.cmd)
        finally:
            self._inflight.discard(job.msg_id)
            jobs = self._jobs.get(task_id)
            if jobs and job in jobs:
                jobs.remove(job)
                if not jobs:
                    self._jobs.pop(task_id, None)

    def _emitter(self, task_id: str, trace_id: str) -> RedisEmitter:
        s = self.settings
        return RedisEmitter(
            self.redis, stream=s.doc_event_stream, prefix=s.doc_stream_prefix, task_id=task_id, trace_id=trace_id
        )

    async def _resolve_llm(self, model_config_id: int | None):
        if self.llm_resolver is not None:
            return await self.llm_resolver(model_config_id)
        return await self.registry.get(model_config_id)

    async def _execute(self, cmd: str, task_id: str, fields: dict, emitter: RedisEmitter) -> tuple[str, dict]:
        """执行一条命令，返回 (outcome, info)：completed / interrupted / failed / noop。"""
        config = thread_config(task_id)
        try:
            snap = await self.graph.aget_state(config)
            exists = snap.created_at is not None
            payload: DocPayload | None = None
            # resume 已经生效（检查点越过了术语确认）但执行中途进程被终止：重新投递的 resume 应从检查点继续，而不是忽略
            resume_applied = False
            if cmd in ("start", "retry"):
                payload = DocPayload.model_validate(_json(fields.get("payload")))
                if exists and not snap.next:
                    log.info("任务已执行完毕，忽略重复的 %s 命令 taskId=%s", cmd, task_id)
                    return "noop", {}
                if exists and snap.interrupts:
                    return "interrupted", dict(snap.interrupts[0].value or {})
                if not exists and await self.redis.exists(self._done_key(task_id)):
                    log.info("任务已完成并清理，忽略重复的 %s 命令 taskId=%s", cmd, task_id)
                    return "noop", {}
            else:  # resume
                if not exists or not snap.next:
                    log.warning("任务不存在或已执行完毕，忽略 resume 命令 taskId=%s", task_id)
                    return "noop", {}
                if not snap.interrupts:
                    resume_applied = True
                    log.info("术语确认已生效，从检查点继续执行 taskId=%s next=%s", task_id, snap.next)
            if exists:
                payload = DocPayload.model_validate(snap.values["payload"])

            resolved = await self._resolve_llm(payload.model_config_id)
            deps = DocDeps(
                llm=resolved.client,
                settings=self.settings,
                detector=self.detector,
                glossary_repo=self.glossary_repo,
                emitter=emitter,
                store=self.store,
                model_params=resolved.params,
                reviewer=ReviewerSource.of(resolved, payload.review_model_config_id, self._resolve_llm),
                tm=self.tm,
            )
            if cmd == "resume" and not resume_applied:
                data = _json(fields.get("data"))
                graph_input: Any = Command(resume={"terms": data.get("terms") or []})
            elif exists:
                if snap.next:
                    await emitter.phase(PHASE_OF_NODE.get(snap.next[0], "translating"))
                graph_input = None
            else:
                payload.check(self.settings.doc_max_text_length)
                graph_input = initial_state(int(task_id), payload)
            log.info("执行文档任务 taskId=%s cmd=%s resume_from=%s", task_id, cmd, snap.next if exists else "-")
            await self.graph.ainvoke(graph_input, config, context=deps, durability="sync")
            snap = await self.graph.aget_state(config)
            if snap.interrupts:
                return "interrupted", dict(snap.interrupts[0].value or {})
            return "completed", {}
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 - 统一转为 failed 事件
            data = failure_payload(e)
            log.warning("文档任务失败 taskId=%s code=%s message=%s", task_id, data["code"], data["message"])
            await emitter.emit("failed", data)
            return "failed", data

    # ------------------------------------------------------------ 取消与清理

    async def _cancel(self, msg_id: str, task_id: str, fields: dict) -> None:
        trace_id = fields.get("traceId") or new_trace_id()
        emitter = self._emitter(task_id, trace_id)
        purge = str(fields.get("purge", "")).lower() in ("true", "1", "yes")
        jobs = [j.task for j in self._jobs.get(task_id, []) if j.task is not None]
        if jobs:
            self._cancelling.add(task_id)
            try:
                for t in jobs:
                    t.cancel()
                await asyncio.wait(jobs, timeout=CANCEL_WAIT_SECONDS)
            finally:
                self._cancelling.discard(task_id)
        # 无论任务是否在运行（排队、待确认、未知、已终结）都回报 cancelled，Spring 据此结束 CANCELLING
        await emitter.emit("cancelled", {})
        if purge:
            await self.purge(task_id)
        await self._ack(msg_id)
        log.info("任务已取消 taskId=%s running=%s purge=%s", task_id, bool(jobs), purge)

    def _done_key(self, task_id: str) -> str:
        return f"{self.settings.doc_stream_prefix}doc-done:{task_id}"

    async def _finish(self, task_id: str) -> None:
        """任务完成（已确认消息）后清理检查点与分块缓存。

        eventSeq 计数键不立即删除，而是与完成标记一起设置过期时间：重复投递的 start 据完成标记直接忽略，
        之后若再有事件（如删除任务时的 cancelled）eventSeq 仍然递增。
        """
        prefix = self.settings.doc_stream_prefix
        ttl = self.settings.doc_done_ttl_seconds
        await self.checkpointer.adelete_thread(str(task_id))
        await self.store.purge(int(task_id))
        await self.redis.set(self._done_key(task_id), "1", ex=ttl)
        await self.redis.expire(seq_key(prefix, task_id), ttl)
        await self.redis.expire(trace_seq_key(prefix, task_id), ttl)

    async def purge(self, task_id: str) -> None:
        """立即删除任务的检查点、分块缓存、eventSeq 计数与完成标记（cancel 命令带 purge=true，即任务被删除时）。"""
        await self.checkpointer.adelete_thread(str(task_id))
        await self.store.purge(int(task_id))
        prefix = self.settings.doc_stream_prefix
        await self.redis.delete(seq_key(prefix, task_id), trace_seq_key(prefix, task_id), self._done_key(task_id))


def _json(raw: Any) -> dict:
    if isinstance(raw, dict):
        return raw
    if not raw:
        return {}
    obj = json.loads(raw)
    return obj if isinstance(obj, dict) else {}


def _id_key(msg_id: str) -> tuple[int, int]:
    a, _, b = str(msg_id).partition("-")
    return int(a or 0), int(b or 0)
