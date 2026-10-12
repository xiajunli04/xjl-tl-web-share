"""improve-agent-from-experiments 第 3 组：严重度修正规则、评审模型、术语约束强度、提示词与一致性。"""

import json
from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from app.agent.review_gate import needs_refine, severity_counts
from app.agent.state import ReviewIssue, TranslateRequest, TranslationContext
from app.core.errors import BizException, ErrorCode
from app.doc import prompts as doc_prompts
from app.doc.analysis import term_entry
from app.doc.memory import hard_hits, term_hits
from app.doc.state import DocPayload
from app.glossary.matcher import HARD, SOFT, TermHit
from app.glossary.repository import Glossary, Term
from app.llm.registry import ResolvedModel
from app.llm.reviewer import ReviewerSource, review_model_of
from app.repositories.model_config import ModelConfig
from tests.doc_fakes import DocFakeLLM, FakeGlossaryRepo
from tests.fakes import FakeLLM, review_json
from tests.test_agent import collect, make_deps, nodes, of, req
from tests.test_doc_graph import run_doc, system_text

MINOR = {"category": "fluency", "severity": "minor", "span": "x", "suggestion": "更通顺"}
MAJOR = {"category": "accuracy", "severity": "major", "span": "x", "suggestion": "误译"}


def model(name: str, client, config_id: int = 1) -> ResolvedModel:
    cfg = ModelConfig(
        id=config_id,
        name=name,
        provider="OPENAI_COMPATIBLE",
        base_url="https://llm.test/v1",
        model_name=name,
        api_key_cipher="",
        is_default=config_id == 1,
        enabled=True,
        updated_at=datetime.now(UTC),
    )
    return ResolvedModel(cfg, client)


class Resolver:
    """按 id 返回评审模型；不在表中的 id 抛出 C0130（配置不存在或已停用）。"""

    def __init__(self, models: dict[int, ResolvedModel] | None = None, error: Exception | None = None):
        self.models = models or {}
        self.error = error
        self.calls: list[int] = []

    async def __call__(self, config_id: int) -> ResolvedModel:
        self.calls.append(config_id)
        if self.error is not None:
            raise self.error
        if config_id not in self.models:
            raise BizException(ErrorCode.MODEL_CONFIG_UNAVAILABLE)
        return self.models[config_id]


# ---------------------------------------------------------------- 3.1 needs_refine


@pytest.mark.parametrize(
    ("score", "issues", "rule_issues", "expected"),
    [
        (82, [MINOR, MINOR], [], False),  # 只有 minor 不触发
        (92, [MAJOR], [], True),  # major 触发（即使分数很高）
        (95, [{**MAJOR, "severity": "critical"}], [], True),  # critical 触发
        (74, [], [], True),  # 低于兜底分触发
        (75, [MINOR], [], False),  # 等于兜底分不触发
        (95, [], [{"span": "GPU"}], True),  # 规则术语问题触发
        (None, [], [], False),  # 评审解析失败视为通过
        (None, [MAJOR], [], True),
    ],
)
def test_needs_refine(score, issues, rule_issues, expected):
    assert needs_refine(score, issues, rule_issues, 75) is expected


def test_needs_refine_accepts_review_issue_objects_and_counts():
    issues = [ReviewIssue("accuracy", "MAJOR", "", ""), ReviewIssue("style", "minor", "", "")]
    assert needs_refine(90, issues, [], 75) is True
    assert needs_refine(90, issues[1:], [], 75) is False
    assert severity_counts([*issues, {"severity": "critical"}, {"severity": "odd"}]) == {
        "critical": 1,
        "major": 1,
        "minor": 2,
    }
    assert severity_counts([]) == {"critical": 0, "major": 0, "minor": 0}


async def test_short_text_minor_only_passes_without_refine():
    """规格场景"只有轻微问题"：80 分、只有 minor → 通过，不进入 refine。"""
    fake = FakeLLM(translations=["译文"], reviews=[review_json(80, [MINOR])])
    events = await collect(req(mode="standard"), make_deps(fake))
    assert [(r["round"], r["passed"]) for r in of(events, "review")] == [(0, True)]
    assert "refine" not in fake.kinds()
    assert ("refine", "skipped") in nodes(events)


async def test_short_text_major_triggers_refine_even_with_high_score():
    fake = FakeLLM(translations=["v0", "v1"], reviews=[review_json(92, [MAJOR]), review_json(90, [MINOR])])
    events = await collect(req(mode="standard"), make_deps(fake))
    assert [(r["round"], r["score"], r["passed"]) for r in of(events, "review")] == [(0, 92, False), (1, 90, True)]
    assert of(events, "final")[0]["translation"] == "v1"


# ---------------------------------------------------------------- 3.2 评审模型


async def test_reviewer_source_resolution_and_cache():
    translator, reviewer = FakeLLM(), FakeLLM(model="luna")
    resolver = Resolver({3: model("gpt-6-luna", reviewer, 3)})
    source = ReviewerSource.of(model("gpt-5.6-luna", translator), 3, resolver)
    got = await source.get()
    assert got.client is reviewer and got.name == "gpt-6-luna" and got.fallback is False and got.config_id == 3
    assert await source.get() is got and resolver.calls == [3]  # 每个来源只解析一次

    # 未指定评审模型：使用译者模型，不查询
    plain = await ReviewerSource.of(model("gpt-5.6-luna", translator), None, resolver).get()
    assert plain.client is translator and plain.name == "gpt-5.6-luna" and plain.fallback is False
    assert resolver.calls == [3]
    # 依赖中没有来源（单元测试直接构造）
    bare = await review_model_of(None, translator)
    assert bare.client is translator and bare.name is None and bare.fallback is False


@pytest.mark.parametrize("error", [None, RuntimeError("数据库不可用")])
async def test_reviewer_source_falls_back_to_translator(error, caplog):
    translator = FakeLLM()
    source = ReviewerSource.of(model("gpt-5.6-luna", translator), 404, Resolver(error=error))
    got = await source.get()
    assert got.client is translator and got.name == "gpt-5.6-luna" and got.fallback is True
    assert got.config_id == 404
    assert got.error == (ErrorCode.MODEL_CONFIG_UNAVAILABLE.message if error is None else "RuntimeError: 数据库不可用")


async def test_short_text_review_and_refine_go_to_different_models():
    translator = FakeLLM(translations=["v0", "v1"])
    reviewer = FakeLLM(reviews=[review_json(88, [MAJOR]), review_json(93)])
    deps = make_deps(translator)
    resolver = Resolver({3: model("gpt-6-luna", reviewer)})
    deps.reviewer = ReviewerSource.of(model("gpt-5.6-luna", translator), 3, resolver)
    events = await collect(req(mode="standard"), deps)
    assert translator.kinds() == ["domain", "translate", "refine"]
    assert reviewer.kinds() == ["review", "review"]
    reviews = of(events, "review")
    assert [(r["reviewer"], r["fallback"]) for r in reviews] == [("gpt-6-luna", False)] * 2
    assert of(events, "final")[0]["translation"] == "v1"


async def test_short_text_review_falls_back_when_reviewer_unavailable():
    """规格场景"评审模型不可用"：退回译者模型，review 事件 fallback=true，翻译正常完成。"""
    translator = FakeLLM(translations=["译文"], reviews=[review_json(90)])
    deps = make_deps(translator)
    deps.reviewer = ReviewerSource.of(model("gpt-5.6-luna", translator), 3, Resolver())
    events = await collect(req(mode="standard"), deps)
    review = of(events, "review")[0]
    assert review["reviewer"] == "gpt-5.6-luna" and review["fallback"] is True and review["passed"] is True
    assert translator.kinds() == ["domain", "translate", "review"]
    summary = next(d for e, d in events if e == "node" and d["node"] == "review" and d["status"] == "completed")
    assert summary["summary"].endswith("评审模型不可用，已退回译者模型")
    assert of(events, "final")[0]["translation"] == "译文"


def test_request_models_accept_review_model_config_id():
    r = TranslateRequest.model_validate({"text": "a", "targetLang": "zh", "reviewModelConfigId": 3})
    assert r.review_model_config_id == 3
    assert TranslateRequest.model_validate({"text": "a", "targetLang": "zh"}).review_model_config_id is None
    p = DocPayload.model_validate({"text": "a", "targetLang": "zh", "reviewModelConfigId": 3})
    assert p.review_model_config_id == 3 and p.model_dump(by_alias=True)["reviewModelConfigId"] == 3
    assert DocPayload.model_validate({"text": "a", "targetLang": "zh"}).review_model_config_id is None
    with pytest.raises(ValidationError):
        DocPayload.model_validate({"text": "a", "targetLang": "zh", "reviewModelConfigId": 0})
    with pytest.raises(ValidationError):
        TranslateRequest.model_validate({"text": "a", "targetLang": "zh", "reviewModelConfigId": 0})


# ---------------------------------------------------------------- 3.3 文档分块评审

ONE_PARA = "## Usage\n\nUse the GPU.\n"


def _review_handler(*results):
    """按评审轮次依次返回 (score, issues)；issues 中的段落 id 不影响判定。"""

    def handler(req, payload, n):
        score, issues = results[min(n, len(results) - 1)]
        return json.dumps({"score": score, "issues": issues}, ensure_ascii=False)

    return handler


def _translate_chunk_trace(em):
    return [t for t in em.of("trace") if t["node"] == "translate_chunk"]


async def test_doc_minor_issues_do_not_refine():
    """规格场景"只有轻微问题不修正"：82 分、2 个 minor、硬约束术语全部遵循 → reviewRounds=0。"""
    fake = DocFakeLLM(handlers={"review": _review_handler((82, [MINOR, MINOR]))})
    _, _, em = await run_doc(ONE_PARA, fake, options={"termExtraction": False})
    assert fake.count("refine") == 0
    seg = next(iter(em.of("chunk_done")[-1]["segments"]))
    assert seg["reviewScore"] == 82 and seg["reviewRounds"] == 0
    assert em.of("chunk_done")[-1]["reviewIssues"] == {"critical": 0, "major": 0, "minor": 2}
    assert "问题 critical 0 / major 0 / minor 2" in _translate_chunk_trace(em)[-1]["summary"]
    assert em.of("completed")[0]["stats"]["refined"] == 0


async def test_doc_major_issue_triggers_refine():
    """规格场景"major 问题触发修正"：92 分但有 1 个 major → 修正 1 轮后再次评审。"""
    fake = DocFakeLLM(handlers={"review": _review_handler((92, [MAJOR]), (95, [MINOR]))})
    _, _, em = await run_doc(ONE_PARA, fake, options={"termExtraction": False})
    assert fake.kinds()[-3:] == ["review", "refine", "review"]
    done = em.of("chunk_done")[-1]
    assert done["segments"][0]["reviewRounds"] == 1 and done["segments"][0]["reviewScore"] == 95
    assert done["reviewIssues"] == {"critical": 0, "major": 0, "minor": 1}  # 最后一次评审
    assert "评审 92→95 分（修正 1 轮）" in _translate_chunk_trace(em)[-1]["summary"]


async def test_doc_review_disabled_or_unparseable_has_no_issue_counts():
    fake = DocFakeLLM()
    _, _, em = await run_doc(ONE_PARA, fake, options={"termExtraction": False, "review": False})
    assert all(d["reviewIssues"] is None for d in em.of("chunk_done"))

    fake = DocFakeLLM(handlers={"review": lambda req, payload, n: "不是 JSON"})
    _, _, em = await run_doc(ONE_PARA, fake, options={"termExtraction": False})
    assert fake.count("refine") == 0  # 解析失败视为通过
    assert em.of("chunk_done")[-1]["reviewIssues"] is None
    assert "评审结果无法解析" in _translate_chunk_trace(em)[-1]["summary"]


DEPLOY_DOC = "## Deployment\n\nA Deployment manages Pods.\n\nScale the Deployment up.\n"


def _keep_source(seq, text):
    return f"译:{text}"  # Deployment 保留原文


async def test_doc_soft_term_does_not_trigger_refine():
    """规格场景"软约束术语不触发修正"：软约束 Deployment→部署 的译文保留了 Deployment。"""
    fake = DocFakeLLM(
        terms=[{"source": "Deployment", "target": "部署", "type": "term", "count": 3}],
        translate_fn=_keep_source,
        handlers={"review": _review_handler((90, [MINOR]))},
    )
    graph, cfg, em = await run_doc(DEPLOY_DOC, fake)
    assert fake.count("refine") == 0
    for seg in em.of("chunk_done")[-1]["segments"]:
        assert seg["reviewRounds"] == 0 and seg["compliance"] == []
    assert em.of("completed")[0]["stats"]["compliance"] == {"ok": 0, "total": 0}
    terms = (await graph.aget_state(cfg)).values["terms"]
    assert terms == [{"source": "Deployment", "target": "部署", "caseSensitive": True, "binding": "soft"}]
    system = system_text(fake.requests("translate")[0])
    assert "## 参考译法（可按领域惯例调整，同一术语全文保持一致）" in system
    assert "## 术语表（必须使用）" not in system
    align = next(t for t in em.of("trace") if t["node"] == "align_terms")
    assert align["summary"].endswith("自动采用全部候选（抽取术语作为参考译法）")


async def test_doc_unconfirmed_binding_by_origin():
    """规格场景"未确认时的约束强度"：术语库命中 GPU 为 hard，抽取的 Deployment 为 soft。"""
    text = "## GPU\n\nThe GPU runs a Deployment.\n\nEach Deployment uses the GPU.\n"
    gpu = Term(1, 7, "GPU", "图形处理器")
    glossary = Glossary(id=7, name="计算机", source_lang="en", target_lang="zh", terms=(gpu,))
    fake = DocFakeLLM(terms=[{"source": "Deployment", "target": "部署", "type": "term", "count": 2}])
    graph, cfg, em = await run_doc(
        text, fake, glossaryIds=[7], repo=FakeGlossaryRepo([glossary]), options={"review": False}
    )
    terms = {t["source"]: t["binding"] for t in (await graph.aget_state(cfg)).values["terms"]}
    assert terms == {"GPU": "hard", "Deployment": "soft"}
    system = system_text(fake.requests("translate")[0])
    hard_section = system.split("## 术语表（必须使用）\n", 1)[1].split("\n\n", 1)[0]
    soft_title = "## 参考译法（可按领域惯例调整，同一术语全文保持一致）\n"
    soft_section = system.split(soft_title, 1)[1].split("## 硬性规则", 1)[0]
    assert "| GPU | 图形处理器 |" in hard_section and "Deployment" not in hard_section
    assert "| Deployment | 部署 |" in soft_section and "GPU" not in soft_section
    # 遵循判定只包含硬约束术语
    for seg in em.of("chunk_done")[-1]["segments"]:
        assert {c["source"] for c in seg["compliance"]} <= {"GPU"}


async def test_doc_review_uses_review_model_and_refine_uses_translator():
    """规格场景"使用独立评审模型"：评审发往评审模型，修正发往译者模型。"""
    translator = DocFakeLLM()
    reviewer = DocFakeLLM(handlers={"review": _review_handler((90, [MAJOR]), (95, []))})
    source = ReviewerSource.of(model("gpt-5.6-luna", translator), 3, Resolver({3: model("gpt-6-luna", reviewer, 3)}))
    _, _, em = await run_doc(ONE_PARA, translator, reviewer=source, options={"termExtraction": False})
    assert translator.count("review") == 0 and translator.count("refine") == 1
    assert reviewer.kinds() == ["review", "review"]
    assert not any(t["node"] == "review_model" for t in em.of("trace"))


async def test_doc_review_model_unavailable_falls_back_with_one_warning_trace():
    translator = DocFakeLLM()
    resolver = Resolver()
    source = ReviewerSource.of(model("gpt-5.6-luna", translator), 3, resolver)
    text = "".join(f"## Part {i}\n\nBody {i}.\n\n" for i in range(3))
    _, _, em = await run_doc(
        text,
        translator,
        reviewer=source,
        strategy="parallel",
        settings={"doc_chunk_target_tokens": 1},
        options={"termExtraction": False},
    )
    assert translator.count("review") == len(em.of("chunk_done")) > 1  # 每块都评审，退回译者模型
    warnings = [t for t in em.of("trace") if t["node"] == "review_model"]
    assert len(warnings) == 1 and resolver.calls == [3]
    assert "评审模型（id=3）不可用" in warnings[0]["summary"]
    assert "退回译者模型（gpt-5.6-luna）" in warnings[0]["summary"]
    assert em.types()[-1] == "completed"


# ---------------------------------------------------------------- 3.4 术语约束强度


def test_term_entry_binding_and_legacy_terms_default_hard():
    candidates = [{"source": "Pod", "target": "容器组", "caseSensitive": True}]
    assert term_entry("Pod", "容器组", candidates)["binding"] == HARD
    assert term_entry("Pod", "容器组", candidates, SOFT) == {
        "source": "Pod",
        "target": "容器组",
        "caseSensitive": True,
        "binding": SOFT,
    }
    hits = term_hits(
        [
            {"source": "Pod", "target": "容器组"},  # 旧检查点中缺 binding
            {"source": "Node", "target": "节点", "binding": "SOFT"},
            {"source": "Job", "target": "任务", "binding": "weird"},
        ]
    )
    assert [h.binding for h in hits] == [HARD, SOFT, HARD]
    assert [h.source for h in hard_hits(hits)] == ["Pod", "Job"]


async def test_doc_confirmed_terms_are_hard():
    """规格场景"修改后确认"：用户确认（含修改）的术语为硬约束，规则检查对它们生效。"""
    fake = DocFakeLLM(
        terms=[{"source": "Deployment", "target": "部署", "type": "term", "count": 3}], translate_fn=_keep_source
    )
    resume = {"terms": [{"source": "Deployment", "target": "部署单元"}]}
    graph, cfg, em = await run_doc(DEPLOY_DOC, fake, confirmTerms=True, resume=resume)
    assert (await graph.aget_state(cfg)).values["terms"][0]["binding"] == "hard"
    assert fake.count("refine") >= 1  # 未遵循硬约束术语，触发修正
    compliance = [c for seg in em.of("chunk_done")[-1]["segments"] for c in seg["compliance"]]
    assert {"source": "Deployment", "target": "部署单元", "compliant": False} in compliance


# ---------------------------------------------------------------- 3.5 提示词


def test_translate_prompt_sections_by_binding():
    hard_only = TranslationContext(terms=[TermHit("Pod", "容器组", 0)])
    system = doc_prompts.translate_system_prompt(hard_only, "en", "zh")
    assert "## 术语表（必须使用）\n| 原文术语 | 译法 |" in system
    assert "参考译法" not in system
    assert "4. 术语表中列出的术语必须使用给定译法；「已知专名译法」中的专名沿用已有译法。" in system

    soft_only = TranslationContext(terms=[TermHit("Deployment", "部署", 0, binding=SOFT)])
    system = doc_prompts.translate_system_prompt(soft_only, "en", "zh")
    assert "## 术语表" not in system
    assert "## 参考译法（可按领域惯例调整，同一术语全文保持一致）" in system and "| Deployment | 部署 |" in system
    assert "领域惯例为准" in system
    assert "「参考译法」中的术语优先遵循目标语言在该领域的通行惯例" in system

    none = doc_prompts.translate_system_prompt(TranslationContext(), "en", "zh")
    assert "## 术语表" not in none and "## 参考译法" not in none

    # 评审提示词同样区分两类术语
    review = doc_prompts.review_messages(soft_only, [], "en", "zh")[0].content
    assert "## 参考译法" in review and "## 术语表" not in review


def test_short_text_prompt_keeps_original_glossary_heading():
    from app.agent import prompts

    ctx = TranslationContext(terms=[TermHit("GPU", "图形处理器", 7)])
    system = prompts.translate_system_prompt(ctx, "en", "zh")
    assert "## 术语表（必须遵循）" in system and "参考译法" not in system


def test_analyze_prompt_contains_domain_convention_rules():
    """规格场景"抽取提示词包含领域惯例"。"""
    system = doc_prompts.analyze_messages(
        "text", want_summary=True, want_terms=True, source_lang="en", target_lang="zh"
    )[0].content
    assert system.startswith(doc_prompts.ANALYZE_ROLE)
    convention = system.split("## 术语译法惯例\n", 1)[1].split("\n\n", 1)[0]
    assert "按中文在该领域的通行惯例给出译法" in convention
    assert "产品名、API 或资源类型名、配置项、命令与代码标识符通常保留原文" in convention
    assert "首字母大写的英文名词或大小写混写的复合词" in convention
    assert "只有存在广泛通用的译法时才翻译；拿不准时 target 与 source 相同" in convention
    assert "Kubernetes" not in system  # 不写领域专用规则

    no_terms = doc_prompts.analyze_messages(
        "text", want_summary=True, want_terms=False, source_lang="en", target_lang="zh"
    )[0].content
    assert "术语译法惯例" not in no_terms


# ---------------------------------------------------------------- 3.6 一致性


def _deploy_doc(n: int) -> str:
    return "".join(f"## Part {i}\n\nThe Deployment runs app {i}.\n\n" for i in range(n))


def _translate_zh(zh_segs: set[int]):
    """zh_segs 中的段落把 Deployment 译为"部署"，其余保留原文。"""

    def handler(req, payload, n):
        segs = []
        for s in payload["segments"]:
            text = s["text"].replace("Deployment", "部署") if s["id"] in zh_segs else s["text"]
            segs.append({"id": s["id"], "text": "译:" + text})
        return json.dumps({"segments": segs}, ensure_ascii=False)

    return handler


async def test_soft_term_unified_by_majority():
    """规格场景"软约束按多数统一"：6 段保留 Deployment、2 段写作"部署" → 选定 Deployment，修正那 2 段。"""
    zh_segs = {3, 7}  # 第 1、3 章正文写作"部署"

    def fix(req, payload, n):
        segs = [{"id": s["id"], "text": s["translation"].replace("部署", "Deployment")} for s in payload["segments"]]
        return json.dumps({"segments": segs}, ensure_ascii=False)

    fake = DocFakeLLM(
        terms=[{"source": "Deployment", "target": "部署", "type": "term", "count": 8}],
        handlers={"translate": _translate_zh(zh_segs), "fix": fix},
    )
    _, _, em = await run_doc(_deploy_doc(8), fake, strategy="parallel", options={"review": False})
    issues = em.of("consistency")[0]["issues"]
    assert issues == [
        {
            "term": "Deployment",
            "variants": [{"text": "Deployment", "count": 6}, {"text": "部署", "count": 2}],
            "chosen": "Deployment",
            "fixedSegs": sorted(zh_segs),
            "unresolvedSegs": [],
        }
    ]


async def test_soft_term_reference_wins_tie():
    """平票时软约束的参考译法优先。"""
    zh_segs = {1, 3}

    def fix(req, payload, n):
        segs = [{"id": s["id"], "text": s["translation"].replace("Deployment", "部署")} for s in payload["segments"]]
        return json.dumps({"segments": segs}, ensure_ascii=False)

    fake = DocFakeLLM(
        terms=[{"source": "Deployment", "target": "部署", "type": "term", "count": 4}],
        handlers={"translate": _translate_zh(zh_segs), "fix": fix},
    )
    _, _, em = await run_doc(_deploy_doc(4), fake, strategy="parallel", options={"review": False})
    issue = em.of("consistency")[0]["issues"][0]
    assert issue["chosen"] == "部署" and issue["fixedSegs"] == [5, 7]
    assert issue["variants"] == [{"text": "部署", "count": 2}, {"text": "Deployment", "count": 2}]
