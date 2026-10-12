"""成本统计（design D4）：token、逐块耗时之和、墙钟时间。

- token：任务详情中的 promptTokens / completionTokens（平台按任务累计，含失败重试前已消耗的部分）
- 逐块耗时之和：执行轨迹中各节点上报的 latencyMs 之和，只包含节点实际执行的时间；
  任务失败到重试之间的等待、排队时间不会出现在任何轨迹里，因此天然被排除。
  断点续译时已完成的块以 cached 方式上报（不调用 LLM），它们的耗时同样按上报值计入（通常接近 0）
- 分析、摘要、一致性等全文级节点没有 chunkIndex，单独的 chunk_latency_ms 只统计分块翻译节点
- 墙钟时间：startedAt 到 finishedAt（含排队之外的全部等待），以及执行器记录的本地开始/结束时间
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class CostReport:
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    node_latency_ms: int  # 逐块（逐节点）耗时之和：所有轨迹节点 latencyMs 之和
    chunk_latency_ms: int  # 其中分块翻译节点（translate_chunk，含评审修正）的耗时之和
    wall_ms: int | None  # 平台任务的墙钟时间
    trace_count: int


def _parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def wall_ms(started_at: str | None, finished_at: str | None) -> int | None:
    a, b = _parse_ts(started_at), _parse_ts(finished_at)
    if a is None or b is None:
        return None
    return int((b - a).total_seconds() * 1000)


def node_latency_ms(traces: Iterable[dict]) -> int:
    return sum(int(t.get("latencyMs") or 0) for t in traces)


def chunk_latency_ms(traces: Iterable[dict]) -> int:
    return sum(int(t.get("latencyMs") or 0) for t in traces if t.get("chunkIndex") is not None)


def task_cost(task: dict, traces: list[dict]) -> CostReport:
    pt = int(task.get("promptTokens") or 0)
    ct = int(task.get("completionTokens") or 0)
    if pt == 0 and ct == 0:
        # 任务详情未汇总 token 时退回轨迹之和
        pt = sum(int(t.get("promptTokens") or 0) for t in traces)
        ct = sum(int(t.get("completionTokens") or 0) for t in traces)
    return CostReport(
        prompt_tokens=pt,
        completion_tokens=ct,
        total_tokens=pt + ct,
        node_latency_ms=node_latency_ms(traces),
        chunk_latency_ms=chunk_latency_ms(traces),
        wall_ms=wall_ms(task.get("startedAt"), task.get("finishedAt")),
        trace_count=len(traces),
    )
