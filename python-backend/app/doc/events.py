"""事件发射器（design D2 事件流 tl:doc-events）。

每条事件是一条 Stream 消息，字段 ``{taskId, eventSeq, type, traceId, data}`` 全部为字符串，data 为单行 JSON。

eventSeq 用 Redis 计数键 ``{prefix}doc-seq:{taskId}`` 生成：INCR 与 XADD 在同一个 Lua 脚本里原子执行，
因此同一任务的 eventSeq 跨重启、跨 retry 单调递增（不依赖检查点，翻译阶段中途崩溃也不会回退）。
trace 事件的 seq 同理使用 ``{prefix}doc-trace-seq:{taskId}``。
"""

import asyncio
import json
from typing import Any, Protocol

_EMIT_SCRIPT = """
local seq = redis.call('INCR', KEYS[1])
redis.call('XADD', KEYS[2], '*', 'taskId', ARGV[1], 'eventSeq', tostring(seq), 'type', ARGV[2],
           'traceId', ARGV[3], 'data', ARGV[4])
return seq
"""


def dumps(data: dict[str, Any]) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def seq_key(prefix: str, task_id: int | str) -> str:
    return f"{prefix}doc-seq:{task_id}"


def trace_seq_key(prefix: str, task_id: int | str) -> str:
    return f"{prefix}doc-trace-seq:{task_id}"


class EventEmitter(Protocol):
    async def emit(self, type_: str, data: dict[str, Any]) -> int: ...

    async def phase(self, phase: str) -> None: ...

    async def trace(
        self,
        node: str,
        status: str,
        summary: str,
        *,
        chunk: int | None = None,
        latency_ms: int | None = None,
        usage: dict[str, int] | None = None,
    ) -> None: ...


class BaseEmitter:
    """phase 去重（同一次执行内连续相同的阶段只发一次）与 trace 组装；子类实现 _publish / _next_trace_seq。"""

    def __init__(self) -> None:
        self.last_phase: str | None = None
        self._lock = asyncio.Lock()

    async def _publish(self, type_: str, data: dict[str, Any]) -> int:
        raise NotImplementedError

    async def _next_trace_seq(self) -> int:
        raise NotImplementedError

    async def emit(self, type_: str, data: dict[str, Any]) -> int:
        async with self._lock:
            return await self._publish(type_, data)

    async def phase(self, phase: str) -> None:
        if phase == self.last_phase:
            return
        self.last_phase = phase
        await self.emit("phase", {"phase": phase})

    async def trace(
        self,
        node: str,
        status: str,
        summary: str,
        *,
        chunk: int | None = None,
        latency_ms: int | None = None,
        usage: dict[str, int] | None = None,
    ) -> None:
        async with self._lock:
            data: dict[str, Any] = {"seq": await self._next_trace_seq(), "node": node, "status": status}
            if chunk is not None:
                data["chunk"] = chunk
            data["summary"] = summary
            if latency_ms is not None:
                data["latencyMs"] = latency_ms
            if usage is not None:
                data["usage"] = usage
            await self._publish("trace", data)


class RedisEmitter(BaseEmitter):
    def __init__(self, redis: Any, *, stream: str, prefix: str, task_id: int | str, trace_id: str):
        super().__init__()
        self._redis = redis
        self._stream = stream
        self._seq_key = seq_key(prefix, task_id)
        self._trace_key = trace_seq_key(prefix, task_id)
        self._task_id = str(task_id)
        self._trace_id = trace_id or ""
        self._script = redis.register_script(_EMIT_SCRIPT)

    async def _publish(self, type_: str, data: dict[str, Any]) -> int:
        seq = await self._script(
            keys=[self._seq_key, self._stream], args=[self._task_id, type_, self._trace_id, dumps(data)]
        )
        return int(seq)

    async def _next_trace_seq(self) -> int:
        return int(await self._redis.incr(self._trace_key))
