"""篇章图（design D5）。

START → parse → analyze → align_terms ─┬─ confirmTerms=false ───────────────┐
                                        └─ confirm_terms (interrupt) ────────┤
                                                                            ▼
                                  plan_chunks → translate_group (Send ×N) → consistency → finalize → END

- 检查点：编译时传入 AsyncPostgresSaver（ai schema），thread_id = taskId；执行时 durability="sync"
- 事件：节点通过 DocDeps.emitter 直接写事件流；每个节点结束时发 trace（analyze 的 trace 延后到
  align_terms 发出 analysis 事件之后，与契约样例的顺序一致；plan_chunks 与 finalize 不发 trace）
- 阶段：节点开始时发 phase（同一次执行内连续相同的阶段只发一次）；confirm_terms 在 resume 后才发 translating
"""

import time
from collections.abc import Awaitable, Callable
from typing import Any

from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.runtime import Runtime
from langgraph.types import Send

from app.agent.nodes.base import NodeOutput
from app.doc import analysis, consistency
from app.doc.state import DocDeps, DocPayload, DocState, GroupInput, usage_dict
from app.doc.translate import translate_group

NodeFn = Callable[[DocState, DocDeps], Awaitable[NodeOutput]]

# 恢复执行时，按下一个待执行的节点补发阶段事件
PHASE_OF_NODE = {
    "parse": "parsing",
    "analyze": "analyzing",
    "align_terms": "analyzing",
    "confirm_terms": "awaiting_confirm",
    "plan_chunks": "translating",
    "translate_group": "translating",
    "consistency": "consistency",
    "finalize": "assembling",
}


def traced(name: str, fn: NodeFn, *, phase: str | None = None, trace: bool = True, defer: bool = False):
    async def node(state: DocState, runtime: Runtime[DocDeps]) -> dict[str, Any]:
        deps = runtime.context
        if phase:
            await deps.emitter.phase(phase)
        start = time.perf_counter()
        out = await fn(state, deps)
        latency = int((time.perf_counter() - start) * 1000)
        update = dict(out.update)
        update["elapsed_ms"] = update.get("elapsed_ms", 0) + latency
        if out.usage is not None:
            update["usage"] = usage_dict(out.usage)
        data = {
            "node": name,
            "status": "completed",
            "summary": out.summary,
            "latency_ms": latency,
            "usage": usage_dict(out.usage) if out.usage is not None else None,
        }
        pending = list(state.get("pending_traces") or [])
        if defer:
            update["pending_traces"] = [*pending, data]
            return update
        for p in pending:
            await deps.emitter.trace(**p)
        if pending:
            update["pending_traces"] = []
        if trace:
            await deps.emitter.trace(**data)
        return update

    node.__name__ = name
    return node


def route_after_align(state: DocState) -> str:
    return "confirm_terms" if state["payload"].get("confirmTerms") else "plan_chunks"


def fan_out(state: DocState) -> list[Send] | str:
    groups = state.get("groups") or []
    if not groups:
        return "consistency"
    chunks = {c["index"]: c for c in state.get("chunks") or []}
    segments = {s["seq"]: s for s in state.get("segments") or []}
    payload = state["payload"]
    sends = []
    for gi, chunk_ids in enumerate(groups):
        seqs = [q for i in chunk_ids for q in chunks[i]["segSeqs"]]
        arg: GroupInput = {
            "task_id": state["task_id"],
            "group": gi,
            "chunk_ids": chunk_ids,
            "total_chunks": len(chunks),
            "chunks": {str(i): chunks[i] for i in chunk_ids},
            "segments": {str(q): segments[q] for q in seqs},
            "terms": state.get("terms") or [],
            "summary": state.get("summary"),
            "domain": state.get("domain") or "",
            "source_lang": state.get("source_lang") or "auto",
            "payload": {
                "userId": payload.get("userId"),  # 翻译记忆所属用户
                "targetLang": payload["targetLang"],
                "style": payload.get("style"),
                "options": payload.get("options") or {},
            },
        }
        sends.append(Send("translate_group", arg))
    return sends


def build_doc_graph() -> StateGraph:
    g = StateGraph(DocState, context_schema=DocDeps)
    g.add_node("parse", traced("parse", analysis.parse, phase="parsing"))
    g.add_node("analyze", traced("analyze", analysis.analyze, phase="analyzing", defer=True))
    g.add_node("align_terms", traced("align_terms", analysis.align_terms, phase="analyzing"))
    g.add_node("confirm_terms", traced("confirm_terms", analysis.confirm_terms))
    g.add_node("plan_chunks", traced("plan_chunks", analysis.plan_chunks, phase="translating", trace=False))
    g.add_node("translate_group", translate_group)
    g.add_node("consistency", traced("consistency", consistency.consistency, phase="consistency"))
    g.add_node("finalize", traced("finalize", consistency.finalize, phase="assembling", trace=False))

    g.add_edge(START, "parse")
    g.add_edge("parse", "analyze")
    g.add_edge("analyze", "align_terms")
    g.add_conditional_edges("align_terms", route_after_align, ["confirm_terms", "plan_chunks"])
    g.add_edge("confirm_terms", "plan_chunks")
    g.add_conditional_edges("plan_chunks", fan_out, ["translate_group", "consistency"])
    g.add_edge("translate_group", "consistency")
    g.add_edge("consistency", "finalize")
    g.add_edge("finalize", END)
    return g


def compile_doc_graph(checkpointer: Any) -> CompiledStateGraph:
    return build_doc_graph().compile(checkpointer=checkpointer)


def thread_config(task_id: int | str) -> dict[str, Any]:
    return {"configurable": {"thread_id": str(task_id)}, "recursion_limit": 50}


def initial_state(task_id: int, payload: DocPayload) -> DocState:
    return {
        "task_id": task_id,
        "payload": payload.model_dump(by_alias=True),
        "usage": {"promptTokens": 0, "completionTokens": 0},
        "elapsed_ms": 0,
        "chunk_results": [],
        "pending_traces": [],
    }
