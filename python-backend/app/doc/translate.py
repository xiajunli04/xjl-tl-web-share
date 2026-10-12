"""translate_group 节点（design D5）：每组一个 Send，组内按顺序逐块执行。

单块流程：检查 ``ai.doc_chunk_result`` 缓存 → 组装上下文 → 按段检索翻译记忆（options.translationMemory）→
JSON 翻译（按段 id 返回）→ 缺段逐段补译 →
⟦n⟧ 标记还原（失败的段单独重译一次，仍失败则保留原文）→ 规则术语检查（只针对硬约束术语）→
评审（options.review，使用评审模型）→ 按严重度规则（app.agent.review_gate）最多 doc_max_refine_rounds 轮修正
（使用译者模型）→ 更新滚动专名表 → 写缓存 → 发出 chunk_done 与 trace。
"""

import logging
import time
from dataclasses import dataclass
from typing import Any

from langgraph.runtime import Runtime

from app.agent.nodes.llm import _parse_issues
from app.agent.review_gate import needs_refine, severity_counts
from app.agent.state import TranslationContext
from app.doc import prompts
from app.doc.llm import DocTaskError, call_json, parse_pairs, parse_segments
from app.doc.memory import (
    ChunkMemory,
    DocOptions,
    RollingNames,
    build_memory,
    chunk_context,
    hard_hits,
    term_hits,
    terms_for_text,
)
from app.doc.parser import Segment
from app.doc.protect import Protected, protect_segment, restore
from app.doc.state import DocDeps, GroupInput, add_usage_dict, sum_usage, usage_dict
from app.glossary.matcher import TermCompliance, TermHit, check_compliance, term_present
from app.llm.base import LLMClient, Usage
from app.llm.reviewer import ReviewModel
from app.memory.tm import TmHit, plain_text

log = logging.getLogger("app.doc.translate")

REVIEW_MAX_TOKENS = 1024
REVIEW_MODEL_NODE = "review_model"  # 评审模型退回译者模型时的警告轨迹节点名
ZERO_USAGE = {"promptTokens": 0, "completionTokens": 0}


@dataclass
class SegWork:
    seg: Segment
    protected: Protected
    draft: str = ""  # 带标记的译文
    final: str = ""  # 还原后的译文
    failed: bool = False  # 标记还原失败，保留原文
    problem: str = ""


@dataclass
class ChunkEnv:
    deps: DocDeps
    ctx: TranslationContext
    memory: ChunkMemory
    hits: list[TermHit]
    source_lang: str
    target_lang: str
    options: DocOptions
    usage: Usage

    def add(self, u: Usage | None) -> None:
        self.usage = sum_usage(self.usage, u)


async def translate_group(gi: GroupInput, runtime: Runtime[DocDeps]) -> dict[str, Any]:
    deps = runtime.context
    await deps.emitter.phase("translating")
    rolling = RollingNames()
    prev: list[tuple[str, str]] = []
    results: list[dict[str, Any]] = []
    total: dict[str, int] = {}
    async with deps.chunk_semaphore:
        for idx in gi["chunk_ids"]:
            result = await process_chunk(gi, idx, rolling, prev, deps)
            results.append(result)
            total = add_usage_dict(total, result.get("usage"))
            rolling.update(tuple(p) for p in result.get("names") or [])
            pairs = [
                (gi["segments"][str(s["seq"])]["source"], s["target"])
                for s in result.get("segments") or []
                if str(s["seq"]) in gi["segments"]
            ]
            if pairs:
                prev = pairs[-2:]
    return {"chunk_results": results, "usage": total}


def _chunk_result(idx: int, **kw: Any) -> dict[str, Any]:
    base = {
        "index": idx,
        "segments": [],
        "names": [],
        "latencyMs": 0,
        "cached": False,
        "reviewScore": None,
        "firstScore": None,
        "reviewRounds": 0,
        "reviewIssues": None,  # 最后一次评审的问题按严重度计数；未评审或评审无法解析时为 None
        "retranslated": 0,
        "protectionFailures": [],
        "tmHits": [],  # 本块命中的翻译记忆 [{seq, fuzzy, semantic, origin}]
    }
    base.update(kw)
    return base


async def process_chunk(
    gi: GroupInput, idx: int, rolling: RollingNames, prev: list[tuple[str, str]], deps: DocDeps
) -> dict[str, Any]:
    task_id = gi["task_id"]
    label = f"第 {idx + 1}/{gi['total_chunks']} 块"
    emitter = deps.emitter

    cached = await deps.store.get(task_id, idx)
    if cached is not None:
        await emitter.emit(
            "chunk_done",
            {
                "chunk": idx,
                "segments": cached.get("segments") or [],
                "usage": ZERO_USAGE,
                "latencyMs": 0,
                "cached": True,
                "reviewIssues": cached.get("reviewIssues"),
            },
        )
        await emitter.trace("translate_chunk", "skipped", f"{label}：命中分块缓存，未调用 LLM", chunk=idx)
        return {**cached, "index": idx, "cached": True}

    chunk = gi["chunks"][str(idx)]
    segs = [Segment.from_dict(gi["segments"][str(q)]) for q in chunk["segSeqs"]]
    work = [SegWork(s, protect_segment(s.source, s.block_type, s.prefix)) for s in segs if s.translatable]
    if not work:
        result = _chunk_result(idx)
        await deps.store.put(task_id, idx, result, ZERO_USAGE)
        await emitter.emit(
            "chunk_done",
            {"chunk": idx, "segments": [], "usage": ZERO_USAGE, "latencyMs": 0, "cached": False, "reviewIssues": None},
        )
        await emitter.trace("translate_chunk", "skipped", f"{label}：无可翻译内容，跳过", chunk=idx, latency_ms=0)
        return {**result, "usage": ZERO_USAGE}

    start = time.perf_counter()
    payload = gi["payload"]
    options = DocOptions.from_payload(payload)
    s = deps.settings
    hits = term_hits(gi["terms"])
    chunk_text = "\n".join(w.seg.source for w in work)
    env = ChunkEnv(
        deps=deps,
        ctx=chunk_context(
            hits,
            chunk_text,
            domain=gi["domain"],
            style=payload.get("style") or "faithful",
            max_terms=s.doc_prompt_max_terms,
        ),
        memory=build_memory(
            options, summary=gi["summary"], names=rolling, prev_pairs=prev, max_names=s.doc_prompt_max_names
        ),
        hits=hits,
        source_lang=gi["source_lang"],
        target_lang=payload["targetLang"],
        options=options,
        usage=Usage(),
    )

    # 0. 按段检索翻译记忆（每段最佳 1 条，全块最多 8 条，按得分排序写入提示词）
    tm_hits, tm_note = await _search_tm(deps, gi, work, options)
    ranked = sorted(tm_hits.values(), key=lambda h: (h.score, h.fuzzy), reverse=True)
    env.memory.tm = [(h.source, h.target) for h in ranked]

    # 1. 整块翻译；输出完全不可用时整块重试一次
    items = [{"id": w.seg.seq, "text": w.protected.text} for w in work]
    messages = prompts.translate_messages(env.ctx, env.memory, items, env.source_lang, env.target_lang)
    obj, u = await call_json(deps, messages)
    env.add(u)
    got = parse_segments(obj)
    if not got:
        log.warning("%s 的翻译输出不可用，整块重试一次", label)
        obj, u = await call_json(deps, messages)
        env.add(u)
        got = parse_segments(obj)
    names = parse_pairs((obj or {}).get("names"))

    # 2. 缺失的段落逐段补译
    retranslated = 0
    for w in work:
        if w.seg.seq in got:
            continue
        text = await _translate_single(env, w)
        if text is None:
            raise DocTaskError(f"{label}的第 {w.seg.seq} 段补译失败")
        got[w.seg.seq] = text
        retranslated += 1
    for w in work:
        w.draft = got[w.seg.seq]

    # 3. 标记还原；失败的段单独重译一次，仍失败则保留原文
    for w in work:
        r = restore(w.draft, w.protected.spans)
        if r.ok:
            w.final = r.text
            continue
        text = await _translate_single(env, w)
        r2 = restore(text, w.protected.spans) if text is not None else None
        if r2 is not None and r2.ok:
            w.draft, w.final = text, r2.text
            retranslated += 1
            continue
        log.warning("%s 第 %s 段保护标记还原失败（%s），保留原文", label, w.seg.seq, r.problem)
        w.failed, w.final, w.draft, w.problem = True, w.seg.source, w.protected.text, r.problem

    # 4. 评审与修正：评审使用评审模型，修正使用译者模型；按严重度规则决定是否修正（design D5）
    first_score = score = None
    review_issues: dict[str, int] | None = None
    rounds = 0
    ok_work = [w for w in work if not w.failed]
    if options.review and ok_work:
        reviewer = await _reviewer(deps)
        score, issues = await _review(env, ok_work, reviewer.client)
        first_score = score
        rule = _rule_issues(env, ok_work)
        while rounds < s.doc_max_refine_rounds and needs_refine(score, issues, rule, s.agent_review_min_score):
            await _refine(env, ok_work, issues + rule)
            rounds += 1
            score, issues = await _review(env, ok_work, reviewer.client)
            rule = _rule_issues(env, ok_work)
        review_issues = severity_counts(issues) if score is not None else None

    # 5. 术语遵循、滚动专名
    out_segments = []
    for w in work:
        compliance = _compliance(hits, w)
        out_segments.append(
            {
                "seq": w.seg.seq,
                "target": w.final,
                "reviewScore": score,
                "reviewRounds": rounds,
                "compliance": [c.to_event() for c in compliance],
                "tmHits": [tm_hits[w.seg.seq].to_vo()] if w.seg.seq in tm_hits else [],
            }
        )
    names = [[a, b] for a, b in names if term_present(a, chunk_text)]
    latency = int((time.perf_counter() - start) * 1000)
    usage = usage_dict(env.usage)
    result = _chunk_result(
        idx,
        segments=out_segments,
        names=names,
        latencyMs=latency,
        reviewScore=score,
        firstScore=first_score,
        reviewRounds=rounds,
        reviewIssues=review_issues,
        retranslated=retranslated,
        protectionFailures=[{"seq": w.seg.seq, "problem": w.problem} for w in work if w.failed],
        tmHits=[
            {"seq": seq, "fuzzy": round(h.fuzzy, 4), "semantic": round(h.semantic, 4), "origin": h.origin}
            for seq, h in sorted(tm_hits.items())
        ],
    )
    await deps.store.put(task_id, idx, result, usage)
    await emitter.emit(
        "chunk_done",
        {
            "chunk": idx,
            "segments": out_segments,
            "usage": usage,
            "latencyMs": latency,
            "cached": False,
            "reviewIssues": review_issues,
        },
    )
    await emitter.trace(
        "translate_chunk",
        "completed",
        _summary(label, work, first_score, score, rounds, retranslated, options, review_issues, tm_note),
        chunk=idx,
        latency_ms=latency,
        usage=usage,
    )
    return {**result, "usage": usage}


async def _search_tm(
    deps: DocDeps, gi: GroupInput, work: list[SegWork], options: DocOptions
) -> tuple[dict[int, TmHit], str | None]:
    """按段检索翻译记忆；关闭、未配置或失败时按无命中处理（不让任务失败）。返回 ({seq: hit}, 摘要片段)。"""
    user_id = gi["payload"].get("userId")
    if not options.translation_memory or deps.tm is None or not user_id:
        return {}, None
    segments = [(w.seg.seq, plain_text(w.seg.source)) for w in work]
    try:
        available, hits = await deps.tm.search_segments(
            int(user_id), segments, gi["source_lang"], gi["payload"]["targetLang"]
        )
    except Exception as e:  # noqa: BLE001
        log.warning("翻译记忆检索失败，按无命中处理: %s", e)
        return {}, "翻译记忆检索失败"
    if not available:
        return {}, "翻译记忆不可用"
    if not hits:
        return {}, None
    return hits, f"命中 {len(hits)} 条翻译记忆"


def _summary(
    label,
    work,
    first_score,
    score,
    rounds,
    retranslated,
    options: DocOptions,
    review_issues: dict | None = None,
    tm_note: str | None = None,
) -> str:
    parts = [f"{label}：翻译 {len(work)} 段"]
    if not options.review:
        parts[0] += "（未评审）"
    elif score is None and first_score is None:
        parts.append("评审结果无法解析")
    elif rounds:
        parts.append(
            f"评审 {first_score if first_score is not None else '-'}→{score if score is not None else '-'} 分"
            f"（修正 {rounds} 轮）"
        )
    else:
        parts.append(f"评审 {score} 分")
    if review_issues is not None:
        parts.append("问题 " + " / ".join(f"{k} {v}" for k, v in review_issues.items()))
    if retranslated:
        parts.append(f"补译或重译 {retranslated} 段")
    failed = sum(1 for w in work if w.failed)
    if failed:
        parts.append(f"{failed} 段保护标记还原失败，保留原文")
    if tm_note:
        parts.append(tm_note)
    return "，".join(parts)


async def _translate_single(env: ChunkEnv, w: SegWork) -> str | None:
    items = [{"id": w.seg.seq, "text": w.protected.text}]
    obj, u = await call_json(
        env.deps, prompts.translate_messages(env.ctx, env.memory, items, env.source_lang, env.target_lang)
    )
    env.add(u)
    got = parse_segments(obj)
    if w.seg.seq in got:
        return got[w.seg.seq]
    if len(got) == 1:  # 单段输入时容忍模型写错 id
        return next(iter(got.values()))
    return None


def _compliance(hits: list[TermHit], w: SegWork) -> list[TermCompliance]:
    """术语遵循：只统计硬约束术语；在带标记的原文与译文上匹配，代码、URL 等受保护内容中的单词不计入。"""
    return check_compliance(terms_for_text(hard_hits(hits), w.protected.text), w.draft)


def _rule_issues(env: ChunkEnv, work: list[SegWork]) -> list[dict[str, Any]]:
    """规则化术语检查：译文中缺失硬约束术语译法的段落（软约束术语不参与）。"""
    issues = []
    for w in work:
        for c in _compliance(env.hits, w):
            if not c.compliant:
                issues.append(
                    {
                        "id": w.seg.seq,
                        "category": "terminology",
                        "severity": "major",
                        "span": c.source,
                        "suggestion": f"术语 {c.source} 应译为“{c.target}”",
                    }
                )
    return issues


async def _reviewer(deps: DocDeps) -> ReviewModel:
    """取评审模型；指定的评审模型不可用而退回译者模型时，每次执行只记录一条警告轨迹。"""
    model = await deps.review_model()
    if model.fallback and not deps.review_fallback_traced:
        deps.review_fallback_traced = True
        name = f"（{model.name}）" if model.name else ""
        await deps.emitter.trace(
            REVIEW_MODEL_NODE,
            "completed",
            f"警告：评审模型（id={model.config_id}）不可用（{model.error}），评审已退回译者模型{name}",
        )
    return model


async def _review(
    env: ChunkEnv, work: list[SegWork], client: LLMClient | None = None
) -> tuple[int | None, list[dict[str, Any]]]:
    items = [{"id": w.seg.seq, "source": w.protected.text, "translation": w.draft} for w in work]
    obj, u = await call_json(
        env.deps,
        prompts.review_messages(env.ctx, items, env.source_lang, env.target_lang),
        max_tokens=REVIEW_MAX_TOKENS,
        temperature=0,
        client=client,
    )
    env.add(u)
    if not obj:
        return None, []
    try:
        score = max(0, min(100, round(float(obj.get("score")))))
    except (TypeError, ValueError):
        return None, []
    raw = obj.get("issues") if isinstance(obj.get("issues"), list) else []
    parsed = _parse_issues(raw)
    issues = []
    for item, issue in zip([r for r in raw if isinstance(r, dict)], parsed, strict=False):
        d = {"category": issue.category, "severity": issue.severity, "span": issue.span, "suggestion": issue.suggestion}
        if item.get("id") is not None:
            d = {"id": item.get("id"), **d}
        issues.append(d)
    return score, issues


async def _refine(env: ChunkEnv, work: list[SegWork], issues: list[dict[str, Any]]) -> None:
    """修正一轮：只采纳标记校验通过的段落，其余保留上一版译文。"""
    items = [{"id": w.seg.seq, "source": w.protected.text, "translation": w.draft} for w in work]
    obj, u = await call_json(
        env.deps, prompts.refine_messages(env.ctx, items, issues, env.source_lang, env.target_lang)
    )
    env.add(u)
    got = parse_segments(obj)
    for w in work:
        text = got.get(w.seg.seq)
        if text is None:
            continue
        r = restore(text, w.protected.spans)
        if r.ok:
            w.draft, w.final = text, r.text
