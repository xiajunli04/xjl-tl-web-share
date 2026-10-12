"""consistency 与 finalize 节点（design D5 / D8）。

检查对象：任务术语表（确认后的）加上滚动专名表中出现在 2 段及以上的专名。

- 变体：任务术语表的译法、抽取时的建议译法、各块上报的专名译法，以及原样保留的源词本身
- 检测：对每个源词，找出原文含该词的段落；译文包含选定译法的视为一致；不包含选定译法、但包含其他变体的视为不一致
- 选定：硬约束术语以任务术语表的译法为准；软约束术语与专名取使用段数最多的变体，
  平票时软约束的参考译法优先（参考译法排在变体列表首位）
- 修正：按段批量（每次最多 doc_fix_batch_size 段）定向改写，结果必须包含选定译法且标记还原成功，否则记为未解决
"""

import logging
import time
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from app.agent.nodes.base import NodeOutput
from app.doc import prompts
from app.doc.llm import call_json, parse_segments
from app.doc.memory import default_case_sensitive, hard_hits, term_hits, terms_for_text
from app.doc.protect import plain_text, protect, protect_segment, restore
from app.doc.state import DocDeps, DocState, sum_usage, usage_dict
from app.glossary.matcher import SOFT, term_present
from app.llm.base import LLMError, Usage

log = logging.getLogger("app.doc.consistency")


@dataclass
class CheckItem:
    term: str
    chosen: str | None  # None：没有硬约束规定（软约束术语或专名），取多数
    variants: list[str] = field(default_factory=list)  # 其他候选译法（按出现顺序）
    case_sensitive: bool = False

    def uses(self, text: str, variant: str) -> bool:
        """译文是否使用了某个变体；原样保留的源词沿用该术语的大小写规则。"""
        cs = self.case_sensitive if variant.lower() == self.term.lower() else False
        return term_present(variant, text, cs)


def _plain_source(seg: dict[str, Any]) -> str:
    return protect_segment(seg["source"], seg["blockType"], seg["prefix"]).text


def collect_targets(state: DocState) -> tuple[dict[int, str], set[int], list[dict[str, Any]]]:
    """返回 (seq -> 译文, 保护标记失败的段, 失败明细)，并应用一致性阶段的修正。"""
    targets: dict[int, str] = {}
    failed: set[int] = set()
    failures: list[dict[str, Any]] = []
    for r in sorted(state.get("chunk_results") or [], key=lambda x: x["index"]):
        for s in r.get("segments") or []:
            targets[s["seq"]] = s["target"]
        for pf in r.get("protectionFailures") or []:
            failed.add(pf["seq"])
            failures.append(pf)
    for k, v in (state.get("final_targets") or {}).items():
        targets[int(k)] = v
    return targets, failed, failures


def _check_items(state: DocState, sources: dict[int, str]) -> list[CheckItem]:
    hits = term_hits(state.get("terms") or [])
    term_keys = {h.source.lower() for h in hits}
    candidates = {c["source"].lower(): c for c in state.get("candidates") or []}
    reported: dict[str, tuple[str, list[str]]] = {}  # 源词小写 -> (源词, 各块上报的译法，按顺序去重)
    for r in sorted(state.get("chunk_results") or [], key=lambda x: x["index"]):
        for source, target in r.get("names") or []:
            entry = reported.setdefault(source.lower(), (source, []))
            if target not in entry[1]:
                entry[1].append(target)

    items: list[CheckItem] = []
    for h in hits:
        key = h.source.lower()
        variants: list[str] = []
        c = candidates.get(key)
        if c:
            variants += [c["target"], *c.get("alts", [])]
        variants += reported.get(key, ("", []))[1]
        if h.source != h.target:
            variants.append(h.source)
        if h.binding == SOFT:
            # 软约束：参考译法只作为变体之一（排在首位，平票时优先），按多数决定
            variants = [v for v in dict.fromkeys([h.target, *variants]) if v]
            items.append(CheckItem(h.source, None, variants, h.case_sensitive))
            continue
        variants = [v for v in dict.fromkeys(variants) if v and v != h.target]
        items.append(CheckItem(h.source, h.target, variants, h.case_sensitive))

    for key, (source, targets) in reported.items():
        if key in term_keys or len(targets) < 2:
            continue
        case = default_case_sensitive(source)
        occurrences = sum(1 for text in sources.values() if term_present(source, text, case))
        if occurrences >= 2:
            items.append(CheckItem(source, None, targets, case))
    return items


async def consistency(state: DocState, deps: DocDeps) -> NodeOutput:
    segments = {s["seq"]: s for s in state.get("segments") or []}
    targets, failed, failures = collect_targets(state)
    seqs = [q for q in sorted(targets) if q not in failed]
    # 术语匹配在带标记的文本上进行：代码、URL 等受保护内容中的单词不算术语出现
    sources = {q: _plain_source(segments[q]) for q in seqs}
    src_lang, tgt_lang = state.get("source_lang") or "auto", state["payload"]["targetLang"]

    issues: list[dict[str, Any]] = []
    fixed_targets: dict[int, str] = {}
    usage = Usage()
    for item in _check_items(state, sources):
        related = [q for q in seqs if term_present(item.term, sources[q], item.case_sensitive)]
        if not related:
            continue
        current = {q: fixed_targets.get(q, targets[q]) for q in related}
        all_variants = ([item.chosen] if item.chosen else []) + item.variants
        used: dict[int, str | None] = {}
        for q in related:
            text = plain_text(current[q])
            if item.chosen and item.uses(text, item.chosen):
                used[q] = item.chosen
                continue
            # 长的变体优先，避免短变体是长变体子串时误判
            used[q] = next((v for v in sorted(all_variants, key=len, reverse=True) if item.uses(text, v)), None)
        counts = Counter(v for v in used.values() if v is not None)
        chosen = item.chosen
        if chosen is None:
            if not counts:
                continue
            order = {v: i for i, v in enumerate(all_variants)}
            chosen = max(counts, key=lambda v: (counts[v], -order.get(v, 0)))
        bad = [q for q in related if used[q] is not None and used[q] != chosen]
        if not bad:
            continue
        others = [v for v in all_variants if v != chosen]
        fixed, unresolved, u = await _fix(deps, item.term, chosen, others, bad, segments, current, src_lang, tgt_lang)
        usage = sum_usage(usage, u)
        fixed_targets.update(fixed)
        variant_list = [
            {"text": v, "count": counts[v]} for v in sorted(counts, key=lambda v: (-counts[v], v != chosen))
        ]
        if chosen not in counts:
            variant_list.insert(0, {"text": chosen, "count": 0})
        issues.append(
            {
                "term": item.term,
                "variants": variant_list,
                "chosen": chosen,
                "fixedSegs": sorted(fixed),
                "unresolvedSegs": sorted(unresolved),
            }
        )

    data: dict[str, Any] = {
        "issues": issues,
        "segments": [{"seq": q, "target": t} for q, t in sorted(fixed_targets.items())],
    }
    if failures:
        data["protectionFailures"] = failures
    await deps.emitter.emit("consistency", data)

    report = {"issues": issues, "protectionFailures": failures}
    fixed_count = sum(len(i["fixedSegs"]) for i in issues)
    unresolved_count = sum(len(i["unresolvedSegs"]) for i in issues)
    if issues:
        summary = f"发现 {len(issues)} 处不一致，已修正 {fixed_count} 段"
        if unresolved_count:
            summary += f"，{unresolved_count} 段未能自动修正"
    else:
        summary = "未发现不一致"
    if failures:
        summary += f"；{len(failures)} 段保护标记还原失败，保留原文"
    translate_ms = max(0, int(time.time() * 1000) - int(state.get("translate_started_ms") or time.time() * 1000))
    update = {
        "consistency": report,
        "final_targets": {str(q): t for q, t in fixed_targets.items()},
        "elapsed_ms": translate_ms,
    }
    return NodeOutput(update=update, summary=summary, usage=usage if fixed_targets or issues else None)


async def _fix(
    deps: DocDeps,
    term: str,
    chosen: str,
    others: list[str],
    seqs: list[int],
    segments: dict[int, dict[str, Any]],
    current: dict[int, str],
    src_lang: str,
    tgt_lang: str,
) -> tuple[dict[int, str], list[int], Usage]:
    fixed: dict[int, str] = {}
    unresolved: list[int] = []
    usage = Usage()
    size = max(1, deps.settings.doc_fix_batch_size)
    for i in range(0, len(seqs), size):
        batch = seqs[i : i + size]
        protected_targets = {q: protect(current[q]) for q in batch}
        items = [
            {"id": q, "source": _plain_source(segments[q]), "translation": protected_targets[q].text} for q in batch
        ]
        try:
            obj, u = await call_json(deps, prompts.fix_messages(term, chosen, others, items, src_lang, tgt_lang))
        except LLMError as e:
            log.warning("一致性修正调用失败，标记为未解决: %s", e.message)
            unresolved += batch
            continue
        usage = sum_usage(usage, u)
        got = parse_segments(obj)
        for q in batch:
            text = got.get(q)
            r = restore(text, protected_targets[q].spans) if text is not None else None
            if r is not None and r.ok and term_present(chosen, plain_text(r.text)):
                fixed[q] = r.text
            else:
                unresolved.append(q)
    return fixed, unresolved, usage


async def finalize(state: DocState, deps: DocDeps) -> NodeOutput:
    segments = {s["seq"]: s for s in state.get("segments") or []}
    targets, failed, _ = collect_targets(state)
    hits = hard_hits(term_hits(state.get("terms") or []))  # 遵循统计只针对硬约束术语
    ok = total = 0
    for q, target in targets.items():
        plain_target = plain_text(target)
        for h in terms_for_text(hits, _plain_source(segments[q])):
            total += 1
            ok += term_present(h.target, plain_target, h.case_sensitive)
    results = state.get("chunk_results") or []
    stats = {
        "chunks": len(state.get("chunks") or []),
        "cachedChunks": sum(1 for r in results if r.get("cached")),
        "refined": sum(1 for r in results if (r.get("reviewRounds") or 0) > 0),
        "compliance": {"ok": ok, "total": total},
    }
    usage = state.get("usage") or usage_dict(None)
    latency = int(state.get("elapsed_ms") or 0)
    await deps.emitter.emit("completed", {"usage": usage, "latencyMs": latency, "stats": stats})
    return NodeOutput(update={}, summary=f"完成：{stats['chunks']} 块，术语遵循 {ok}/{total}")
