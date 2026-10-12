"""翻译 Agent 状态图（design D1）与运行器。

START → analyze → plan ─┬─ fast / revise ─────────────────────────────► translate ─┐
                        ├─ standard ─────────────► retrieve → translate → review ───┤
                        └─ standard + 歧义 → clarify ─┘            ▲         │       │
                                                                   └─ refine ◄┘       ▼
                                                     finalize ─┬─ toMemorize 非空 → memorize → END
                                                               └──────────────────────────► END

每个节点统一包装事件推送：started / completed（摘要、耗时、usage、可选 detail）/ skipped；
clarify 中断时推送 status=interrupted。节点通过 get_stream_writer() 写出 {"event", "data"}；
运行器为 node 事件编号 seq，并在图结束后产出 final；被中断时产出 clarify（终止事件，不再有 final）。

两个编译变体（add-session-context-and-memory D4）：
- ``get_graph``：无检查点，普通请求零开销
- ``graph_hitl``：带 AsyncPostgresSaver（见 app/agent/hitl.py），仅在可能追问的会话请求上使用，
  ``thread_id = "turn:{requestId}"``；正常完成后立即删除 thread
"""

import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from functools import lru_cache
from typing import Any

from langgraph.config import get_stream_writer
from langgraph.errors import GraphInterrupt
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.runtime import Runtime
from langgraph.types import Command

from app.agent.nodes import llm as llm_nodes
from app.agent.nodes import prep
from app.agent.nodes import session as session_nodes
from app.agent.nodes.base import AgentDeps, Emit, NodeOutput
from app.agent.state import (
    DEFAULT_DOMAIN,
    NodeTrace,
    TranslateRequest,
    TranslationState,
    add_usage,
    usage_vo,
)
from app.llm.base import Usage

log = logging.getLogger("app.agent.graph")

NodeFn = Callable[[TranslationState, AgentDeps, Emit], Awaitable[NodeOutput]]

SKIP_FAST = "快速路径跳过"
SKIP_REVISE = "修订路径跳过"
THREAD_PREFIX = "turn:"


def _skips_before(node: str, state: TranslationState) -> list[tuple[str, str]]:
    """未执行的节点也要推送 skipped 事件，保证前端时间线完整；按其在图中的位置插入。"""
    path = state.get("path")
    if node == "translate" and path in ("fast", "revise"):
        return [("retrieve", SKIP_FAST if path == "fast" else SKIP_REVISE)]
    if node == "finalize":
        if path in ("fast", "revise"):
            reason = SKIP_FAST if path == "fast" else SKIP_REVISE
            return [("review", reason), ("refine", reason)]
        if path == "standard" and state.get("round", 0) == 0:
            reviews = state.get("reviews") or []
            reason = "评审通过，无需修正" if reviews and reviews[-1].passed else "修正轮次上限为 0，不再修正"
            return [("refine", reason)]
    return []


def _traced(name: str, fn: NodeFn):
    async def node(state: TranslationState, runtime: Runtime[AgentDeps]) -> dict[str, Any]:
        writer = get_stream_writer()

        def emit(event: str, data: dict[str, Any]) -> None:
            writer({"event": event, "data": data})

        traces = list(state.get("node_traces") or [])
        for skipped, reason in _skips_before(name, state):
            emit("node", {"node": skipped, "status": "skipped", "summary": reason})
            traces.append(NodeTrace(skipped, "skipped", reason))

        emit("node", {"node": name, "status": "started"})
        start = time.perf_counter()
        try:
            out = await fn(state, runtime.context, emit)
        except GraphInterrupt:
            question = (state.get("ambiguity") or {}).get("question") or ""
            emit("node", {"node": name, "status": "interrupted", "summary": f"等待用户澄清：{question}"})
            raise
        latency = int((time.perf_counter() - start) * 1000)
        data: dict[str, Any] = {"node": name, "status": "completed", "summary": out.summary, "latencyMs": latency}
        if out.usage is not None:
            data["usage"] = usage_vo(out.usage)
        if out.detail is not None:
            data["detail"] = out.detail
        emit("node", data)
        traces.append(NodeTrace(name, "completed", out.summary, latency, out.usage))
        return {**out.update, "node_traces": traces, "usage": add_usage(state.get("usage"), out.usage)}

    node.__name__ = name
    return node


def route_after_plan(state: TranslationState) -> str:
    if state.get("ambiguity"):
        return "clarify"
    return "retrieve" if state["path"] == "standard" else "translate"


def route_after_translate(state: TranslationState) -> str:
    return "review" if state["path"] == "standard" else "finalize"


def route_after_finalize(state: TranslationState) -> str:
    return "memorize" if session_nodes.should_memorize(state) else END


def make_review_router(max_rounds: int):
    def route_after_review(state: TranslationState) -> str:
        last = state["reviews"][-1]
        if last.passed or state.get("round", 0) >= max_rounds:
            return "finalize"
        return "refine"

    return route_after_review


def build_graph(max_refine_rounds: int, checkpointer: Any = None) -> CompiledStateGraph:
    g = StateGraph(TranslationState, context_schema=AgentDeps)
    g.add_node("analyze", _traced("analyze", prep.analyze))
    g.add_node("plan", _traced("plan", prep.plan))
    g.add_node("clarify", _traced("clarify", session_nodes.clarify))
    g.add_node("retrieve", _traced("retrieve", prep.retrieve))
    g.add_node("translate", _traced("translate", llm_nodes.translate))
    g.add_node("review", _traced("review", llm_nodes.review))
    g.add_node("refine", _traced("refine", llm_nodes.refine))
    g.add_node("finalize", _traced("finalize", prep.finalize))
    g.add_node("memorize", _traced("memorize", session_nodes.memorize))

    g.add_edge(START, "analyze")
    g.add_edge("analyze", "plan")
    g.add_conditional_edges("plan", route_after_plan, ["clarify", "retrieve", "translate"])
    g.add_edge("clarify", "retrieve")
    g.add_edge("retrieve", "translate")
    g.add_conditional_edges("translate", route_after_translate, ["review", "finalize"])
    g.add_conditional_edges("review", make_review_router(max_refine_rounds), ["refine", "finalize"])
    g.add_edge("refine", "review")
    g.add_conditional_edges("finalize", route_after_finalize, ["memorize", END])
    g.add_edge("memorize", END)
    return g.compile(checkpointer=checkpointer)


@lru_cache(maxsize=8)
def get_graph(max_refine_rounds: int) -> CompiledStateGraph:
    """编译后的图无状态，可在请求间复用；最大修正轮次来自 settings。"""
    return build_graph(max_refine_rounds)


def build_final(state: dict[str, Any], latency_ms: int) -> dict[str, Any]:
    req: TranslateRequest = state["request"]
    return {
        "translation": state.get("final") or "",
        "sourceLang": state.get("source_lang") or req.source_lang,
        "targetLang": req.target_lang,
        "path": state.get("path"),
        "domain": state.get("domain") or DEFAULT_DOMAIN,
        "compliance": [c.to_event() for c in state.get("compliance") or []],
        "usage": usage_vo(state.get("usage") or Usage()),
        "latencyMs": latency_ms,
        "clarification": state.get("clarification"),
        "tmHits": list(state.get("tm_hits") or []),
    }


def thread_id_of(request_id: str) -> str:
    return f"{THREAD_PREFIX}{request_id}"


def thread_config(thread_id: str, max_refine_rounds: int) -> dict[str, Any]:
    # 每轮修正经过 refine + review 两步；默认 25 步的递归上限在轮次调大时可能不够
    config: dict[str, Any] = {"recursion_limit": 18 + 2 * max_refine_rounds}
    if thread_id:
        config["configurable"] = {"thread_id": thread_id}
    return config


def emitted_node_events(state: dict[str, Any]) -> int:
    """中断前已推送的 node 事件数。

    每个完成的节点 started + completed 两个，跳过的节点 1 个，clarify 的 started + interrupted 两个。

    恢复执行时据此续接 seq，Spring 合并中断前后的轨迹时 seq 保持递增。
    """
    traces = state.get("node_traces") or []
    return sum(2 if t.status == "completed" else 1 for t in traces) + 2


def wants_hitl(request: TranslateRequest) -> bool:
    """可能追问的请求才使用带检查点的图（是否真正检查歧义还取决于 plan 选择的路径）。"""
    s = request.session
    return s is not None and s.clarify_enabled and request.mode in ("auto", "standard")


async def _drive(
    graph: CompiledStateGraph,
    graph_input: Any,
    config: dict[str, Any],
    deps: AgentDeps,
    state: dict[str, Any],
    seq: int,
) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    """执行图并转发自定义事件；节点更新合并进 state，中断信息记入 state["__interrupt__"]。"""
    kwargs: dict[str, Any] = {"durability": "exit"} if graph.checkpointer is not None else {}
    async for mode, chunk in graph.astream(
        graph_input, config=config, context=deps, stream_mode=["custom", "updates"], **kwargs
    ):
        if mode == "custom":
            event, data = chunk["event"], chunk["data"]
            if event == "node":
                seq += 1
                data = {"seq": seq, **data}
            yield event, data
        elif mode == "updates":
            for key, update in chunk.items():
                if key == "__interrupt__":
                    state["__interrupt__"] = update
                elif update:
                    state.update(update)


async def _finish(
    state: dict[str, Any], start: float, thread_id: str | None, hitl: Any
) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    interrupts = state.get("__interrupt__")
    if interrupts:
        value = dict(interrupts[0].value or {})
        yield "clarify", {"threadId": thread_id, **value}
        return
    if thread_id and hitl is not None:
        await hitl.delete_thread_quietly(thread_id)  # 正常完成后立即删除检查点
    yield "final", build_final(state, int((time.perf_counter() - start) * 1000))


async def run_agent(
    request: TranslateRequest, deps: AgentDeps, *, request_id: str | None = None, hitl: Any = None
) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    """执行一次翻译，逐个产出 (event, data)；最后一个事件是 final，或（会话追问时）clarify。

    hitl 为 app.agent.hitl.TurnCheckpoints：请求可能追问且检查点可用时使用 graph_hitl。
    异常原样抛出，由调用方转为 error 事件。
    """
    start = time.perf_counter()
    rounds = deps.settings.agent_max_refine_rounds
    thread_id = None
    graph = get_graph(rounds)
    if hitl is not None and request_id and wants_hitl(request):
        hitl_graph = await hitl.graph(rounds)
        if hitl_graph is not None:
            graph, thread_id = hitl_graph, thread_id_of(request_id)
            deps.clarify_available = True
    state: dict[str, Any] = {"request": request, "usage": Usage(), "node_traces": []}
    config = thread_config(thread_id or "", rounds)
    try:
        async for item in _drive(graph, dict(state), config, deps, state, 0):
            yield item
    except Exception:
        if thread_id:
            await hitl.delete_thread_quietly(thread_id)
        raise
    async for item in _finish(state, start, thread_id, hitl):
        yield item


async def resume_agent(
    thread_id: str, answer: str, snap: Any, deps: AgentDeps, hitl: Any
) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    """从追问断点继续：snap 为检查点快照（调用方已确认 thread 存在且尚未执行完毕）。

    检查点已越过中断（上次恢复中途失败）时不再传 resume，直接从检查点继续执行。
    """
    start = time.perf_counter()
    rounds = deps.settings.agent_max_refine_rounds
    graph = await hitl.graph(rounds)
    deps.clarify_available = True
    state: dict[str, Any] = dict(snap.values)
    config = thread_config(thread_id, rounds)
    graph_input = Command(resume=answer) if snap.interrupts else None
    async for item in _drive(graph, graph_input, config, deps, state, emitted_node_events(snap.values)):
        yield item
    async for item in _finish(state, start, thread_id, hitl):
        yield item
