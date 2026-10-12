"""3.1–3.5：提示词与篇章记忆、分析与术语对齐、术语确认中断、分块翻译、一致性检查（假 LLM）。"""

import asyncio
import json
import random
from pathlib import Path

import pytest
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.types import Command

from app.core.config import get_settings
from app.doc.analysis import clean_target
from app.doc.graph import compile_doc_graph, initial_state, thread_config
from app.doc.memory import DocOptions, RollingNames, build_memory
from app.doc.state import DocPayload
from app.doc.store import PgChunkStore, make_checkpoint_pool
from app.glossary.repository import Glossary, Term
from tests.doc_fakes import (
    DocFakeLLM,
    FakeGlossaryRepo,
    ListEmitter,
    MemoryStore,
    doc_payload,
    fixture_text,
    make_doc_deps,
)
from tests.doc_prompt_cases import render, snapshot_messages

SNAPSHOTS = Path(__file__).parent / "snapshots"
SAMPLE_DOC = "# GPU Basics\n\nA GPU accelerates training.\n\n## Usage\n\nUse the GPU for each epoch.\n"
GPU_GLOSSARY = Glossary(
    id=7, name="计算机", source_lang="en", target_lang="zh", terms=(Term(1, 7, "GPU", "图形处理器"),)
)


def sections(n: int, paras: int = 2, prefix: str = "S") -> str:
    return "".join(
        f"## {prefix}{i}\n\n" + "\n\n".join(f"para {prefix.lower()}{i}-{j}" for j in range(paras)) + "\n\n"
        for i in range(n)
    )


async def run_doc(
    text: str, fake: DocFakeLLM, *, resume=None, store=None, repo=None, settings=None, reviewer=None, **kw
):
    graph = compile_doc_graph(InMemorySaver())
    emitter = ListEmitter()
    deps = make_doc_deps(fake, emitter=emitter, store=store, repo=repo, reviewer=reviewer, **(settings or {}))
    kw.setdefault("sourceLang", "en")
    payload = DocPayload.model_validate(doc_payload(text, **kw))
    cfg = thread_config(42)
    await graph.ainvoke(initial_state(42, payload), cfg, context=deps, durability="sync")
    if resume is not None:
        deps.emitter = emitter.child("t-2")
        await graph.ainvoke(Command(resume=resume), cfg, context=deps, durability="sync")
    return graph, cfg, emitter


def user_text(req) -> str:
    return next(m.content for m in req.messages if m.role == "user")


def system_text(req) -> str:
    return next(m.content for m in req.messages if m.role == "system")


def chunk_targets(emitter: ListEmitter) -> dict[int, dict]:
    return {s["seq"]: s for e in emitter.of("chunk_done") for s in e["segments"]}


# ---------------------------------------------------------------- 3.1 提示词与记忆


def test_translate_prompt_snapshot():
    expected = (SNAPSHOTS / "doc_translate_chunk.txt").read_text(encoding="utf-8")
    assert render(snapshot_messages()) == expected


def test_build_memory_respects_options():
    names = RollingNames([("Kubernetes", "Kubernetes"), ("kubelet", "kubelet"), ("Kubernetes", "K8s")])
    assert names.recent(10) == [("kubelet", "kubelet"), ("Kubernetes", "K8s")]  # 同一源词保留最近译法
    prev = [("a", "甲"), ("b", "乙"), ("c", "丙")]
    full = build_memory(DocOptions(), summary="摘要", names=names, prev_pairs=prev, max_names=1)
    assert full.summary == "摘要" and full.names == [("Kubernetes", "K8s")] and full.prev == prev[-2:]
    off = build_memory(
        DocOptions(context_window=False, global_summary=False), summary="摘要", names=None, prev_pairs=prev, max_names=5
    )
    assert off.summary is None and off.prev == [] and off.names == []


async def test_context_window_includes_previous_chunk_tail():
    """串行 + contextWindow：第 3 块的提示词包含第 2 块最后两段的原文与译文。"""
    fake = DocFakeLLM()
    await run_doc(sections(3), fake, options={"review": False, "termExtraction": False})
    reqs = fake.requests("translate")
    assert len(reqs) == 3
    third = user_text(reqs[2])
    assert "## 上文" in third
    assert "原文：para s1-0\n译文：译:para s1-0\n原文：para s1-1\n译文：译:para s1-1" in third
    assert "## 上文" not in user_text(reqs[0])
    assert "## 全文摘要\n本文介绍 Kubernetes 的部署方法。" in third


async def test_context_window_and_summary_disabled():
    fake = DocFakeLLM()
    await run_doc(sections(3), fake, options={"contextWindow": False, "globalSummary": False, "review": False})
    analyze = fake.requests("analyze")
    assert len(analyze) == 1 and "概括" not in system_text(analyze[0])  # 只做术语抽取，不要求摘要
    for req in fake.requests("translate"):
        assert "## 上文" not in user_text(req)
        assert "## 全文摘要" not in user_text(req)


async def test_review_disabled_has_no_review_calls():
    fake = DocFakeLLM()
    _, _, em = await run_doc(SAMPLE_DOC, fake, options={"review": False})
    assert fake.count("review") == 0 and fake.count("refine") == 0
    assert all(s["reviewScore"] is None and s["reviewRounds"] == 0 for s in chunk_targets(em).values())


async def test_all_analysis_options_off_skips_llm():
    fake = DocFakeLLM()
    _, _, em = await run_doc(SAMPLE_DOC, fake, options={"globalSummary": False, "termExtraction": False})
    assert fake.count("analyze") == 0
    assert em.of("analysis")[0] == {"summary": None, "domain": "通用", "genre": "", "candidates": []}


# ---------------------------------------------------------------- 3.2 分析与术语对齐


def test_clean_target_strips_source_annotation():
    assert clean_target("Deployment", "Deployment（部署）") == "部署"
    assert clean_target("Pod", "容器组 (Pod)") == "容器组"
    assert clean_target("Service", "服务（网络）") == "服务（网络）"  # 括号内不是原文：保留
    assert clean_target("GPU", "图形处理器") == "图形处理器"


async def test_terms_in_code_and_case_rules():
    """代码中的单词不算术语出现；含大写的抽取术语区分大小写（Deployment ≠ deployment）。"""
    text = (
        "## Setup\n\nSave it as `deployment.yaml` first.\n\nThe Deployment controller manages Pods.\n\n"
        "Automate the deployment of apps. Every Deployment has replicas.\n\n"
        "Run `kubectl` here. Also run `kubectl get pods` there.\n"
    )
    fake = DocFakeLLM(
        terms=[
            {"source": "Deployment", "target": "Deployment（部署）", "type": "term", "count": 3},
            {"source": "kubectl", "target": "kubectl", "type": "name", "count": 2},  # 只出现在代码中
        ],
        translate_fn=lambda seq, t: "译:" + t.replace("Deployment", "部署"),
    )
    # 用户确认后为硬约束，参与遵循判定（未确认的抽取术语为软约束，不参与，见 test_soft_term_*）
    resume = {"terms": [{"source": "Deployment", "target": "部署"}]}
    _, _, em = await run_doc(text, fake, confirmTerms=True, resume=resume, options={"review": False})
    analysis = em.of("analysis")[0]
    assert analysis["candidates"] == [{"source": "Deployment", "target": "部署", "origin": "extracted", "frequency": 2}]
    targets = chunk_targets(em)
    by_source = {s["seq"]: s for s in em.of("parsed")[0]["segments"]}
    for seq, seg in targets.items():
        src = by_source[seq]["source"]
        if "The Deployment" in src or "Every Deployment" in src:
            assert seg["compliance"] == [{"source": "Deployment", "target": "部署", "compliant": True}]
        else:  # `deployment.yaml` 与普通词 deployment 不要求术语译法
            assert seg["compliance"] == []
    assert em.of("consistency")[0]["issues"] == []
    assert em.of("completed")[0]["stats"]["compliance"] == {"ok": 2, "total": 2}


async def test_resume_with_user_added_term():
    text = "## A\n\nThe Pod runs. Another Pod waits.\n"
    fake = DocFakeLLM(terms=[{"source": "Pod", "target": "容器组", "type": "term", "count": 2}])
    resume = {
        "terms": [
            {"source": "Pod", "target": "容器组", "origin": "extracted"},
            {"source": "waits", "target": "等待中", "origin": "user"},  # 用户新增
        ]
    }
    graph, cfg, em = await run_doc(text, fake, confirmTerms=True, resume=resume, options={"review": False})
    terms = (await graph.aget_state(cfg)).values["terms"]
    assert terms == [
        {"source": "Pod", "target": "容器组", "caseSensitive": True, "binding": "hard"},
        {"source": "waits", "target": "等待中", "caseSensitive": False, "binding": "hard"},
    ]
    assert "| waits | 等待中 |" in system_text(fake.requests("translate")[0])
    assert next(t for t in em.of("trace") if t["node"] == "confirm_terms")["summary"] == (
        "用户确认 2 条术语，拒绝 0 条，新增 1 条"
    )


async def test_glossary_wins_over_extraction():
    fake = DocFakeLLM(
        terms=[
            {"source": "GPU", "target": "显卡", "type": "term", "count": 3},
            {"source": "training", "target": "训练", "type": "term", "count": 1},  # 只出现 1 次且不是专名：过滤
            {"source": "epoch", "target": "轮次", "type": "name", "count": 1},  # 专名即使只出现 1 次也保留
            {"source": "Hallucinated", "target": "幻觉", "type": "name", "count": 2},  # 原文中不存在：过滤
        ]
    )
    _, _, em = await run_doc(SAMPLE_DOC, fake, glossaryIds=[7], repo=FakeGlossaryRepo([GPU_GLOSSARY]))
    analysis = em.of("analysis")[0]
    assert analysis["candidates"] == [
        {"source": "GPU", "target": "图形处理器", "origin": "glossary", "frequency": 3},
        {"source": "epoch", "target": "轮次", "origin": "extracted", "frequency": 1},
    ]
    assert analysis["summary"] == fake.summary and analysis["domain"] == "计算机" and analysis["genre"] == "技术文档"
    traces = {t["node"]: t for t in em.of("trace")}
    assert traces["align_terms"]["summary"].startswith("术语库命中 1 条，抽取 1 条，合并后 2 条候选")
    # 未开启人工确认：任务术语表即全部候选，提示词中使用术语库译法
    assert "| GPU | 图形处理器 |" in system_text(fake.requests("translate")[0])


async def test_long_document_uses_map_reduce_summary():
    fake = DocFakeLLM()
    settings = {"doc_summary_single_max_tokens": 10, "doc_summary_section_tokens": 10}
    _, _, em = await run_doc(sections(3, paras=3), fake, settings=settings, options={"review": False})
    assert fake.count("analyze") == 3  # 每章一部分
    assert fake.count("reduce") == 1
    assert all("部分" in system_text(r) for r in fake.requests("analyze"))
    assert em.of("analysis")[0]["summary"] == "汇总：" + fake.summary
    assert "分 3 部分摘要后汇总" in next(t for t in em.of("trace") if t["node"] == "analyze")["summary"]


async def test_analysis_output_unparseable_is_tolerated():
    fake = DocFakeLLM(handlers={"analyze": lambda req, p, n: "这不是 JSON"})
    _, _, em = await run_doc(SAMPLE_DOC, fake, domain="医学")
    analysis = em.of("analysis")[0]
    assert analysis["summary"] is None and analysis["candidates"] == [] and analysis["domain"] == "医学"
    assert em.types()[-1] == "completed"


async def test_auto_language_detection_in_parse():
    fake = DocFakeLLM()
    _, _, em = await run_doc(fixture_text("short-note.txt"), fake, sourceLang="auto", format="txt")
    parsed = em.of("parsed")[0]
    assert parsed["detectedLang"] == "en" and 0 < parsed["confidence"] <= 1
    assert len(parsed["segments"]) == 3 and parsed["chunks"] == [{"index": 0, "segSeqs": [0, 1, 2], "group": 0}]


# ---------------------------------------------------------------- 3.3 术语确认与策略


async def test_confirm_terms_interrupt_and_resume_with_edits():
    text = "## Training\n\nEach epoch uses one batch.\n\nAnother epoch, another batch.\n"
    fake = DocFakeLLM(
        terms=[
            {"source": "epoch", "target": "轮次", "type": "term", "count": 2},
            {"source": "batch", "target": "批次", "type": "term", "count": 2},
        ]
    )
    graph = compile_doc_graph(InMemorySaver())
    em = ListEmitter()
    deps = make_doc_deps(fake, emitter=em)
    cfg = thread_config(7)
    payload = DocPayload.model_validate(doc_payload(text, sourceLang="en", confirmTerms=True))
    await graph.ainvoke(initial_state(7, payload), cfg, context=deps, durability="sync")
    snap = await graph.aget_state(cfg)
    assert snap.next == ("confirm_terms",)
    assert [c["source"] for c in snap.interrupts[0].value["candidates"]] == ["epoch", "batch"]
    json.dumps(snap.values, ensure_ascii=False)  # 中断时的状态只含 JSON 兼容类型
    assert fake.count("translate") == 0
    assert em.types()[-1] == "trace"  # 中断前不发 translating

    deps.emitter = em.child("t-2")
    await graph.ainvoke(
        Command(resume={"terms": [{"source": "epoch", "target": "训练轮次"}]}), cfg, context=deps, durability="sync"
    )
    snap = await graph.aget_state(cfg)
    assert snap.next == ()
    # 规格场景"修改后确认"：确认的术语全部为硬约束，以必须使用的术语出现
    expected = [{"source": "epoch", "target": "训练轮次", "caseSensitive": False, "binding": "hard"}]
    assert snap.values["terms"] == expected
    for req in fake.requests("translate"):
        system = system_text(req)
        hard_section = system.split("## 术语表（必须使用）\n", 1)[1].split("\n\n", 1)[0]
        assert "| epoch | 训练轮次 |" in hard_section
        assert "参考译法" not in system
        assert "batch |" not in system
    confirm = next(t for t in em.of("trace") if t["node"] == "confirm_terms")
    assert confirm["summary"] == "用户确认 1 条术语，拒绝 1 条，修改译法 1 条"
    resumed = [e["type"] for e in em.events if e["traceId"] == "t-2"]
    assert resumed[:2] == ["phase", "trace"] and resumed[-1] == "completed"


async def test_confirm_terms_with_postgres_checkpointer():
    """AsyncPostgresSaver（ai schema）：中断后的状态可以持久化并在新的图实例上恢复。"""
    settings = get_settings()
    pool = make_checkpoint_pool(settings)
    await pool.open()
    try:
        saver = AsyncPostgresSaver(conn=pool)
        await saver.setup()
        task_id = random.randint(10**9, 2 * 10**9)
        fake = DocFakeLLM(terms=[{"source": "GPU", "target": "显卡", "type": "term", "count": 3}])
        em = ListEmitter(task_id)
        cfg = thread_config(task_id)
        payload = DocPayload.model_validate(doc_payload(SAMPLE_DOC, sourceLang="en", confirmTerms=True))
        await compile_doc_graph(saver).ainvoke(
            initial_state(task_id, payload), cfg, context=make_doc_deps(fake, emitter=em), durability="sync"
        )
        fresh = compile_doc_graph(saver)  # 模拟进程重启后的新图实例
        snap = await fresh.aget_state(cfg)
        assert snap.interrupts and snap.values["candidates"][0]["source"] == "GPU"
        await fresh.ainvoke(
            Command(resume={"terms": [{"source": "GPU", "target": "图形处理器"}]}),
            cfg,
            context=make_doc_deps(fake, emitter=em.child("t-2")),
            durability="sync",
        )
        assert (await fresh.aget_state(cfg)).next == ()
        assert em.types()[-1] == "completed"
        async with pool.connection() as conn:  # 检查点表建在 ai schema
            cur = await conn.execute("select count(*) as n from ai.checkpoints where thread_id = %s", (str(task_id),))
            assert (await cur.fetchone())["n"] > 0
        await saver.adelete_thread(str(task_id))
        assert (await fresh.aget_state(cfg)).created_at is None
    finally:
        await pool.close()


class ConcurrencyFake(DocFakeLLM):
    """记录同时进行中的翻译调用数。"""

    def __init__(self, **kw):
        super().__init__(**kw)
        self.active = 0
        self.max_active = 0
        self.order: list[int] = []

    async def chat(self, req):
        if system_text(req).startswith("你是一名专业的篇章译者，负责把"):
            self.active += 1
            self.max_active = max(self.max_active, self.active)
            payload = json.loads(user_text(req).split("## 待译段落\n", 1)[1])
            self.order.append(payload["segments"][0]["id"])
            try:
                await asyncio.sleep(0.02)
                return await super().chat(req)
            finally:
                self.active -= 1
        return await super().chat(req)


async def test_hybrid_strategy_runs_chapters_concurrently():
    """3 个章节 9 块：章间并发、章内顺序，并带有本章前一块的上下文。"""
    text = "".join(
        f"## Chapter {c}\n\n" + "".join(f"### Part {c}.{p}\n\nbody {c}.{p}\n\n" for p in range(3)) for c in range(3)
    )
    fake = ConcurrencyFake()
    settings = {"doc_chunk_target_tokens": 3, "doc_chunk_max_tokens": 6}
    _, _, em = await run_doc(
        text,
        fake,
        strategy="hybrid",
        settings=settings,
        options={"review": False, "termExtraction": False, "globalSummary": False},
    )
    chunks = em.of("parsed")[0]["chunks"]
    assert len(chunks) >= 9 and len({c["group"] for c in chunks}) == 3
    assert fake.max_active == 3
    # 每章第一块没有上文，之后的块带本章前一块的上下文
    by_first_seg = {
        json.loads(user_text(r).split("## 待译段落\n", 1)[1])["segments"][0]["id"]: user_text(r)
        for r in fake.requests("translate")
    }
    for c in chunks:
        first_in_group = c["index"] == min(x["index"] for x in chunks if x["group"] == c["group"])
        prompt = by_first_seg[next(q for q in c["segSeqs"])]
        assert ("## 上文" in prompt) != first_in_group
    # 组内顺序：同一章的块按序号完成
    done = [e["chunk"] for e in em.of("chunk_done")]
    for g in {c["group"] for c in chunks}:
        idx = [c["index"] for c in chunks if c["group"] == g]
        assert [d for d in done if d in idx] == sorted(idx)


async def test_serial_and_parallel_concurrency():
    text = sections(4, paras=1)
    serial = ConcurrencyFake()
    await run_doc(text, serial, options={"review": False, "termExtraction": False})
    assert serial.max_active == 1
    parallel = ConcurrencyFake()
    await run_doc(text, parallel, strategy="parallel", options={"review": False, "termExtraction": False})
    assert parallel.max_active == 3  # doc_chunk_concurrency 默认 3
    # parallel 下各块之间不共享前块上下文与滚动专名表
    for req in parallel.requests("translate"):
        assert "## 上文" not in user_text(req) and "## 已知专名译法" not in user_text(req)


# ---------------------------------------------------------------- 3.4 分块翻译


def _drop_id(target_id: int):
    """第一次翻译调用时漏掉某个段落。"""

    def handler(req, payload, n):
        segs = [{"id": s["id"], "text": "译:" + s["text"]} for s in payload["segments"]]
        if n == 0:
            segs = [s for s in segs if s["id"] != target_id]
        return json.dumps({"segments": segs, "names": []}, ensure_ascii=False)

    return handler


async def test_missing_segment_is_translated_individually():
    text = "\n\n".join(f"Paragraph number {i}." for i in range(6)) + "\n"
    fake = DocFakeLLM(handlers={"translate": _drop_id(3)})
    _, _, em = await run_doc(text, fake, format="txt", options={"review": False, "termExtraction": False})
    assert fake.count("translate") == 2
    single = json.loads(user_text(fake.requests("translate")[1]).split("## 待译段落\n", 1)[1])
    assert [s["id"] for s in single["segments"]] == [3]
    targets = chunk_targets(em)
    assert len(targets) == 6 and targets[3]["target"] == "译:Paragraph number 3."
    assert "补译或重译 1 段" in next(t for t in em.of("trace") if t["node"] == "translate_chunk")["summary"]


async def test_missing_segment_still_missing_fails_task():
    def handler(req, payload, n):
        return json.dumps({"segments": [{"id": s["id"], "text": "x"} for s in payload["segments"] if s["id"] != 1]})

    fake = DocFakeLLM(handlers={"translate": handler})
    with pytest.raises(Exception) as ei:
        await run_doc("a\n\nb\n", fake, format="txt", options={"review": False, "termExtraction": False})
    assert getattr(ei.value, "error_code", None) is not None and ei.value.error_code.code == "C0150"


async def test_unusable_output_retries_whole_chunk():
    calls = []

    def handler(req, payload, n):
        calls.append(n)
        if n == 0:
            return "抱歉，我无法输出 JSON"
        return json.dumps({"segments": [{"id": s["id"], "text": "译:" + s["text"]} for s in payload["segments"]]})

    fake = DocFakeLLM(handlers={"translate": handler})
    _, _, em = await run_doc("a\n\nb\n", fake, format="txt", options={"review": False, "termExtraction": False})
    assert calls == [0, 1] and len(chunk_targets(em)) == 2


async def test_marker_loss_triggers_single_retranslation():
    text = "Run `npm install` now.\n\nSee [docs](https://example.com).\n"

    def handler(req, payload, n):
        segs = []
        for s in payload["segments"]:
            t = "译:" + s["text"]
            if n == 0 and s["id"] == 0:
                t = "运行安装命令"  # 第一次丢失标记
            segs.append({"id": s["id"], "text": t})
        return json.dumps({"segments": segs})

    fake = DocFakeLLM(handlers={"translate": handler})
    _, _, em = await run_doc(text, fake, format="txt", options={"review": False, "termExtraction": False})
    targets = chunk_targets(em)
    assert targets[0]["target"] == "译:Run `npm install` now."
    assert targets[1]["target"] == "译:See [docs](https://example.com)."
    assert fake.count("translate") == 2


async def test_persistent_marker_loss_keeps_source_and_reports():
    text = "Run `npm install` now.\n\nPlain text.\n"

    def handler(req, payload, n):
        return json.dumps(
            {
                "segments": [
                    {"id": s["id"], "text": "丢了标记" if s["id"] == 0 else "译:" + s["text"]}
                    for s in payload["segments"]
                ]
            }
        )

    fake = DocFakeLLM(handlers={"translate": handler})
    _, _, em = await run_doc(text, fake, format="txt", options={"review": False, "termExtraction": False})
    targets = chunk_targets(em)
    assert targets[0]["target"] == "Run `npm install` now."  # 保留原文
    consistency = em.of("consistency")[0]
    assert consistency["protectionFailures"][0]["seq"] == 0
    assert "缺失标记" in consistency["protectionFailures"][0]["problem"]


async def test_review_below_threshold_refines_once():
    fake = DocFakeLLM(review_scores=[70, 88])
    _, _, em = await run_doc("## Usage\n\nUse the GPU.\n", fake, options={"termExtraction": False})
    assert fake.kinds()[-4:] == ["translate", "review", "refine", "review"]
    seg = chunk_targets(em)[1]
    assert seg["reviewScore"] == 88 and seg["reviewRounds"] == 1 and seg["target"].endswith("（修）")
    trace = next(t for t in em.of("trace") if t["node"] == "translate_chunk")
    assert "评审 70→88 分（修正 1 轮）" in trace["summary"]
    assert em.of("completed")[0]["stats"]["refined"] == 1


async def test_rule_term_violation_triggers_refine_and_compliance():
    fake = DocFakeLLM()
    _, _, em = await run_doc(SAMPLE_DOC, fake, glossaryIds=[7], repo=FakeGlossaryRepo([GPU_GLOSSARY]))
    # 首译保留了 GPU（未遵循术语库的硬约束术语），评审 95 分且没有问题，规则检查仍触发修正
    assert fake.count("refine") == 2
    seg = chunk_targets(em)[1]
    assert seg["compliance"] == [{"source": "GPU", "target": "图形处理器", "compliant": False}]


async def test_cached_chunk_skips_llm():
    store = MemoryStore()
    cached = {
        "index": 0,
        "segments": [
            {"seq": 0, "target": "缓存标题", "reviewScore": 90, "reviewRounds": 0, "compliance": []},
            {"seq": 1, "target": "缓存正文", "reviewScore": 90, "reviewRounds": 0, "compliance": []},
        ],
        "names": [["GPU", "GPU"]],
        "latencyMs": 1234,
        "reviewRounds": 0,
    }
    await store.put(42, 0, cached, {"promptTokens": 500, "completionTokens": 50})
    fake = DocFakeLLM()
    _, _, em = await run_doc(SAMPLE_DOC, fake, store=store, options={"review": False, "termExtraction": False})
    translated_ids = [
        s["id"]
        for r in fake.requests("translate")
        for s in json.loads(user_text(r).split("## 待译段落\n", 1)[1])["segments"]
    ]
    assert translated_ids == [2, 3]  # 第 0 块没有调用 LLM
    done = em.of("chunk_done")
    assert done[0] == {
        "chunk": 0,
        "segments": cached["segments"],
        "usage": {"promptTokens": 0, "completionTokens": 0},
        "latencyMs": 0,
        "cached": True,
        "reviewIssues": None,
    }
    assert done[1]["cached"] is False
    assert (42, 1) in store.rows  # 新完成的块写入缓存
    completed = em.of("completed")[0]
    assert completed["stats"]["cachedChunks"] == 1
    assert completed["usage"]["promptTokens"] >= 500  # 总用量包含缓存块当初的用量


async def test_untranslatable_chunk_reports_without_llm():
    text = "## A\n\ntext\n\n```\ncode only\n```\n"
    fake = DocFakeLLM()
    settings = {"doc_chunk_target_tokens": 1}
    _, _, em = await run_doc(text, fake, settings=settings, options={"review": False, "termExtraction": False})
    done = em.of("chunk_done")
    assert done[-1]["segments"] == [] and done[-1]["cached"] is False
    assert fake.count("translate") == 2  # 标题块和正文块；纯代码块不调用


async def test_empty_document_completes():
    fake = DocFakeLLM()
    _, _, em = await run_doc("", fake, sourceLang="auto")
    assert fake.calls == []
    assert em.types() == [
        "phase",
        "parsed",
        "trace",
        "phase",
        "analysis",
        "trace",
        "trace",
        "phase",
        "phase",
        "consistency",
        "trace",
        "phase",
        "completed",
    ]
    assert em.of("completed")[0]["stats"]["chunks"] == 0


# ---------------------------------------------------------------- 3.5 一致性


def _k8s_doc() -> str:
    return "".join(f"## Part {i}\n\nKubernetes runs workload {i}.\n\n" for i in range(6))


def _k8s_translate(bad_seq: int):
    def handler(req, payload, n):
        segs, names = [], []
        for s in payload["segments"]:
            name = "库伯内特斯" if s["id"] == bad_seq else "Kubernetes"
            segs.append({"id": s["id"], "text": "译:" + s["text"].replace("Kubernetes", name)})
            if "Kubernetes" in s["text"]:
                names.append({"source": "Kubernetes", "target": name})
        return json.dumps({"segments": segs, "names": names}, ensure_ascii=False)

    return handler


def _fix_handler(replacement: str | None):
    def handler(req, payload, n):
        segs = [
            {"id": s["id"], "text": s["translation"].replace("库伯内特斯", replacement or "库伯内特斯")}
            for s in payload["segments"]
        ]
        return json.dumps({"segments": segs}, ensure_ascii=False)

    return handler


async def test_consistency_unifies_proper_name():
    """Kubernetes 在 5 段中保留原文、1 段译为"库伯内特斯"，没有术语表规定：选定多数并修正那 1 段。"""
    bad = 9  # 第 5 章正文（每章 2 段：标题 2i、正文 2i+1）
    fake = DocFakeLLM(handlers={"translate": _k8s_translate(bad), "fix": _fix_handler("Kubernetes")})
    _, _, em = await run_doc(_k8s_doc(), fake, strategy="parallel", options={"review": False, "termExtraction": False})
    data = em.of("consistency")[0]
    assert data["issues"] == [
        {
            "term": "Kubernetes",
            "variants": [{"text": "Kubernetes", "count": 5}, {"text": "库伯内特斯", "count": 1}],
            "chosen": "Kubernetes",
            "fixedSegs": [bad],
            "unresolvedSegs": [],
        }
    ]
    assert data["segments"] == [{"seq": bad, "target": "译:Kubernetes runs workload 4."}]
    fix_req = fake.requests("fix")[0]
    assert "「Kubernetes」" in system_text(fix_req) and json.loads(user_text(fix_req))["segments"][0]["id"] == bad
    trace = next(t for t in em.of("trace") if t["node"] == "consistency")
    assert trace["summary"] == "发现 1 处不一致，已修正 1 段"


async def test_consistency_unresolved_when_fix_fails():
    bad = 3
    fake = DocFakeLLM(handlers={"translate": _k8s_translate(bad), "fix": _fix_handler(None)})
    _, _, em = await run_doc(_k8s_doc(), fake, strategy="parallel", options={"review": False, "termExtraction": False})
    issue = em.of("consistency")[0]["issues"][0]
    assert issue["fixedSegs"] == [] and issue["unresolvedSegs"] == [bad]
    assert em.of("consistency")[0]["segments"] == []
    assert "1 段未能自动修正" in next(t for t in em.of("trace") if t["node"] == "consistency")["summary"]


async def test_consistency_task_term_beats_majority_and_detects_untranslated_source():
    """任务术语表规定 GPU→图形处理器：保留了源词 GPU 的段落被定向修正（与契约样例一致）。"""

    def translate(req, payload, n):
        segs = []
        for s in payload["segments"]:
            t = s["text"].replace("GPU", "图形处理器") if s["id"] != 3 else s["text"]
            segs.append({"id": s["id"], "text": "译:" + t})
        return json.dumps({"segments": segs}, ensure_ascii=False)

    def fix(req, payload, n):
        return json.dumps(
            {
                "segments": [
                    {"id": s["id"], "text": s["translation"].replace("GPU", "图形处理器")} for s in payload["segments"]
                ]
            },
            ensure_ascii=False,
        )

    fake = DocFakeLLM(handlers={"translate": translate, "fix": fix})
    _, _, em = await run_doc(
        SAMPLE_DOC,
        fake,
        glossaryIds=[7],
        repo=FakeGlossaryRepo([GPU_GLOSSARY]),
        options={"review": False, "termExtraction": False},
    )
    data = em.of("consistency")[0]
    assert data["issues"] == [
        {
            "term": "GPU",
            "variants": [{"text": "图形处理器", "count": 2}, {"text": "GPU", "count": 1}],
            "chosen": "图形处理器",
            "fixedSegs": [3],
            "unresolvedSegs": [],
        }
    ]
    assert data["segments"] == [{"seq": 3, "target": "译:Use the 图形处理器 for each epoch."}]
    completed = em.of("completed")[0]
    assert completed["stats"]["compliance"] == {"ok": 3, "total": 3}  # 统计基于一致性修正后的译文


async def test_pg_chunk_store_roundtrip():
    from app.core.db import Database

    db = Database(get_settings())
    await db.open()
    try:
        store = PgChunkStore(db)
        task_id = random.randint(10**9, 2 * 10**9)
        assert await store.get(task_id, 0) is None
        await store.put(task_id, 0, {"index": 0, "segments": [{"seq": 1, "target": "中文"}]}, {"promptTokens": 3})
        await store.put(task_id, 0, {"index": 0, "segments": [{"seq": 1, "target": "覆盖"}]}, {"promptTokens": 5})
        got = await store.get(task_id, 0)
        assert got["segments"][0]["target"] == "覆盖" and got["usage"] == {"promptTokens": 5}
        await store.purge(task_id)
        assert await store.get(task_id, 0) is None
    finally:
        await db.close()
