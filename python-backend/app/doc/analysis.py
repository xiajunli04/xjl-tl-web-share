"""parse / analyze / align_terms / confirm_terms / plan_chunks 节点（design D5）。"""

import asyncio
import logging
import re
import time
from collections import Counter
from typing import Any

from langgraph.types import interrupt

from app.agent.nodes.base import NodeOutput
from app.agent.state import DEFAULT_DOMAIN
from app.doc import prompts
from app.doc.chunker import chunk_segments, estimate_tokens, plan_groups
from app.doc.llm import call_json, parse_pairs
from app.doc.memory import DocOptions, default_case_sensitive
from app.doc.parser import Segment, parse_document
from app.doc.protect import protect_segment
from app.doc.state import DocDeps, DocPayload, DocState, sum_usage
from app.glossary.matcher import HARD, SOFT, select_glossaries, term_pattern
from app.lang.languages import AUTO, display_name

log = logging.getLogger("app.doc.analysis")

STRATEGY_NAMES = {"serial": "串行", "parallel": "并行", "hybrid": "混合"}
ANALYZE_MAX_TOKENS = 2048
DOMAIN_MAX_CHARS = 16
GENRE_MAX_CHARS = 16


def payload_of(state: DocState) -> DocPayload:
    return DocPayload.model_validate(state["payload"])


def translatable_sources(state: DocState) -> list[str]:
    return [s["source"] for s in state.get("segments") or [] if s["translatable"]]


def plain_body(state: DocState) -> str:
    """用于术语匹配的正文：受保护内容（代码、URL 等）已替换为标记，其中的单词不算术语出现。"""
    return "\n\n".join(
        protect_segment(s["source"], s["blockType"], s["prefix"]).text
        for s in state.get("segments") or []
        if s["translatable"]
    )


def count_occurrences(term: str, text: str, case_sensitive: bool = False) -> int:
    if not term.strip():
        return 0
    return sum(1 for _ in term_pattern(term, case_sensitive).finditer(text))


_ANNOTATED = re.compile(r"^(.+?)\s*[（(]\s*(.+?)\s*[)）]$")


def clean_target(source: str, target: str) -> str:
    """去掉建议译法中附带的原文注释：「Deployment（部署）」「部署（Deployment）」都取「部署」。"""
    m = _ANNOTATED.match(target.strip())
    if not m:
        return target.strip()
    outer, inner = m.group(1).strip(), m.group(2).strip()
    if outer.lower() == source.lower() and inner:
        return inner
    if inner.lower() == source.lower() and outer:
        return outer
    return target.strip()


def candidate_vo(c: dict[str, Any]) -> dict[str, Any]:
    """事件中的候选：{source, target, origin, frequency}（状态中额外保存 type / alts / caseSensitive）。"""
    return {"source": c["source"], "target": c["target"], "origin": c["origin"], "frequency": c["frequency"]}


def term_entry(source: str, target: str, candidates: list[dict[str, Any]], binding: str = HARD) -> dict[str, Any]:
    """任务术语表条目；大小写规则沿用候选（用户新增的术语按源词是否含大写字母判断）。

    binding：hard（术语库命中、用户确认）必须使用；soft（未经确认自动采用的抽取术语）只作参考译法。
    """
    c = next((c for c in candidates if c["source"].lower() == source.lower()), None)
    case = c.get("caseSensitive") if c is not None else None
    return {
        "source": source,
        "target": target,
        "caseSensitive": default_case_sensitive(source) if case is None else case,
        "binding": binding,
    }


# ---------------------------------------------------------------- parse


async def parse(state: DocState, deps: DocDeps) -> NodeOutput:
    payload = payload_of(state)
    segments = parse_document(payload.text, payload.format)
    s = deps.settings
    chunks = chunk_segments(segments, s.doc_chunk_target_tokens, s.doc_chunk_max_tokens)
    body = "\n\n".join(seg.source for seg in segments if seg.translatable)

    detected, confidence, usage = None, None, None
    if payload.source_lang != AUTO:
        source_lang = payload.source_lang
        lang_part = f"源语言为{display_name(source_lang)}（用户指定）"
    elif body.strip():

        async def provider():
            return deps.llm

        result = await deps.detector.detect(body, provider)
        source_lang, detected, confidence, usage = result.lang, result.lang, result.confidence, result.usage
        method = "，LLM 兜底" if result.method == "llm" else ""
        lang_part = f"识别为{display_name(source_lang)}（{round(result.confidence * 100)}%{method}）"
    else:
        source_lang = AUTO
        lang_part = "没有可翻译的正文"

    await deps.emitter.emit(
        "parsed",
        {
            "segments": [seg.to_dict() for seg in segments],
            "chunks": [c.to_event() for c in chunks],
            "detectedLang": detected,
            "confidence": confidence,
        },
    )
    translatable = sum(1 for seg in segments if seg.translatable)
    summary = f"解析 {len(segments)} 段（可翻译 {translatable} 段），切分为 {len(chunks)} 块，{lang_part}"
    update = {
        "segments": [seg.to_dict() for seg in segments],
        "chunks": [c.to_dict() for c in chunks],
        "source_lang": source_lang,
        "detected_lang": detected,
        "confidence": confidence,
    }
    return NodeOutput(update=update, summary=summary, usage=usage)


# ---------------------------------------------------------------- analyze


def _clean_label(v: Any, limit: int) -> str:
    return str(v or "").strip().strip("。.")[:limit]


def _sections(state: DocState, section_tokens: int) -> list[str]:
    """按块把正文分成不超过 section_tokens 的若干部分（块本身不超过分块上限，不会被拆开）。"""
    segs = {s["seq"]: s for s in state.get("segments") or []}
    parts: list[str] = []
    current: list[str] = []
    tokens = 0
    for chunk in state.get("chunks") or []:
        texts = [segs[q]["source"] for q in chunk["segSeqs"] if segs[q]["translatable"]]
        if not texts:
            continue
        t = sum(estimate_tokens(x) for x in texts)
        if current and tokens + t > section_tokens:
            parts.append("\n\n".join(current))
            current, tokens = [], 0
        current.extend(texts)
        tokens += t
    if current:
        parts.append("\n\n".join(current))
    return parts


async def analyze(state: DocState, deps: DocDeps) -> NodeOutput:
    payload = payload_of(state)
    options = DocOptions.from_payload(state["payload"])
    sources = translatable_sources(state)
    user_domain = payload.user_domain
    base = {"summary": None, "domain": user_domain or DEFAULT_DOMAIN, "genre": "", "candidates": []}
    if not sources:
        return NodeOutput(update={**base, "extracted": []}, summary="没有可翻译的正文，跳过分析")
    if not options.global_summary and not options.term_extraction:
        return NodeOutput(update={**base, "extracted": []}, summary="实验选项关闭了全文摘要与术语抽取，跳过分析")

    body = "\n\n".join(sources)
    src, tgt = state["source_lang"], payload.target_lang
    want_summary, want_terms = options.global_summary, options.term_extraction
    s = deps.settings
    if estimate_tokens(body) <= s.doc_summary_single_max_tokens:
        mode = "single"
        obj, usage = await call_json(
            deps,
            prompts.analyze_messages(
                body, want_summary=want_summary, want_terms=want_terms, source_lang=src, target_lang=tgt
            ),
            max_tokens=ANALYZE_MAX_TOKENS,
            temperature=0,
        )
        obj = obj or {}
        summary = str(obj.get("summary") or "").strip() or None
        domain, genre = (
            _clean_label(obj.get("domain"), DOMAIN_MAX_CHARS),
            _clean_label(obj.get("genre"), GENRE_MAX_CHARS),
        )
        extracted = _extracted(obj.get("terms"))
        parts_count = 1
    else:
        mode = "map_reduce"
        parts = _sections(state, s.doc_summary_section_tokens)
        parts_count = len(parts)
        sem = asyncio.Semaphore(max(1, s.doc_summary_concurrency))

        async def run(i: int, text: str):
            async with sem:
                return await call_json(
                    deps,
                    prompts.analyze_messages(
                        text,
                        want_summary=want_summary,
                        want_terms=want_terms,
                        source_lang=src,
                        target_lang=tgt,
                        part=(i + 1, len(parts)),
                    ),
                    max_tokens=ANALYZE_MAX_TOKENS,
                    temperature=0,
                )

        mapped = await asyncio.gather(*(run(i, p) for i, p in enumerate(parts)))
        usages = [u for _, u in mapped]
        objs = [o or {} for o, _ in mapped]
        extracted = _merge_extracted([_extracted(o.get("terms")) for o in objs])
        domains = Counter(_clean_label(o.get("domain"), DOMAIN_MAX_CHARS) for o in objs if o.get("domain"))
        genres = Counter(_clean_label(o.get("genre"), GENRE_MAX_CHARS) for o in objs if o.get("genre"))
        domain = domains.most_common(1)[0][0] if domains else ""
        genre = genres.most_common(1)[0][0] if genres else ""
        summary = None
        if want_summary:
            section_summaries = [str(o.get("summary") or "").strip() for o in objs]
            section_summaries = [x for x in section_summaries if x]
            if section_summaries:
                robj, ru = await call_json(
                    deps, prompts.reduce_messages(section_summaries, src), max_tokens=ANALYZE_MAX_TOKENS, temperature=0
                )
                usages.append(ru)
                robj = robj or {}
                summary = str(robj.get("summary") or "").strip() or None
                domain = _clean_label(robj.get("domain"), DOMAIN_MAX_CHARS) or domain
                genre = _clean_label(robj.get("genre"), GENRE_MAX_CHARS) or genre
        usage = sum_usage(*usages)

    domain = user_domain or domain or DEFAULT_DOMAIN
    parts_desc = []
    if want_summary:
        if summary:
            parts_desc.append("生成全文摘要" if mode == "single" else f"分 {parts_count} 部分摘要后汇总")
        else:
            parts_desc.append("全文摘要未能生成")
    parts_desc.append(f"领域：{domain}" + ("（用户指定）" if user_domain else ""))
    if genre:
        parts_desc.append(f"文体：{genre}")
    if want_terms:
        parts_desc.append(f"抽取 {len(extracted)} 个候选术语")
    update = {"summary": summary, "domain": domain, "genre": genre, "extracted": extracted}
    return NodeOutput(update=update, summary="；".join(parts_desc), usage=usage)


def _extracted(raw: Any) -> list[dict[str, Any]]:
    out = []
    if not isinstance(raw, list):
        return out
    for item in raw:
        if not isinstance(item, dict):
            continue
        source, target = str(item.get("source") or "").strip(), str(item.get("target") or "").strip()
        if not source or not target:
            continue
        kind = "name" if str(item.get("type") or "").strip().lower() == "name" else "term"
        out.append({"source": source, "target": target, "type": kind})
    return out


def _merge_extracted(lists: list[list[dict[str, Any]]]) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    for items in lists:
        for item in items:
            merged.setdefault(item["source"].lower(), item)
    return list(merged.values())


# ---------------------------------------------------------------- align_terms


async def align_terms(state: DocState, deps: DocDeps) -> NodeOutput:
    payload = payload_of(state)
    body = plain_body(state)
    src = state.get("source_lang") or AUTO

    hits = []
    glossary_note = ""
    if payload.glossary_ids and body and src != AUTO:
        loaded = await deps.glossary_repo.load(payload.glossary_ids)
        selection = select_glossaries(payload.glossary_ids, loaded, src, payload.target_lang)
        hits = deps.matcher.match(body, selection.usable)
        if selection.skipped:
            glossary_note = f"，跳过 {len(selection.skipped)} 个语言对不符或不存在的术语库"

    candidates: list[dict[str, Any]] = []
    index: dict[str, dict[str, Any]] = {}
    for h in hits:
        c = {
            "source": h.source,
            "target": h.target,
            "origin": "glossary",
            "frequency": len(h.spans),
            "type": "term",
            "alts": [],
            "caseSensitive": h.case_sensitive,
        }
        candidates.append(c)
        index[h.source.lower()] = c

    extracted_ok: list[dict[str, Any]] = []
    filtered = 0
    for e in state.get("extracted") or []:
        key = e["source"].lower()
        target = clean_target(e["source"], e["target"])
        if key in index:
            # 同一源词以术语库译法（或先出现的抽取结果）为准；其他建议译法留作一致性检查的候选变体
            if target != index[key]["target"] and target not in index[key]["alts"]:
                index[key]["alts"].append(target)
            continue
        case = default_case_sensitive(e["source"])
        freq = count_occurrences(e["source"], body, case)
        if freq == 0 or (freq < 2 and e["type"] != "name"):
            filtered += 1
            continue
        c = {**e, "target": target, "origin": "extracted", "frequency": freq, "alts": [], "caseSensitive": case}
        extracted_ok.append(c)
        index[key] = c
    extracted_ok.sort(key=lambda c: -c["frequency"])
    candidates += extracted_ok

    await deps.emitter.emit(
        "analysis",
        {
            "summary": state.get("summary"),
            "domain": state.get("domain") or DEFAULT_DOMAIN,
            "genre": state.get("genre") or "",
            "candidates": [candidate_vo(c) for c in candidates],
        },
    )
    update: dict[str, Any] = {"candidates": candidates}
    if not payload.confirm_terms:
        # 未经确认：术语库命中为硬约束，抽取候选为软约束（只作参考译法，不强制）
        update["terms"] = [
            term_entry(c["source"], c["target"], candidates, HARD if c["origin"] == "glossary" else SOFT)
            for c in candidates
        ]
    summary = f"术语库命中 {len(hits)} 条，抽取 {len(extracted_ok)} 条，合并后 {len(candidates)} 条候选"
    if filtered:
        summary += f"（过滤低频 {filtered} 条）"
    summary += glossary_note
    if not payload.confirm_terms:
        summary += "；未开启人工确认，自动采用全部候选（抽取术语作为参考译法）"
    return NodeOutput(update=update, summary=summary)


# ---------------------------------------------------------------- confirm_terms


async def confirm_terms(state: DocState, deps: DocDeps) -> NodeOutput:
    """中断等待用户确认；resume 的值为 {terms:[{source, target}]}，即确认后的任务术语表。

    已排除被拒绝项；可能包含用户新增的术语（Spring 侧 origin="user"），同样以 {source, target} 给出。
    """
    candidates = state.get("candidates") or []
    value = interrupt({"candidates": [candidate_vo(c) for c in candidates]})
    raw = value.get("terms") if isinstance(value, dict) else value
    # 用户确认（含修改、新增）的术语全部为硬约束
    terms = [term_entry(a, b, candidates, HARD) for a, b in dict(parse_pairs(raw)).items()]
    await deps.emitter.phase("translating")

    confirmed = {t["source"].lower() for t in terms}
    known = {c["source"].lower() for c in candidates}
    rejected = len(known - confirmed)
    added = len(confirmed - known)
    modified = sum(
        1
        for c in candidates
        for t in terms
        if t["source"].lower() == c["source"].lower() and t["target"] != c["target"]
    )
    summary = f"用户确认 {len(terms)} 条术语，拒绝 {rejected} 条"
    if modified:
        summary += f"，修改译法 {modified} 条"
    if added:
        summary += f"，新增 {added} 条"
    return NodeOutput(update={"terms": terms}, summary=summary)


# ---------------------------------------------------------------- plan_chunks


async def plan_chunks(state: DocState, deps: DocDeps) -> NodeOutput:
    payload = payload_of(state)
    groups = plan_groups(state.get("chunks") or [], payload.strategy)
    summary = f"按{STRATEGY_NAMES[payload.strategy]}策略编排为 {len(groups)} 组"
    return NodeOutput(update={"groups": groups, "translate_started_ms": int(time.time() * 1000)}, summary=summary)


def segment_map(state: DocState) -> dict[int, Segment]:
    return {s["seq"]: Segment.from_dict(s) for s in state.get("segments") or []}
