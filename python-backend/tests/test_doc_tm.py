"""add-session-context-and-memory 2.9：文档分块按段检索翻译记忆（段落命中、关闭记忆、记忆服务不可用）。"""

import pytest
from langgraph.checkpoint.memory import InMemorySaver

from app.core.config import get_settings
from app.core.db import Database
from app.doc import prompts
from app.doc.graph import compile_doc_graph, initial_state, thread_config
from app.doc.state import DocPayload
from app.memory.tm import TmEntryIn, TranslationMemory
from tests.doc_fakes import DocFakeLLM, ListEmitter, doc_payload, make_doc_deps
from tests.fakes import FakeEmbedding

DOC = (
    "# Guide\n\n"
    "Restart the Pod after updating the ConfigMap.\n\n"
    "Use **kubectl apply** to deploy the app.\n\n"
    "Something completely unrelated here.\n"
)


@pytest.fixture
async def tm(tm_admin):
    settings = get_settings()
    db = Database(settings)
    await db.open()
    emb = FakeEmbedding()
    repo = TranslationMemory(db, emb, settings)
    await repo.upsert(
        1,
        [
            TmEntryIn("en", "zh", "Restart the Pod after updating the ConfigMap.", "更新 ConfigMap 后重启该 Pod。"),
            TmEntryIn(
                "en", "zh", "Use kubectl apply to deploy the app", "使用 kubectl apply 部署应用", "document", "9:3"
            ),
        ],
    )
    try:
        yield repo, emb, tm_admin
    finally:
        await db.close()


async def run_doc(fake: DocFakeLLM, tm, **kw):
    graph = compile_doc_graph(InMemorySaver())
    emitter = ListEmitter()
    deps = make_doc_deps(fake, emitter=emitter)
    deps.tm = tm
    payload = DocPayload.model_validate(
        doc_payload(DOC, sourceLang="en", options={"review": False, "termExtraction": False}, **kw)
    )
    await graph.ainvoke(initial_state(42, payload), thread_config(42), context=deps, durability="sync")
    return emitter


def translate_users(fake: DocFakeLLM) -> list[str]:
    return [r.messages[1].content for r in fake.requests("translate")]


def segments(emitter: ListEmitter) -> dict[int, dict]:
    return {s["seq"]: s for e in emitter.of("chunk_done") for s in e["segments"]}


async def test_segment_hits_translation_memory(tm):
    repo, _, admin = tm
    fake = DocFakeLLM()
    em = await run_doc(fake, repo)
    segs = segments(em)
    hit_segs = {seq: s["tmHits"] for seq, s in segs.items() if s["tmHits"]}
    assert len(hit_segs) == 2  # 第 3 段完全不相关，不入选
    by_source = {h[0]["source"]: h[0] for h in hit_segs.values()}
    exact = by_source["Restart the Pod after updating the ConfigMap."]
    assert exact["fuzzy"] == 1.0 and set(exact) == {
        "id",
        "source",
        "target",
        "fuzzy",
        "semantic",
        "origin",
        "originRef",
    }
    # 行内标记去除后检索：与写入时的纯文本对齐
    assert by_source["Use kubectl apply to deploy the app"]["fuzzy"] > 0.95
    assert all(len(s["tmHits"]) <= 1 for s in segs.values())
    user = translate_users(fake)[0]
    assert f"## {prompts.TM_TITLE}" in user and "更新 ConfigMap 后重启该 Pod。" in user
    assert user.index(prompts.TM_TITLE) < user.index("## 待译段落")
    trace = next(t for t in em.of("trace") if t["node"] == "translate_chunk")
    assert "命中 2 条翻译记忆" in trace["summary"]
    assert admin.execute("select sum(hit_count) from ai.translation_memory").fetchone()[0] == 2


async def test_translation_memory_disabled_or_no_user(tm):
    repo, emb, _ = tm
    for kw in ({"options": {"translationMemory": False}}, {"userId": None}):
        fake = DocFakeLLM()
        emb.calls.clear()
        options = {"review": False, "termExtraction": False, **kw.pop("options", {})}
        graph = compile_doc_graph(InMemorySaver())
        em = ListEmitter()
        deps = make_doc_deps(fake, emitter=em)
        deps.tm = repo
        payload = DocPayload.model_validate(doc_payload(DOC, sourceLang="en", options=options, **kw))
        await graph.ainvoke(initial_state(42, payload), thread_config(42), context=deps, durability="sync")
        assert emb.calls == []  # 不检索
        assert all(s["tmHits"] == [] for s in segments(em).values())
        assert all(prompts.TM_TITLE not in u for u in translate_users(fake))


async def test_translation_memory_unavailable_or_failing(tm):
    repo, emb, _ = tm
    emb.available = False
    em = await run_doc(DocFakeLLM(), repo)
    assert em.types()[-1] == "completed"
    assert all(s["tmHits"] == [] for s in segments(em).values())
    trace = next(t for t in em.of("trace") if t["node"] == "translate_chunk")
    assert "翻译记忆不可用" in trace["summary"]

    class Broken:
        async def search_segments(self, *a, **kw):
            raise RuntimeError("db down")

    em = await run_doc(DocFakeLLM(), Broken())
    assert em.types()[-1] == "completed"
    assert "翻译记忆检索失败" in next(t for t in em.of("trace") if t["node"] == "translate_chunk")["summary"]


def test_doc_options_default_translation_memory_on():
    payload = DocPayload.model_validate({"text": "x", "targetLang": "zh"})
    assert payload.options.translation_memory is True
    assert payload.model_dump(by_alias=True)["options"]["translationMemory"] is True
