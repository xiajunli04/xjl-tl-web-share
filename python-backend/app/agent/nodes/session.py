"""会话相关节点（add-session-context-and-memory D2 / D4）。

- clarify：歧义追问，调用 interrupt 等待用户回答
- memorize：会话记忆压缩，更新摘要与实体表
"""

import asyncio
import logging

from langgraph.types import interrupt

from app.agent import session as session_mod
from app.agent.nodes.base import AgentDeps, Emit, NodeOutput
from app.agent.state import TranslationState
from app.llm.base import ChatRequest
from app.llm.json_mode import json_mode_extra

log = logging.getLogger("app.agent.nodes")

MAX_ANSWER_CHARS = 200


def clarify_payload(state: TranslationState) -> dict:
    amb = state.get("ambiguity") or {}
    return {
        "question": amb.get("question", ""),
        "options": list(amb.get("options") or []),
        "span": amb.get("span", ""),
        "reason": amb.get("reason", ""),
    }


async def clarify(state: TranslationState, deps: AgentDeps, emit: Emit) -> NodeOutput:
    """中断等待用户回答；恢复时节点从头重新执行，interrupt() 直接返回回答。"""
    payload = clarify_payload(state)
    answer = str(interrupt(payload) or "").strip()[:MAX_ANSWER_CHARS]
    clarification = {
        "question": payload["question"],
        "options": payload["options"],
        "span": payload["span"],
        "answer": answer,
    }
    return NodeOutput(
        update={"clarification": clarification, "ambiguity": None},
        summary=f"用户澄清：「{payload['span']}」指「{answer}」",
    )


def should_memorize(state: TranslationState) -> bool:
    """Spring 只在满足压缩条件（滑出窗口且新增 ≥3 轮）时给出 toMemorize；修订轮不压缩。"""
    req = state["request"]
    return req.mode != "revise" and req.session is not None and bool(req.session.to_memorize)


async def memorize(state: TranslationState, deps: AgentDeps, emit: Emit) -> NodeOutput:
    """把滑出窗口的轮次并入摘要并更新实体表；任何失败只记警告，会话记忆保持不变。"""
    req = state["request"]
    session = req.session
    s = deps.settings
    turns = [t for t in session.to_memorize if t.source.strip() or t.target.strip()]
    until = max([t.seq for t in turns if t.seq is not None] or [session.memorized_until])
    messages = session_mod.memorize_messages(
        session.summary,
        session_mod.entity_dicts(session.entities, s.memorize_max_entities),
        turns,
        source_lang=state.get("source_lang") or req.source_lang,
        target_lang=req.target_lang,
        max_chars=s.memorize_summary_max_chars,
        max_entities=s.memorize_max_entities,
    )
    try:
        res = await asyncio.wait_for(
            deps.llm.chat(
                ChatRequest(
                    messages=messages,
                    temperature=0,
                    max_tokens=s.memorize_max_tokens,
                    extra=json_mode_extra(deps.llm),
                )
            ),
            timeout=s.memorize_timeout_seconds,
        )
    except Exception as e:  # noqa: BLE001 - 压缩失败不影响本轮结果
        log.warning("会话记忆压缩失败，保持不变 sessionId=%s: %s", session.session_id, getattr(e, "message", repr(e)))
        return NodeOutput(update={"memory": None}, summary="会话记忆压缩失败，保持不变")
    parsed = session_mod.parse_memory(
        res.content, max_chars=s.memorize_summary_max_chars, max_entities=s.memorize_max_entities
    )
    if parsed is None:
        log.warning("会话记忆压缩输出无法解析，保持不变 sessionId=%s: %.200r", session.session_id, res.content)
        return NodeOutput(update={"memory": None}, summary="会话记忆压缩结果无法解析，保持不变", usage=res.usage)
    summary, entities = parsed
    memory = {"summary": summary, "entities": entities, "memorizedUntil": until}
    emit("memory", memory)
    return NodeOutput(
        update={"memory": memory},
        summary=f"会话记忆已压缩至第 {until} 轮（摘要 {len(summary)} 字，专名 {len(entities)} 条）",
        usage=res.usage,
    )
