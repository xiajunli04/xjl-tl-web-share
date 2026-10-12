"""调用 LLM 的节点：translate / review / refine（design D1）。"""

import logging
from typing import Any

from app.agent import prompts
from app.agent.nodes.base import AgentDeps, AgentError, Emit, NodeOutput, stream_llm_text
from app.agent.nodes.prep import build_context
from app.agent.review_gate import needs_refine
from app.agent.state import (
    REVIEW_CATEGORIES,
    REVIEW_SEVERITIES,
    Review,
    ReviewIssue,
    TranslationState,
)
from app.glossary.matcher import HARD, TermCompliance, check_compliance
from app.llm.base import ChatRequest
from app.llm.json_mode import json_mode_extra, parse_json_object

log = logging.getLogger("app.agent.nodes")


def _context(state: TranslationState, deps: AgentDeps):
    # 快速路径与修订路径不经过 retrieve，按需组装上下文包
    return state.get("context") or build_context(state, deps.settings)


async def translate(state: TranslationState, deps: AgentDeps, emit: Emit) -> NodeOutput:
    req = state["request"]
    ctx = _context(state, deps)
    if state.get("path") == "revise" and req.revise is not None:
        messages = prompts.revise_messages(
            ctx, req.text, req.revise.base_target, req.revise.instruction, state["source_lang"], req.target_lang
        )
        summary = "修订完成"
    else:
        messages = prompts.translate_messages(ctx, req.text, state["source_lang"], req.target_lang)
        summary = "首译完成"
    text, usage = await stream_llm_text(deps, messages, 0, emit)
    if not text.strip():
        raise AgentError("模型未返回译文")
    return NodeOutput(
        update={"draft": text, "round": 0, "reviews": []},
        summary=summary,
        usage=usage,
    )


def _parse_issues(raw: Any) -> list[ReviewIssue]:
    issues = []
    if not isinstance(raw, list):
        return issues
    for item in raw:
        if not isinstance(item, dict):
            continue
        category = str(item.get("category", "")).strip().lower()
        severity = str(item.get("severity", "")).strip().lower()
        issues.append(
            ReviewIssue(
                category=category if category in REVIEW_CATEGORIES else "accuracy",
                severity=severity if severity in REVIEW_SEVERITIES else "minor",
                span=str(item.get("span") or ""),
                suggestion=str(item.get("suggestion") or ""),
            )
        )
    return issues


def parse_review(content: str) -> tuple[int, list[ReviewIssue]] | None:
    """解析评审 JSON；score 缺失或不是数字时视为解析失败。"""
    obj = parse_json_object(content)
    if obj is None:
        return None
    try:
        score = round(float(obj.get("score")))
    except (TypeError, ValueError):
        return None
    return max(0, min(100, score)), _parse_issues(obj.get("issues"))


def _term_violations(state: TranslationState, draft: str) -> list[TermCompliance]:
    """规则化术语检查：译文中缺失目标术语的硬约束命中项。"""
    hits = [h for h in state.get("term_hits") or [] if h.binding == HARD]
    return [c for c in check_compliance(hits, draft) if not c.compliant]


def _rule_term_issues(violations: list[TermCompliance], llm_issues: list[ReviewIssue]) -> list[ReviewIssue]:
    """把术语违规转为评审问题（LLM 已指出的不重复添加）。"""
    return [
        ReviewIssue(
            category="terminology",
            severity="major",
            span=c.source,
            suggestion=f"术语 {c.source} 应译为“{c.target}”",
        )
        for c in violations
        if not any(c.target in i.suggestion for i in llm_issues)
    ]


async def review(state: TranslationState, deps: AgentDeps, emit: Emit) -> NodeOutput:
    req = state["request"]
    round_ = state.get("round", 0)
    draft = state["draft"]
    reviewer = await deps.review_model()
    messages = prompts.review_messages(_context(state, deps), req.text, draft, state["source_lang"], req.target_lang)
    res = await reviewer.client.chat(
        ChatRequest(
            messages=messages,
            temperature=0,
            max_tokens=deps.settings.agent_review_max_tokens,
            extra=json_mode_extra(reviewer.client),
        )
    )
    meta = {"reviewer": reviewer.name, "fallback": reviewer.fallback}
    parsed = parse_review(res.content)
    if parsed is None:
        log.warning("第 %s 轮评审输出无法解析为 JSON，视为通过: %.200r", round_, res.content)
        result = Review(round=round_, score=None, passed=True, parse_failed=True, **meta)
        summary = f"第 {round_} 轮评审结果无法解析，视为通过"
    else:
        score, issues = parsed
        violations = _term_violations(state, draft)
        passed = not needs_refine(score, issues, violations, deps.settings.agent_review_min_score)
        issues += _rule_term_issues(violations, issues)
        result = Review(round=round_, score=score, passed=passed, issues=issues, **meta)
        verdict = "通过" if passed else "未通过"
        count = f"（{len(issues)} 个问题）" if issues else ""
        summary = f"第 {round_} 轮评审 {score} 分，{verdict}{count}"
    if reviewer.fallback:
        summary += "；评审模型不可用，已退回译者模型"
    emit("review", result.to_event())
    return NodeOutput(
        update={"reviews": [*(state.get("reviews") or []), result]},
        summary=summary,
        usage=res.usage,
    )


async def refine(state: TranslationState, deps: AgentDeps, emit: Emit) -> NodeOutput:
    req = state["request"]
    round_ = state.get("round", 0) + 1
    last = (state.get("reviews") or [None])[-1]
    issues = last.issues if last else []
    messages = prompts.refine_messages(
        _context(state, deps), req.text, state["draft"], issues, state["source_lang"], req.target_lang
    )
    text, usage = await stream_llm_text(deps, messages, round_, emit)
    draft = text
    if not text.strip():
        log.warning("第 %s 轮修正未返回内容，保留上一轮译文", round_)
        draft = state["draft"]
    return NodeOutput(
        update={"draft": draft, "round": round_},
        summary=f"第 {round_} 轮修正完成",
        usage=usage,
    )
