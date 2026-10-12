"""不调用（或仅兜底调用）LLM 的节点：analyze / plan / retrieve / finalize（design D1）。

plan 在会话追问条件满足时把领域判定与歧义检查合并为一次 JSON 调用（add-session-context-and-memory D4）；
retrieve 检索翻译记忆并在节点事件 detail 中给出命中明细（D7）。
"""

import logging
import re
from typing import Any

from app.agent import prompts
from app.agent import session as session_mod
from app.agent.nodes.base import AgentDeps, Emit, NodeOutput
from app.agent.state import (
    DEFAULT_DOMAIN,
    STYLE_NAMES,
    TextFeatures,
    TranslateRequest,
    TranslationContext,
    TranslationState,
)
from app.core.config import Settings
from app.core.errors import BizException
from app.glossary.matcher import check_compliance, select_glossaries
from app.lang.languages import AUTO, display_name
from app.llm.base import ChatRequest, LLMError, Usage
from app.llm.json_mode import json_mode_extra, parse_json_object
from app.memory.tm import TmHit

log = logging.getLogger("app.agent.nodes")

DOMAIN_MAX_TOKENS = 32
DOMAIN_MAX_CHARS = 16

_PLACEHOLDER_RE = re.compile(
    r"\{\{[^{}\n]+\}\}"  # {{var}}
    r"|\$\{[^{}\n]+\}"  # ${var}
    r"|\{[A-Za-z_][\w.]*\}|\{\d+\}"  # {name} / {0}
    r"|%(?:\d+\$)?[-+ 0#]?\d*(?:\.\d+)?[sdifuxXeEgGc@]"  # printf 风格
)
_URL_RE = re.compile(r"https?://[^\s<>\"']+|www\.[^\s<>\"']+", re.IGNORECASE)
_CODE_RE = re.compile(r"```|`[^`\n]+`")
_DOMAIN_STRIP = re.compile(r"[\s\"'“”‘’「」『』《》。，、；：！？.,;:!?()（）\[\]【】*#`]")


def analyze_features(text: str) -> TextFeatures:
    return TextFeatures(
        length=len(text),
        placeholders=list(dict.fromkeys(_PLACEHOLDER_RE.findall(text))),
        urls=list(dict.fromkeys(_URL_RE.findall(text))),
        has_code=bool(_CODE_RE.search(text)),
    )


def _pct(confidence: float) -> str:
    return f"{round(confidence * 100)}%"


async def analyze(state: TranslationState, deps: AgentDeps, emit: Emit) -> NodeOutput:
    req = state["request"]
    parts: list[str] = []
    update: dict = {"detected_lang": None, "detect_confidence": None, "detect_method": None}
    usage = None

    if req.source_lang == AUTO:

        async def provider():
            return deps.llm

        result = await deps.detector.detect(req.text, provider)
        emit("detect", {"lang": result.lang, "confidence": result.confidence, "method": result.method})
        source_lang = result.lang
        usage = result.usage
        update.update(detected_lang=result.lang, detect_confidence=result.confidence, detect_method=result.method)
        method = "，LLM 兜底" if result.method == "llm" else ""
        parts.append(f"识别为{display_name(source_lang)}（{_pct(result.confidence)}{method}）")
    else:
        source_lang = req.source_lang
        origin = "沿用原记录" if req.mode == "revise" else "用户指定"
        parts.append(f"源语言为{display_name(source_lang)}（{origin}）")
    if source_lang == req.target_lang:
        parts[-1] += "，与目标语言相同"

    hits, skipped = [], []
    if req.glossary_ids:
        loaded = await deps.glossary_repo.load(req.glossary_ids)
        selection = select_glossaries(req.glossary_ids, loaded, source_lang, req.target_lang)
        hits = deps.matcher.match(req.text, selection.usable)
        skipped = selection.skipped
        emit("terms", {"hits": [h.to_event() for h in hits], "skippedGlossaries": skipped})
        parts.append(f"命中 {len(hits)} 条术语" if hits else "未命中术语")
        if selection.mismatched:
            parts.append(f"跳过 {len(selection.mismatched)} 个语言对不符的术语库")
        if selection.unavailable:
            parts.append(f"{len(selection.unavailable)} 个术语库不存在或已删除")
    else:
        parts.append("未选择术语库")

    features = analyze_features(req.text)
    protected = []
    if features.placeholders:
        protected.append(f"占位符 {len(features.placeholders)} 个")
    if features.urls:
        protected.append(f"URL {len(features.urls)} 个")
    if features.has_code:
        protected.append("代码")
    if protected:
        parts.append("含" + "、".join(protected))

    update.update(source_lang=source_lang, term_hits=hits, skipped_glossaries=skipped, features=features)
    return NodeOutput(update=update, summary="，".join(parts), usage=usage)


async def _judge_domain(deps: AgentDeps, text: str):
    """LLM 用一句话判定领域；失败时按通用处理，不中断翻译。"""
    try:
        res = await deps.llm.chat(
            ChatRequest(messages=prompts.domain_messages(text), temperature=0, max_tokens=DOMAIN_MAX_TOKENS)
        )
    except (LLMError, BizException) as e:
        log.warning("领域判定失败，按通用处理: %s", getattr(e, "message", e))
        return None, None
    first_line = (res.content or "").strip().splitlines()[0] if (res.content or "").strip() else ""
    domain = _DOMAIN_STRIP.sub("", first_line)[:DOMAIN_MAX_CHARS]
    return (domain or DEFAULT_DOMAIN), res.usage


def clarify_wanted(req: TranslateRequest, deps: AgentDeps) -> bool:
    """歧义检查的前提（design D4）：会话请求、允许追问、带检查点执行、原文不超过 500 字符（路径另行判断）。"""
    s = req.session
    return (
        deps.clarify_available
        and s is not None
        and s.clarify_enabled
        and req.mode != "revise"
        and len(req.text) <= deps.settings.clarify_max_chars
    )


async def _judge_with_ambiguity(
    deps: AgentDeps, state: TranslationState, want_domain: bool
) -> tuple[str | None, dict[str, Any] | None, Usage | None, bool]:
    """领域判定与歧义检查合并为一次 JSON 调用；返回 (领域, 歧义, usage, 调用是否成功)。失败时按无歧义处理。"""
    req = state["request"]
    messages = session_mod.clarify_messages(
        req.text,
        want_domain=want_domain,
        session_text=session_mod.session_brief(req.session, deps.settings),
        source_lang=state.get("source_lang") or req.source_lang,
        target_lang=req.target_lang,
    )
    try:
        res = await deps.llm.chat(
            ChatRequest(
                messages=messages,
                temperature=0,
                max_tokens=deps.settings.clarify_max_tokens,
                extra=json_mode_extra(deps.llm),
            )
        )
    except (LLMError, BizException) as e:
        log.warning("领域与歧义判定失败，按通用、无歧义处理: %s", getattr(e, "message", e))
        return None, None, None, False
    obj = parse_json_object(res.content)
    if obj is None:
        log.warning("领域与歧义判定输出无法解析，按无歧义处理: %.200r", res.content)
        return None, None, res.usage, False
    domain = session_mod.parse_domain(obj, lambda s: _DOMAIN_STRIP.sub("", s)) if want_domain else None
    return domain, session_mod.parse_ambiguity(obj), res.usage, True


async def plan(state: TranslationState, deps: AgentDeps, emit: Emit) -> NodeOutput:
    req = state["request"]
    settings = deps.settings
    hits = state.get("term_hits") or []
    n = len(req.text)

    if req.mode == "revise":
        path, reason = "revise", "修订：按用户要求修改已有译文，跳过检索与评审"
    elif req.mode == "fast":
        path, reason = "fast", "用户指定快速模式"
    elif req.mode == "standard":
        path, reason = "standard", "用户指定标准模式"
    else:
        reasons = []
        if n > settings.agent_fast_path_max_chars:
            reasons.append(f"文本较长（{n} 字符）")
        if hits:
            reasons.append(f"命中 {len(hits)} 条术语")
        if req.style != "faithful":
            reasons.append(f"风格为{STYLE_NAMES[req.style]}")
        if clarify_wanted(req, deps):
            # 会话允许追问时，歧义检查依附于标准路径的 plan 调用；auto 下若走快速路径，追问能力形同虚设
            reasons.append("会话允许歧义追问")
        if reasons:
            path, reason = "standard", "，".join(reasons) + "，选择标准路径"
        else:
            path, reason = "fast", f"文本较短（{n} 字符）且无术语命中，选择快速路径"

    usage = None
    ambiguity = None
    want_clarify = path == "standard" and clarify_wanted(req, deps)
    if req.user_domain:
        domain = req.user_domain
        reason += f"；领域为{domain}（用户指定）"
        if want_clarify:
            _, ambiguity, usage, _ = await _judge_with_ambiguity(deps, state, want_domain=False)
    elif path == "standard":
        if want_clarify:
            judged, ambiguity, usage, _ = await _judge_with_ambiguity(deps, state, want_domain=True)
        else:
            judged, usage = await _judge_domain(deps, req.text)
        domain = judged or DEFAULT_DOMAIN
        reason += f"；领域判定为{domain}" if judged else "；领域判定失败，按通用处理"
    else:
        domain = DEFAULT_DOMAIN
    if ambiguity:
        reason += f"；发现歧义「{ambiguity['span']}」，等待用户澄清"

    emit("plan", {"path": path, "domain": domain, "reason": reason})
    if path == "fast":
        summary = "快速路径"
    elif path == "revise":
        summary = "修订路径"
    else:
        summary = f"标准路径 · {domain}" + (" · 待澄清" if ambiguity else "")
    update = {"path": path, "domain": domain, "plan_reason": reason, "ambiguity": ambiguity}
    return NodeOutput(update=update, summary=summary, usage=usage)


def build_context(state: TranslationState, settings: Settings) -> TranslationContext:
    """组装上下文包：术语、领域、风格、会话上下文（所有路径都带，指代消解依赖前文）与用户澄清。"""
    req = state["request"]
    domain = state.get("domain") or DEFAULT_DOMAIN
    session = req.session
    return TranslationContext(
        terms=list(state.get("term_hits") or []),
        domain_hint=None if domain == DEFAULT_DOMAIN else domain,
        style=req.style,
        session_ctx=session_mod.window_turns(session, settings),
        session_summary=((session.summary or "").strip() or None) if session else None,
        session_entities=session_mod.entity_dicts(session.entities, settings.memorize_max_entities) if session else [],
        clarification=state.get("clarification"),
    )


async def _search_tm(state: TranslationState, deps: AgentDeps) -> tuple[list[TmHit], str | None]:
    """检索翻译记忆；失败一律降级为无命中，并在摘要中说明。未配置记忆库或没有用户时不检索、不写摘要。"""
    req = state["request"]
    if deps.tm is None or req.user_id is None:
        return [], None
    try:
        result = await deps.tm.search(req.user_id, req.text, state["source_lang"], req.target_lang)
    except Exception as e:  # noqa: BLE001 - 检索失败不影响翻译
        log.warning("翻译记忆检索失败，按无命中处理: %s", e)
        return [], "翻译记忆检索失败"
    if not result.available:
        return [], "翻译记忆不可用"
    if not result.hits:
        return [], "未命中翻译记忆"
    top = result.hits[0]
    best = _pct(top.fuzzy) if top.fuzzy >= deps.settings.tm_fuzzy_min else f"语义 {_pct(top.semantic)}"
    return result.hits, f"命中 {len(result.hits)} 条翻译记忆（最高 {best}）"


async def retrieve(state: TranslationState, deps: AgentDeps, emit: Emit) -> NodeOutput:
    ctx = build_context(state, deps.settings)
    hits, tm_summary = await _search_tm(state, deps)
    ctx.tm_examples = [{"source": h.source, "target": h.target} for h in hits]
    domain = ctx.domain_hint or DEFAULT_DOMAIN
    parts = [f"上下文包：{len(ctx.terms)} 条术语，领域={domain}，风格={STYLE_NAMES.get(ctx.style, ctx.style)}"]
    if tm_summary:
        parts.append(tm_summary)
    if ctx.session_ctx or ctx.session_summary:
        parts.append(f"会话上下文 {len(ctx.session_ctx)} 轮")
    vos = [h.to_vo() for h in hits]
    return NodeOutput(
        update={"context": ctx, "tm_hits": vos},
        summary="；".join(parts),
        detail={"tmHits": vos, "sessionTurns": len(ctx.session_ctx)},
    )


async def finalize(state: TranslationState, deps: AgentDeps, emit: Emit) -> NodeOutput:
    final = (state.get("draft") or "").strip()
    hits = state.get("term_hits") or []
    compliance = check_compliance(hits, final)
    if compliance:
        ok = sum(1 for c in compliance if c.compliant)
        summary = f"术语遵循 {ok}/{len(compliance)}"
    else:
        summary = "无术语需校验"
    return NodeOutput(update={"final": final, "compliance": compliance}, summary=summary)
