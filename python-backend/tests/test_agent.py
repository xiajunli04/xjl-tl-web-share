"""3.1–3.4：提示词、节点规则、评审修正循环、图的事件序列。"""

import logging
import os
from pathlib import Path

import pytest

from app.agent import prompts
from app.agent.graph import run_agent
from app.agent.nodes.base import AgentDeps, AgentError
from app.agent.nodes.llm import parse_review
from app.agent.nodes.prep import analyze_features
from app.agent.state import ReviewIssue, TranslateRequest, TranslationContext
from app.core.config import get_settings
from app.core.errors import BizException
from app.glossary.matcher import TermHit
from app.glossary.repository import Glossary, Term
from app.lang.detector import LanguageDetector
from tests.fakes import FakeLLM, review_json

SNAPSHOTS = Path(__file__).parent / "snapshots"


class FakeGlossaryRepo:
    def __init__(self, glossaries: list[Glossary] = ()):
        self._g = {g.id: g for g in glossaries}

    async def load(self, ids):
        return {i: self._g[i] for i in ids if i in self._g}


GPU_GLOSSARY = Glossary(
    id=7,
    name="计算机",
    source_lang="en",
    target_lang="zh",
    terms=(
        Term(1, 7, "GPU", "图形处理器"),
        Term(2, 7, "machine learning", "机器学习"),
    ),
)
JA_GLOSSARY = Glossary(id=9, name="日语", source_lang="en", target_lang="ja", terms=(Term(3, 9, "GPU", "GPU"),))


def make_deps(fake: FakeLLM, repo=None, **overrides) -> AgentDeps:
    settings = get_settings().model_copy(update=overrides)
    return AgentDeps(
        llm=fake,
        settings=settings,
        detector=LanguageDetector(settings),
        glossary_repo=repo or FakeGlossaryRepo([GPU_GLOSSARY, JA_GLOSSARY]),
    )


def req(**kw) -> TranslateRequest:
    base = {"text": "Good morning", "sourceLang": "auto", "targetLang": "zh"}
    base.update(kw)
    return TranslateRequest.model_validate(base)


async def collect(request: TranslateRequest, deps: AgentDeps) -> list[tuple[str, dict]]:
    return [e async for e in run_agent(request, deps)]


def of(events, name):
    return [d for e, d in events if e == name]


def nodes(events):
    return [(d["node"], d["status"]) for e, d in events if e == "node"]


# ---------------- 3.1 提示词 ----------------


def _ctx() -> TranslationContext:
    return TranslationContext(
        terms=[TermHit("GPU", "图形处理器", 7), TermHit("machine learning", "机器学习", 7)],
        domain_hint="计算机",
        style="faithful",
    )


def test_translate_prompt_snapshot():
    system = prompts.translate_system_prompt(_ctx(), "en", "zh")
    snap = SNAPSHOTS / "translate_system_standard.txt"
    if os.environ.get("UPDATE_SNAPSHOTS") or not snap.exists():
        snap.parent.mkdir(exist_ok=True)
        snap.write_text(system, encoding="utf-8")
    assert system == snap.read_text(encoding="utf-8")
    # 术语表、风格指令、保护规则
    assert "| 原文术语 | 译法 |" in system and "| GPU | 图形处理器 |" in system
    assert prompts.STYLE_INSTRUCTIONS["faithful"] in system
    assert "{name}" in system and "%s" in system and "只输出译文本身" in system
    assert "「计算机」领域" in system


def test_style_instructions_differ():
    faithful = prompts.translate_system_prompt(TranslationContext(style="faithful"), "en", "zh")
    creative = prompts.translate_system_prompt(TranslationContext(style="creative"), "en", "zh")
    assert faithful != creative
    assert prompts.STYLE_INSTRUCTIONS["creative"] in creative
    assert "## 术语表" not in faithful  # 无术语时不输出空表
    assert "## 领域" not in faithful  # 通用领域不输出领域段


def test_review_refine_domain_prompts():
    ctx = _ctx()
    review = prompts.review_messages(ctx, "src", "译文", "en", "zh")
    assert "JSON" in review[0].content and "terminology" in review[0].content
    assert "<translation>\n译文\n</translation>" in review[1].content
    refine = prompts.refine_messages(
        ctx, "src", "译文", [ReviewIssue("terminology", "major", "显卡", "应译为图形处理器")], "en", "zh"
    )
    assert "| GPU | 图形处理器 |" in refine[0].content
    assert "片段「显卡」：应译为图形处理器" in refine[1].content
    domain = prompts.domain_messages("x" * 5000)
    assert len(domain[1].content) == prompts.DOMAIN_SAMPLE_CHARS


def test_glossary_table_escapes_pipe():
    ctx = TranslationContext(terms=[TermHit("a|b", "甲|乙", 1)])
    assert "| a\\|b | 甲\\|乙 |" in prompts.glossary_table(ctx)


def test_text_features():
    f = analyze_features("Hello {name}, you have %d new messages at https://x.io and ${a} {{b}} `code`")
    assert f.placeholders == ["{name}", "%d", "${a}", "{{b}}"]
    assert f.urls == ["https://x.io"]
    assert f.has_code


# ---------------- 请求校验 ----------------


@pytest.mark.parametrize(
    ("kw", "code"),
    [
        ({"text": "   "}, "A0410"),
        ({"text": "x" * 5001}, "A0410"),
        ({"targetLang": "xx"}, "A0420"),
        ({"sourceLang": "xx"}, "A0420"),
        ({"sourceLang": "zh", "targetLang": "zh"}, "A0410"),
    ],
)
def test_request_check(kw, code):
    with pytest.raises(BizException) as ei:
        req(**kw).check(5000)
    assert ei.value.error.code == code


def test_request_defaults_and_camel_case():
    r = TranslateRequest.model_validate(
        {"text": "hi", "targetLang": "zh", "glossaryIds": None, "modelConfigId": 2, "userId": 5, "domain": "auto"}
    )
    assert (r.source_lang, r.mode, r.style, r.glossary_ids, r.model_config_id, r.user_id) == (
        "auto",
        "auto",
        "faithful",
        [],
        2,
        5,
    )
    assert r.user_domain is None


# ---------------- 3.2 analyze / plan / retrieve / finalize ----------------


async def test_auto_short_text_goes_fast():
    fake = FakeLLM(translations=["早上好"])
    events = await collect(req(), make_deps(fake))
    plan = of(events, "plan")[0]
    assert plan == {"path": "fast", "domain": "通用", "reason": "文本较短（12 字符）且无术语命中，选择快速路径"}
    assert ("retrieve", "skipped") in nodes(events)
    assert ("review", "skipped") in nodes(events) and ("refine", "skipped") in nodes(events)
    assert fake.kinds() == ["translate"]  # 快速路径不判定领域、不评审
    assert of(events, "final")[0]["translation"] == "早上好"
    assert of(events, "detect")[0]["method"] == "lingua"


@pytest.mark.parametrize(
    ("kw", "reason_part"),
    [
        (
            {"text": "This sentence is definitely much longer than eighty characters, so it takes the standard path."},
            "文本较长",
        ),
        ({"style": "fluent"}, "风格为流畅"),
        ({"text": "Machine learning on GPU", "glossaryIds": [7]}, "命中 2 条术语"),
    ],
)
async def test_auto_standard_conditions(kw, reason_part):
    # 译文遵循术语（否则规则术语检查会触发修正）
    fake = FakeLLM(translations=["机器学习在图形处理器上运行"], reviews=[review_json(95)])
    events = await collect(req(**kw), make_deps(fake))
    plan = of(events, "plan")[0]
    assert plan["path"] == "standard"
    assert reason_part in plan["reason"] and "选择标准路径" in plan["reason"]
    assert plan["domain"] == "计算机" and "领域判定为计算机" in plan["reason"]
    assert fake.kinds() == ["domain", "translate", "review"]


async def test_forced_modes():
    fake = FakeLLM(translations=["译文"], reviews=[review_json(90)])
    events = await collect(req(mode="standard"), make_deps(fake))
    assert of(events, "plan")[0]["reason"].startswith("用户指定标准模式")
    assert of(events, "plan")[0]["path"] == "standard"

    fake = FakeLLM(translations=["机器学习"])
    long_with_terms = req(mode="fast", text="Machine learning " * 10, glossaryIds=[7])
    events = await collect(long_with_terms, make_deps(fake))
    assert of(events, "plan")[0]["path"] == "fast"
    assert of(events, "plan")[0]["reason"] == "用户指定快速模式"
    assert fake.kinds() == ["translate"]


async def test_domain_judged_only_on_standard_and_user_domain_respected():
    fake = FakeLLM(translations=["译文"], reviews=[review_json(90)])
    events = await collect(req(mode="standard", domain="医学"), make_deps(fake))
    assert of(events, "plan")[0]["domain"] == "医学"
    assert "domain" not in fake.kinds()
    assert "领域为医学（用户指定）" in of(events, "plan")[0]["reason"]
    # 领域写入上下文包 → 提示词
    translate_req = next(r for k, r in fake.calls if k == "translate")
    assert "「医学」领域" in translate_req.messages[0].content


async def test_analyze_terms_and_skipped_glossaries_and_user_source():
    fake = FakeLLM(translations=["机器学习在图形处理器上运行"], reviews=[review_json(90)])
    request = req(text="Machine learning on GPU", sourceLang="en", glossaryIds=[7, 9, 404])
    events = await collect(request, make_deps(fake))
    assert of(events, "detect") == []  # 用户指定源语言时跳过识别
    terms = of(events, "terms")[0]
    assert terms == {
        "hits": [
            {"source": "machine learning", "target": "机器学习", "glossaryId": 7},
            {"source": "GPU", "target": "图形处理器", "glossaryId": 7},
        ],
        "skippedGlossaries": [9, 404],
    }
    summary = [d for e, d in events if e == "node" and d["node"] == "analyze" and d["status"] == "completed"][0]
    assert summary["summary"] == (
        "源语言为英语（用户指定），命中 2 条术语，跳过 1 个语言对不符的术语库，1 个术语库不存在或已删除"
    )
    retrieve = [d for e, d in events if e == "node" and d["node"] == "retrieve" and d["status"] == "completed"][0]
    assert retrieve["summary"] == "上下文包：2 条术语，领域=计算机，风格=忠实"


async def test_finalize_compliance():
    fake = FakeLLM(translations=["机器学习在显卡上运行"], reviews=[review_json(90)])
    # 修正轮次上限为 0：术语违规不再修正，保留首译以检查遵循判定
    events = await collect(
        req(text="Machine learning on GPU", glossaryIds=[7]), make_deps(fake, agent_max_refine_rounds=0)
    )
    final = of(events, "final")[0]
    assert final["compliance"] == [
        {"source": "machine learning", "target": "机器学习", "compliant": True},
        {"source": "GPU", "target": "图形处理器", "compliant": False},
    ]
    finalize = [d for e, d in events if e == "node" and d["node"] == "finalize" and d["status"] == "completed"][0]
    assert finalize["summary"] == "术语遵循 1/2"


# ---------------- 3.3 translate / review / refine ----------------


async def test_one_refine_then_pass():
    issue = {
        "category": "terminology",
        "severity": "major",
        "span": "显卡",
        "suggestion": "术语 GPU 应译为“图形处理器”",
    }
    fake = FakeLLM(
        translations=["机器学习模型\n通常在显卡上训练。", "机器学习模型\n通常在图形处理器上训练。"],
        reviews=[review_json(70, [issue]), review_json(90)],
    )
    events = await collect(
        req(text="Machine learning models are usually trained on GPU.", glossaryIds=[7]), make_deps(fake)
    )
    seq = [(e, d.get("round")) for e, d in events if e in ("review", "delta")]
    rounds = [r for e, r in seq if e == "delta"]
    assert rounds[0] == 0 and rounds[-1] == 1
    reviews = of(events, "review")
    assert [(r["round"], r["score"], r["passed"]) for r in reviews] == [(0, 70, False), (1, 90, True)]
    assert reviews[0]["issues"] == [issue]  # LLM 已指出的术语问题不重复添加
    final = of(events, "final")[0]
    assert final["translation"] == "机器学习模型\n通常在图形处理器上训练。"
    assert all(c["compliant"] for c in final["compliance"])
    # refine 带上评审意见
    refine_req = next(r for k, r in fake.calls if k == "refine")
    assert "片段「显卡」" in refine_req.messages[1].content
    # usage 汇总所有 LLM 调用（领域 100/10 + 译 200/20 + 评 100/10 + 修 200/20 + 评 100/10）
    assert final["usage"] == {"promptTokens": 700, "completionTokens": 70}


async def test_refine_limit_reached():
    # 连续 3 次评审都包含 major 问题（分数高于兜底分也不通过）
    major = [{"category": "accuracy", "severity": "major", "span": "v", "suggestion": "误译"}]
    fake = FakeLLM(
        translations=["v0", "v1", "v2"],
        reviews=[review_json(80, major), review_json(85, major), review_json(92, major)],
    )
    events = await collect(req(mode="standard"), make_deps(fake))
    assert fake.kinds() == ["domain", "translate", "review", "refine", "review", "refine", "review"]
    reviews = of(events, "review")
    assert [r["passed"] for r in reviews] == [False, False, False]
    assert of(events, "final")[0]["translation"] == "v2"
    refine_completed = [d for e, d in events if e == "node" and d["node"] == "refine" and d["status"] == "completed"]
    assert [d["summary"] for d in refine_completed] == ["第 1 轮修正完成", "第 2 轮修正完成"]


async def test_min_score_and_rounds_from_settings():
    fake = FakeLLM(translations=["v0", "v1"], reviews=[review_json(60), review_json(65)])
    events = await collect(req(mode="standard"), make_deps(fake, agent_review_min_score=60, agent_max_refine_rounds=1))
    assert [r["passed"] for r in of(events, "review")] == [True]
    assert ("refine", "skipped") in nodes(events)

    fake = FakeLLM(translations=["v0", "v1"], reviews=[review_json(10), review_json(10)])
    await collect(req(mode="standard"), make_deps(fake, agent_max_refine_rounds=1))
    assert fake.kinds().count("refine") == 1


async def test_broken_review_json_treated_as_pass(caplog):
    fake = FakeLLM(translations=["译文"], reviews=["这不是 JSON"])
    with caplog.at_level(logging.WARNING, logger="app.agent.nodes"):
        logging.getLogger("app").propagate = True
        try:
            events = await collect(req(mode="standard"), make_deps(fake))
        finally:
            logging.getLogger("app").propagate = False
    review = of(events, "review")[0]
    assert review == {"round": 0, "score": None, "passed": True, "issues": [], "reviewer": None, "fallback": False}
    assert of(events, "final")[0]["translation"] == "译文"
    assert any("无法解析" in r.getMessage() for r in caplog.records)
    completed = [d for e, d in events if e == "node" and d["node"] == "review" and d["status"] == "completed"][0]
    assert completed["summary"] == "第 0 轮评审结果无法解析，视为通过"


async def test_review_uses_json_mode_for_openai_only():
    from app.llm.json_mode import json_mode_extra
    from app.llm.openai_compat import OpenAICompatibleClient

    oai = OpenAICompatibleClient(base_url="https://x/v1", api_key="k", model="m")
    assert json_mode_extra(oai) == {"response_format": {"type": "json_object"}}
    assert json_mode_extra(FakeLLM()) == {}
    await oai.close()


def test_parse_review_tolerant():
    assert parse_review('```json\n{"score": 88.6, "issues": [{"category": "Style", "severity": "x"}]}\n```') == (
        89,
        [ReviewIssue("style", "minor", "", "")],
    )
    assert parse_review('前言 {"score": 120} 后记')[0] == 100
    assert parse_review('{"issues": []}') is None
    assert parse_review("") is None


async def test_rule_based_term_issue_merged_into_review():
    fake = FakeLLM(translations=["机器学习在显卡上运行"], reviews=[review_json(95)])
    events = await collect(
        req(text="Machine learning on GPU", glossaryIds=[7]), make_deps(fake, agent_max_refine_rounds=0)
    )
    review = of(events, "review")[0]
    assert review["passed"] is False  # 未遵循的术语即使 95 分也判定为未通过
    issues = review["issues"]
    assert issues == [
        {"category": "terminology", "severity": "major", "span": "GPU", "suggestion": "术语 GPU 应译为“图形处理器”"}
    ]


async def test_empty_translation_raises_agent_error():
    fake = FakeLLM(translations=["  "])
    with pytest.raises(AgentError):
        await collect(req(), make_deps(fake))


# ---------------- 3.4 事件通用约定 ----------------


async def test_node_events_seq_summary_latency_usage():
    fake = FakeLLM(translations=["机器学习在图形处理器上运行"], reviews=[review_json(90)])
    events = await collect(req(mode="standard", text="Machine learning on GPU", glossaryIds=[7]), make_deps(fake))
    node_events = of(events, "node")
    assert [d["seq"] for d in node_events] == list(range(1, len(node_events) + 1))
    for d in node_events:
        if d["status"] in ("completed", "skipped"):
            assert d["summary"]
        if d["status"] == "completed":
            assert isinstance(d["latencyMs"], int)
            llm_node = d["node"] in ("plan", "translate", "review", "refine")
            assert ("usage" in d) == llm_node, d
    assert events[-1][0] == "final"
