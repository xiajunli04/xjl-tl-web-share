"""add-session-context-and-memory 2.4–2.8：会话上下文与提示词、retrieve 检索翻译记忆、修订路径、歧义追问
（检查点、中断与恢复、放弃与清理）、memorize 会话记忆压缩、检查点序列化往返。
"""

import json
import os
import uuid
from pathlib import Path

import pytest
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer

from app.agent import prompts
from app.agent import session as session_mod
from app.agent.graph import emitted_node_events, run_agent, thread_id_of, wants_hitl
from app.agent.hitl import SERDE_ALLOWLIST, TurnCheckpoints, make_serde
from app.agent.state import (
    NodeTrace,
    Review,
    ReviewIssue,
    TextFeatures,
    TranslateRequest,
    TranslationContext,
)
from app.core.config import get_settings
from app.core.db import Database
from app.core.errors import BizException
from app.glossary.matcher import TermCompliance, TermHit
from app.llm.base import LLMError, LLMErrorKind, Usage
from app.memory.tm import TmEntryIn, TranslationMemory
from tests.fakes import FakeEmbedding, FakeLLM, parse_sse, review_json, use_fake_llm
from tests.test_agent import collect, make_deps, nodes, of

SNAPSHOTS = Path(__file__).parent / "snapshots"

AMBIGUOUS = json.dumps(
    {
        "domain": "金融",
        "ambiguity": {
            "ambiguous": True,
            "span": "bank",
            "question": "bank 指什么？",
            "options": ["银行", "河岸"],
            "reason": "多义词",
        },
    },
    ensure_ascii=False,
)


def session(**kw) -> dict:
    base = {
        "sessionId": 7,
        "clarifyEnabled": True,
        "recentTurns": [
            {"seq": 1, "source": "I bought the X200 headphones last week.", "target": "我上周买了 X200 耳机。"}
        ],
        "summary": None,
        "entities": [{"source": "X200", "target": "X200", "note": "耳机型号"}],
        "toMemorize": [],
        "memorizedUntil": 0,
        "turnSeq": 2,
    }
    base.update(kw)
    return base


def req(**kw) -> TranslateRequest:
    base = {"text": "It stopped working yesterday.", "sourceLang": "en", "targetLang": "zh", "userId": 1}
    base.update(kw)
    return TranslateRequest.model_validate(base)


def system_of(fake: FakeLLM, kind: str) -> str:
    return next(r for k, r in fake.calls if k == kind).messages[0].content


def user_of(fake: FakeLLM, kind: str) -> str:
    return next(r for k, r in fake.calls if k == kind).messages[1].content


# ---------------------------------------------------------------- 请求模型与会话窗口


def test_request_session_and_revise_parsing():
    r = req(session=session(recentTurns=None, entities=None, toMemorize=None, clarifyEnabled=None, memorizedUntil=None))
    assert r.session.recent_turns == [] and r.session.clarify_enabled is True and r.session.memorized_until == 0
    with pytest.raises(BizException):
        req(mode="revise").check(5000)
    ok = req(mode="revise", revise={"recordId": 12, "baseSource": "a", "baseTarget": "甲", "instruction": "更口语"})
    ok.check(5000)
    assert ok.revise.record_id == 12
    with pytest.raises(ValueError):
        req(mode="revise", revise={"baseTarget": "甲", "instruction": "x" * 501})


def test_window_turns_truncation():
    s = get_settings()
    turns = [{"seq": i, "source": f"s{i}" + "a" * 600, "target": f"t{i}" + "b" * 600} for i in range(1, 9)]
    payload = req(session=session(recentTurns=turns + [{"source": " ", "target": ""}])).session
    items = session_mod.window_turns(payload, s)
    # 每轮原文/译文截断到 500 字符（+省略号）→ 总量 ≤4000，从最早的轮次丢弃
    assert [i["seq"] for i in items] == [6, 7, 8]
    assert all(len(i["source"]) == 501 and i["source"].endswith("…") for i in items)
    assert session_mod.window_turns(None, s) == []
    assert session_mod.window_turns(payload, s.model_copy(update={"session_window_turns": 0})) == []
    no_seq = req(session=session(recentTurns=[{"source": "a", "target": "b"}])).session
    assert session_mod.window_turns(no_seq, s)[0]["seq"] == 1


def test_window_keeps_eight_turns_not_yet_memorized():
    # improve-prompts-and-context-memory D6：Spring 下发尚未压缩的最多 8 轮，Python 不再截到 6 轮
    turns = [{"seq": i, "source": f"s{i}", "target": f"t{i}"} for i in range(1, 9)]
    payload = req(session=session(recentTurns=turns)).session
    assert [i["seq"] for i in session_mod.window_turns(payload, get_settings())] == list(range(1, 9))


def test_parse_ambiguity_and_memory():
    assert session_mod.parse_ambiguity(json.loads(AMBIGUOUS))["options"] == ["银行", "河岸"]
    assert session_mod.parse_ambiguity(None) is None
    assert session_mod.parse_ambiguity({"ambiguity": {"ambiguous": "yes"}}) is None
    one_option = {"ambiguity": {"ambiguous": True, "span": "it", "question": "?", "options": ["a", "a", ""]}}
    assert session_mod.parse_ambiguity(one_option) is None  # 少于 2 个选项视为无歧义
    many = {"ambiguity": {"ambiguous": True, "span": "x", "question": "q", "options": list("abcdef"), "reason": ""}}
    parsed = session_mod.parse_ambiguity(many)
    assert parsed["options"] == list("abcd") and parsed["reason"] == "歧义"
    assert session_mod.parse_domain({"domain": 3}, str) is None

    assert session_mod.parse_memory("not json", max_chars=300, max_entities=30) is None
    assert session_mod.parse_memory('{"summary": ""}', max_chars=300, max_entities=30) is None
    summary, entities = session_mod.parse_memory(
        json.dumps(
            {
                "summary": "很长" * 200,
                "entities": [
                    {"source": "Alice", "target": "爱丽丝", "note": ""},
                    {"source": "alice", "target": "重复"},
                    {"source": "", "target": "x"},
                    "bad",
                    {"source": "Bob", "target": "鲍勃", "note": "客户"},
                ],
            },
            ensure_ascii=False,
        ),
        max_chars=300,
        max_entities=1,
    )
    assert len(summary) == 300 and entities == [{"source": "Alice", "target": "爱丽丝", "note": None}]


# ---------------------------------------------------------------- 提示词


def _session_ctx() -> TranslationContext:
    return TranslationContext(
        terms=[TermHit("GPU", "图形处理器", 7)],
        style="fluent",
        tm_examples=[{"source": "Restart the Pod.", "target": "重启 Pod。"}],
        session_ctx=[{"seq": 1, "source": "I bought the X200.", "target": "我买了 X200。"}],
        session_summary="客户在咨询耳机售后。",
        session_entities=[{"source": "X200", "target": "X200", "note": "耳机型号"}, {"source": "Li", "target": "李"}],
        clarification={"question": "bank 指什么？", "options": ["银行", "河岸"], "span": "bank", "answer": "银行"},
    )


def test_session_prompt_snapshot():
    system = prompts.translate_system_prompt(_session_ctx(), "en", "zh")
    snap = SNAPSHOTS / "translate_system_session.txt"
    if os.environ.get("UPDATE_SNAPSHOTS") or not snap.exists():
        snap.write_text(system, encoding="utf-8")
    assert system == snap.read_text(encoding="utf-8")
    for title in (prompts.SESSION_ENTITIES_TITLE, prompts.TM_TITLE, prompts.SESSION_TITLE, prompts.CLARIFICATION_TITLE):
        assert f"## {title}" in system
    assert "| X200 | X200 | 耳机型号 |" in system and "| Li | 李 |  |" in system
    assert "### 早期摘要\n客户在咨询耳机售后。" in system and "[第 1 轮]\n原文：I bought the X200." in system
    assert "不要照抄" in system and "「bank」指「银行」" in system
    # 没有会话与记忆时不输出这些小节
    plain = prompts.translate_system_prompt(TranslationContext(), "en", "zh")
    assert "会话" not in plain and "翻译记忆" not in plain and "用户澄清" not in plain
    only_summary = prompts.translate_system_prompt(TranslationContext(session_summary="摘要"), "en", "zh")
    assert "### 早期摘要" in only_summary and "### 最近轮次" not in only_summary


def test_revise_prompt():
    msgs = prompts.revise_messages(_session_ctx(), "src", "旧译文", "更口语一些", "en", "zh")
    assert "按用户的修订要求修改" in msgs[0].content and "## 会话上下文" in msgs[0].content
    assert "<instruction>\n更口语一些\n</instruction>" in msgs[1].content and "<translation>\n旧译文" in msgs[1].content


# ---------------------------------------------------------------- 会话上下文进入提示词（快速路径也带）


async def test_pronoun_turn_prompt_contains_previous_turn():
    fake = FakeLLM(translations=["它昨天坏了。"])
    events = await collect(req(session=session(clarifyEnabled=False)), make_deps(fake))
    assert of(events, "plan")[0]["path"] == "fast"
    system = system_of(fake, "translate")
    assert "I bought the X200 headphones last week." in system and "我上周买了 X200 耳机。" in system
    assert "| X200 | X200 | 耳机型号 |" in system
    final = of(events, "final")[0]
    assert final["clarification"] is None and final["tmHits"] == []
    assert "memorize" not in [n for n, _ in nodes(events)] and of(events, "memory") == []


# ---------------------------------------------------------------- retrieve 检索翻译记忆


@pytest.fixture
async def tm(tm_admin):
    settings = get_settings()
    db = Database(settings)
    await db.open()
    emb = FakeEmbedding()
    try:
        yield TranslationMemory(db, emb, settings), emb
    finally:
        await db.close()


async def test_retrieve_injects_translation_memory(tm):
    repo, _ = tm
    await repo.upsert(
        1, [TmEntryIn("en", "zh", "Restart the Pod after updating the ConfigMap.", "更新 ConfigMap 后重启 Pod。")]
    )
    fake = FakeLLM(translations=["更新 Secret 后重启 Pod。"], reviews=[review_json(95)])
    deps = make_deps(fake)
    deps.tm = repo
    events = await collect(
        req(text="Restart the Pod after updating the Secret.", mode="standard", session=session(clarifyEnabled=False)),
        deps,
    )
    retrieve = [d for e, d in events if e == "node" and d["node"] == "retrieve" and d["status"] == "completed"][0]
    assert "命中 1 条翻译记忆（最高 8" in retrieve["summary"] and "会话上下文 1 轮" in retrieve["summary"]
    hits = retrieve["detail"]["tmHits"]
    assert retrieve["detail"]["sessionTurns"] == 1 and len(hits) == 1 and 0.75 < hits[0]["fuzzy"] < 0.9
    system = system_of(fake, "translate")
    assert f"## {prompts.TM_TITLE}" in system and "更新 ConfigMap 后重启 Pod。" in system
    assert of(events, "final")[0]["tmHits"] == hits


async def test_retrieve_semantic_only_summary_and_no_hit(tm):
    repo, emb = tm
    base, query = "How do I get a refund?", "What is the process for getting my money back?"
    emb.set_similar(base, query, 0.95)
    await repo.upsert(1, [TmEntryIn("en", "zh", base, "我怎样才能退款？")])
    fake = FakeLLM(translations=["退款流程是什么？", "无"], reviews=[review_json(95), review_json(95)])
    deps = make_deps(fake)
    deps.tm = repo
    events = await collect(req(text=query, mode="standard"), deps)
    retrieve = [d for e, d in events if e == "node" and d["node"] == "retrieve" and d["status"] == "completed"][0]
    assert "最高 语义 95%" in retrieve["summary"]
    events = await collect(req(text="Nothing similar at all.", mode="standard"), deps)
    retrieve = [d for e, d in events if e == "node" and d["node"] == "retrieve" and d["status"] == "completed"][0]
    assert retrieve["summary"].endswith("未命中翻译记忆") and retrieve["detail"]["tmHits"] == []


async def test_retrieve_tm_unavailable_or_failing_does_not_break_translation(tm):
    repo, emb = tm
    emb.available = False
    fake = FakeLLM(translations=["你好"], reviews=[review_json(95)])
    deps = make_deps(fake)
    deps.tm = repo
    events = await collect(req(text="Hello", mode="standard"), deps)
    retrieve = [d for e, d in events if e == "node" and d["node"] == "retrieve" and d["status"] == "completed"][0]
    assert retrieve["summary"].endswith("翻译记忆不可用") and of(events, "final")[0]["translation"] == "你好"

    class Broken:
        async def search(self, *a, **kw):
            raise RuntimeError("db down")

    fake = FakeLLM(translations=["你好"], reviews=[review_json(95)])
    deps = make_deps(fake)
    deps.tm = Broken()
    events = await collect(req(text="Hello", mode="standard"), deps)
    retrieve = [d for e, d in events if e == "node" and d["node"] == "retrieve" and d["status"] == "completed"][0]
    assert retrieve["summary"].endswith("翻译记忆检索失败")


# ---------------------------------------------------------------- 修订路径


def revise_req(**kw) -> TranslateRequest:
    return req(
        text="Please send it to the bank.",
        mode="revise",
        revise={
            "recordId": 12,
            "baseSource": "Please send it to the bank.",
            "baseTarget": "请将其送至银行。",
            "instruction": "更口语一些",
        },
        session=session(toMemorize=[{"seq": 1, "source": "a", "target": "b"}] * 3),
        **kw,
    )


async def test_revise_path_skips_retrieve_review_and_memorize():
    fake = FakeLLM(translations=["麻烦把它送到银行吧。"])
    events = await collect(revise_req(), make_deps(fake))
    plan = of(events, "plan")[0]
    assert plan["path"] == "revise" and plan["domain"] == "通用"
    assert nodes(events) == [
        ("analyze", "started"),
        ("analyze", "completed"),
        ("plan", "started"),
        ("plan", "completed"),
        ("retrieve", "skipped"),
        ("translate", "started"),
        ("translate", "completed"),
        ("review", "skipped"),
        ("refine", "skipped"),
        ("finalize", "started"),
        ("finalize", "completed"),
    ]
    assert fake.kinds() == ["revise"]  # 只调用一次修订提示词，不判定领域、不评审、不压缩
    analyze = [d for e, d in events if e == "node" and d["node"] == "analyze" and d["status"] == "completed"][0]
    assert "沿用原记录" in analyze["summary"]
    assert "<translation>\n请将其送至银行。" in user_of(fake, "revise") and "我上周买了 X200 耳机。" in system_of(
        fake, "revise"
    )
    final = of(events, "final")[0]
    assert final["translation"] == "麻烦把它送到银行吧。" and final["path"] == "revise"


# ---------------------------------------------------------------- 歧义检测与追问（检查点）


@pytest.fixture
async def hitl():
    h = TurnCheckpoints(get_settings())
    await h.open()
    try:
        yield h
    finally:
        await h.close()


async def run(request, deps, hitl, request_id=None):
    rid = request_id or uuid.uuid4().hex[:12]
    return rid, [e async for e in run_agent(request, deps, request_id=rid, hitl=hitl)]


async def test_no_ambiguity_uses_single_merged_call(hitl):
    fake = FakeLLM(translations=["您的订单已发货。"], reviews=[review_json(95)])
    rid, events = await run(
        req(text="Your order has been shipped.", mode="standard", session=session()), make_deps(fake), hitl
    )
    assert fake.kinds() == ["clarify", "translate", "review"]  # 领域判定与歧义检查合并为一次调用，没有额外调用
    assert events[-1][0] == "final" and of(events, "plan")[0]["domain"] == "通用"
    assert await hitl.snapshot(thread_id_of(rid), 2) is None  # 正常完成后立即删除检查点


async def test_clarify_conditions(hitl):
    # 关闭追问：走普通领域判定
    fake = FakeLLM(translations=["x"], reviews=[review_json(95)])
    await run(req(mode="standard", session=session(clarifyEnabled=False)), make_deps(fake), hitl)
    assert fake.kinds()[0] == "domain"
    # 快速路径：不检查
    fake = FakeLLM(translations=["x"], clarify=AMBIGUOUS)
    _, events = await run(req(mode="fast", session=session()), make_deps(fake), hitl)
    assert fake.kinds() == ["translate"] and events[-1][0] == "final"
    # auto 模式的短句：会话允许追问时改走标准路径（否则追问形同虚设）；关闭追问时仍走快速路径
    fake = FakeLLM(translations=["x"], reviews=[review_json(95)], clarify=AMBIGUOUS)
    _, events = await run(req(text="Send it to the bank.", mode="auto", session=session()), make_deps(fake), hitl)
    plan = of(events, "plan")[0]
    assert plan["path"] == "standard" and "会话允许歧义追问" in plan["reason"] and events[-1][0] == "clarify"
    fake = FakeLLM(translations=["x"])
    _, events = await run(
        req(text="Send it to the bank.", mode="auto", session=session(clarifyEnabled=False)), make_deps(fake), hitl
    )
    assert of(events, "plan")[0]["path"] == "fast"
    # 非会话请求：不检查
    fake = FakeLLM(translations=["x"], reviews=[review_json(95)], clarify=AMBIGUOUS)
    await run(req(mode="standard"), make_deps(fake), hitl)
    assert "clarify" not in fake.kinds()
    # 原文超过 500 字符：不检查
    fake = FakeLLM(translations=["x"], reviews=[review_json(95)], clarify=AMBIGUOUS)
    await run(req(text="bank " * 120, mode="standard", session=session()), make_deps(fake), hitl)
    assert "clarify" not in fake.kinds()
    # 用户指定领域：只做歧义检查（仍是一次调用），不输出领域字段
    fake = FakeLLM(translations=["x"], reviews=[review_json(95)])
    _, events = await run(req(mode="standard", domain="电商", session=session()), make_deps(fake), hitl)
    assert fake.kinds()[0] == "clarify" and '"domain"' not in system_of(fake, "clarify")
    assert of(events, "plan")[0]["domain"] == "电商"
    # 无检查点（hitl 不可用）时不追问
    fake = FakeLLM(translations=["x"], reviews=[review_json(95)], clarify=AMBIGUOUS)
    events = await collect(req(mode="standard", session=session()), make_deps(fake))
    assert "clarify" not in fake.kinds()
    assert wants_hitl(req(mode="revise", session=session())) is False


async def test_merged_call_failures_fall_back(hitl):
    fake = FakeLLM(translations=["x"], reviews=[review_json(95)], clarify="不是 JSON")
    _, events = await run(req(mode="standard", session=session()), make_deps(fake), hitl)
    assert events[-1][0] == "final" and "领域判定失败" in of(events, "plan")[0]["reason"]

    class FailingClarify(FakeLLM):
        async def chat(self, r):
            if r.messages[0].content.startswith(session_mod.CLARIFY_ROLE):
                raise LLMError(LLMErrorKind.TIMEOUT)
            return await super().chat(r)

    fake = FailingClarify(translations=["x"], reviews=[review_json(95)])
    _, events = await run(req(mode="standard", session=session()), make_deps(fake), hitl)
    assert events[-1][0] == "final" and of(events, "plan")[0]["domain"] == "通用"


async def test_clarify_interrupt_resume_and_trace_continuity(hitl):
    from app.agent.graph import resume_agent

    fake = FakeLLM(translations=["请把它送到银行。"], reviews=[review_json(95)], clarify=AMBIGUOUS)
    request = req(text="Please send it to the bank.", mode="standard", session=session())
    rid, events = await run(request, make_deps(fake), hitl)
    assert events[-1] == (
        "clarify",
        {
            "threadId": f"turn:{rid}",
            "question": "bank 指什么？",
            "options": ["银行", "河岸"],
            "span": "bank",
            "reason": "多义词",
        },
    )
    assert of(events, "final") == []
    assert nodes(events)[-2:] == [("clarify", "started"), ("clarify", "interrupted")]
    plan = of(events, "plan")[0]
    assert plan["domain"] == "金融" and "发现歧义「bank」" in plan["reason"]
    last_seq = [d for e, d in events if e == "node"][-1]["seq"]

    snap = await hitl.snapshot(f"turn:{rid}", 2)
    assert snap is not None and snap.interrupts and emitted_node_events(snap.values) == last_seq
    restored = snap.values["request"]
    assert isinstance(restored, TranslateRequest) and restored.session.entities[0].note == "耳机型号"

    resumed = [e async for e in resume_agent(f"turn:{rid}", "银行", snap, make_deps(fake), hitl)]
    node_events = [d for e, d in resumed if e == "node"]
    assert node_events[0]["seq"] == last_seq + 1  # 轨迹连续
    assert [(d["node"], d["status"]) for d in node_events][:4] == [
        ("clarify", "started"),
        ("clarify", "completed"),
        ("retrieve", "started"),
        ("retrieve", "completed"),
    ]
    assert node_events[1]["summary"] == "用户澄清：「bank」指「银行」"
    assert "「bank」指「银行」" in system_of(fake, "translate")
    final = resumed[-1]
    assert final[0] == "final"
    assert final[1]["clarification"] == {
        "question": "bank 指什么？",
        "options": ["银行", "河岸"],
        "span": "bank",
        "answer": "银行",
    }
    assert final[1]["domain"] == "金融" and final[1]["translation"] == "请把它送到银行。"
    assert await hitl.snapshot(f"turn:{rid}", 2) is None  # 完成后删除


async def test_failed_run_deletes_thread(hitl):
    fake = FakeLLM(translations=[], clarify='{"domain": "通用", "ambiguity": {"ambiguous": false}}')
    fake.error = LLMError(LLMErrorKind.UNAVAILABLE)
    rid = uuid.uuid4().hex[:12]
    with pytest.raises(LLMError):
        async for _ in run_agent(req(mode="standard", session=session()), make_deps(fake), request_id=rid, hitl=hitl):
            pass
    assert await hitl.snapshot(f"turn:{rid}", 2) is None


async def test_hitl_unavailable_falls_back(monkeypatch):
    h = TurnCheckpoints(get_settings())

    async def boom():
        raise OSError("db down")

    monkeypatch.setattr(h.saver, "setup", boom)
    assert await h.graph(2) is None and await h.ensure_ready() is False  # 30 秒内不重试
    assert await h.snapshot("turn:x", 2) is None and await h.cleanup() == 0
    await h.delete_thread("turn:x")
    fake = FakeLLM(translations=["x"], reviews=[review_json(95)], clarify=AMBIGUOUS)
    events = [
        e async for e in run_agent(req(mode="standard", session=session()), make_deps(fake), request_id="r", hitl=h)
    ]
    assert events[-1][0] == "final" and "clarify" not in fake.kinds()


async def test_snapshot_rejects_foreign_threads_and_quiet_delete(hitl, monkeypatch):
    assert await hitl.snapshot("12345", 2) is None  # 文档任务的 thread 不受理

    async def boom(thread_id):
        raise OSError("x")

    monkeypatch.setattr(hitl.saver, "adelete_thread", boom)
    await hitl.delete_thread_quietly("turn:x")  # 只记警告


async def test_cleanup_removes_stale_turn_threads(hitl):
    fake = FakeLLM(translations=["x"], clarify=AMBIGUOUS)
    rid, events = await run(req(mode="standard", session=session()), make_deps(fake), hitl)
    assert events[-1][0] == "clarify"
    assert await hitl.cleanup() >= 0 and await hitl.snapshot(f"turn:{rid}", 2) is not None  # 未过期不删
    assert await hitl.cleanup(ttl_seconds=0) >= 1
    assert await hitl.snapshot(f"turn:{rid}", 2) is None


async def test_cleanup_loop_runs_and_survives_errors(monkeypatch):
    import asyncio

    from app.agent import hitl as hitl_mod

    monkeypatch.setattr(hitl_mod, "STARTUP_CLEANUP_DELAY_SECONDS", 0)
    h = TurnCheckpoints(get_settings().model_copy(update={"turn_cleanup_interval_seconds": 0.01}))
    calls = []

    async def cleanup(ttl_seconds=None):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("transient")
        return 0

    monkeypatch.setattr(h, "cleanup", cleanup)
    task = h.start_cleanup()
    assert h.start_cleanup() is task
    for _ in range(100):
        if len(calls) >= 3:
            break
        await asyncio.sleep(0.01)
    assert len(calls) >= 3
    await h.close()
    assert task.cancelled() or task.done()


# ---------------------------------------------------------------- HTTP：stream → clarify → resume / 放弃


def stream_body(**kw) -> dict:
    base = {
        "text": "Please send it to the bank.",
        "sourceLang": "en",
        "targetLang": "zh",
        "mode": "standard",
        "userId": 1,
        "session": session(),
    }
    base.update(kw)
    return base


async def test_http_clarify_then_resume(app, client, monkeypatch):
    fake = FakeLLM(translations=["请把它送到银行。"], reviews=[review_json(95)], clarify=AMBIGUOUS)
    use_fake_llm(app, monkeypatch, fake)
    first = parse_sse((await client.post("/internal/translate/stream", json=stream_body())).text)
    assert first[0].event == "start" and first[-1].event == "clarify"
    thread_id = first[-1].data["threadId"]
    assert thread_id == f"turn:{first[0].data['requestId']}"

    resp = await client.post(
        "/internal/translate/resume", json={"threadId": thread_id, "answer": " 银行 ", "userId": 1}
    )
    events = parse_sse(resp.text)
    assert events[0].event == "start" and events[-1].event == "final"
    assert events[-1].data["clarification"]["answer"] == "银行"
    assert [e.data["node"] for e in events if e.event == "node"][0] == "clarify"

    # 已完成：thread 已删除，再次回答 → A0440
    again = parse_sse(
        (await client.post("/internal/translate/resume", json={"threadId": thread_id, "answer": "银行"})).text
    )
    assert [e.event for e in again] == ["start", "error"] and again[-1].data["code"] == "A0440"


async def test_http_resume_wrong_user_abandon_and_validation(app, client, monkeypatch):
    fake = FakeLLM(translations=["x"], reviews=[review_json(95)], clarify=AMBIGUOUS)
    use_fake_llm(app, monkeypatch, fake)
    first = parse_sse((await client.post("/internal/translate/stream", json=stream_body())).text)
    thread_id = first[-1].data["threadId"]
    wrong = parse_sse(
        (await client.post("/internal/translate/resume", json={"threadId": thread_id, "answer": "a", "userId": 2})).text
    )
    assert wrong[-1].data["code"] == "A0440"

    resp = await client.delete(f"/internal/translate/threads/{thread_id.replace(':', '%3A')}")
    assert resp.status_code == 200 and resp.json()["code"] == "00000"
    assert (await client.delete("/internal/translate/threads/turn%3Anope")).json()["code"] == "00000"
    assert (await client.delete("/internal/translate/threads/42")).json()["code"] == "A0410"
    gone = parse_sse(
        (await client.post("/internal/translate/resume", json={"threadId": thread_id, "answer": "a"})).text
    )
    assert gone[-1].data["code"] == "A0440"

    assert (await client.post("/internal/translate/resume", json={"threadId": "t", "answer": ""})).json()[
        "code"
    ] == "A0410"
    assert (await client.post("/internal/translate/resume", json={"threadId": "t", "answer": "   "})).json()[
        "code"
    ] == "A0410"
    assert (
        await client.post("/internal/translate/resume", json={"threadId": "t", "answer": "x" * 201})
    ).status_code == 400


async def test_resume_continues_from_checkpoint_after_failed_resume(hitl):
    """恢复中途失败（检查点已越过中断）：再次回答时直接从检查点继续，不再传 resume。"""
    from app.agent.graph import resume_agent

    fake = FakeLLM(translations=[], reviews=[review_json(95)], clarify=AMBIGUOUS)
    rid, _ = await run(req(mode="standard", session=session()), make_deps(fake), hitl)
    tid = f"turn:{rid}"
    snap = await hitl.snapshot(tid, 2)
    fake.error = LLMError(LLMErrorKind.TIMEOUT)
    with pytest.raises(LLMError):
        async for _ in resume_agent(tid, "银行", snap, make_deps(fake), hitl):
            pass
    snap2 = await hitl.snapshot(tid, 2)
    assert snap2 is not None and not snap2.interrupts and snap2.values["clarification"]["answer"] == "银行"
    fake.error = None
    fake.translations = ["好的"]
    events = [e async for e in resume_agent(tid, "忽略", snap2, make_deps(fake), hitl)]
    assert events[-1][0] == "final" and events[-1][1]["clarification"]["answer"] == "银行"


# ---------------------------------------------------------------- memorize


def memo_session(**kw) -> dict:
    turns = [{"seq": i, "source": f"source {i}", "target": f"译文 {i}"} for i in (1, 2, 3)]
    return session(toMemorize=turns, memorizedUntil=0, turnSeq=9, **kw)


async def test_memorize_triggered_emits_memory_before_final():
    fake = FakeLLM(translations=["它昨天坏了。"])
    events = await collect(req(session=memo_session(clarifyEnabled=False, summary="旧摘要")), make_deps(fake))
    names = [e for e, _ in events]
    assert names.index("memory") < names.index("final")
    memory = of(events, "memory")[0]
    assert memory == {
        "summary": "客户购买了 X200 耳机",
        "entities": [{"source": "X200", "target": "X200", "note": "耳机型号"}],
        "memorizedUntil": 3,
    }
    assert nodes(events)[-2:] == [("memorize", "started"), ("memorize", "completed")]
    user = user_of(fake, "memorize")
    assert "旧摘要" in user and "[第 3 轮]\n原文：source 3" in user and "X200 → X200（耳机型号）" in user


async def test_memorize_failures_keep_memory_unchanged(caplog):
    for fake, expect in (
        (FakeLLM(translations=["x"], memorize_error=LLMError(LLMErrorKind.TIMEOUT)), "会话记忆压缩失败"),
        (FakeLLM(translations=["x"], memorize="oops"), "无法解析"),
    ):
        events = await collect(req(session=memo_session(clarifyEnabled=False, entities=[])), make_deps(fake))
        assert of(events, "memory") == [] and events[-1][0] == "final"
        done = [d for e, d in events if e == "node" and d["node"] == "memorize" and d["status"] == "completed"][0]
        assert expect in done["summary"]
    assert "会话记忆压缩" in caplog.text


async def test_memorize_timeout():
    import asyncio

    class Slow(FakeLLM):
        async def chat(self, r):
            if r.messages[0].content.startswith(session_mod.MEMORIZE_ROLE):
                await asyncio.sleep(1)
            return await super().chat(r)

    fake = Slow(translations=["x"])
    events = await collect(
        req(session=memo_session(clarifyEnabled=False)), make_deps(fake, memorize_timeout_seconds=0.01)
    )
    assert of(events, "memory") == [] and events[-1][0] == "final"


# ---------------------------------------------------------------- 检查点序列化往返


def _state_samples() -> dict:
    hit = TermHit("GPU", "图形处理器", 7, case_sensitive=True, spans=[(0, 3)], binding="soft")
    return {
        "request": req(
            mode="revise",
            session=session(toMemorize=[{"seq": 1, "source": "a", "target": "b", "instruction": "x"}]),
            revise={"recordId": 1, "baseSource": "a", "baseTarget": "b", "instruction": "c"},
        ),
        "term_hits": [hit],
        "features": TextFeatures(4, ["{x}"], ["http://a"], True),
        "context": _session_ctx(),
        "reviews": [Review(0, 80, False, [ReviewIssue("accuracy", "major", "x", "y")], reviewer="r", fallback=True)],
        "compliance": [TermCompliance("GPU", "图形处理器", False)],
        "usage": Usage(1, 2),
        "node_traces": [NodeTrace("plan", "completed", "s", 3, Usage(1, 1)), NodeTrace("retrieve", "skipped", "r")],
        "ambiguity": {"span": "bank", "question": "q", "options": ["a", "b"], "reason": "r"},
    }


@pytest.mark.parametrize("key", list(_state_samples()))
def test_checkpoint_roundtrip_each_state_type(key):
    serde = make_serde()
    value = _state_samples()[key]
    back = serde.loads_typed(serde.dumps_typed(value))
    assert back == value and type(back) is type(value)
    if isinstance(value, list):
        assert [type(x) for x in back] == [type(x) for x in value]


def test_serde_blocks_unlisted_types():
    """白名单之外的类型不会被实例化（返回原始数据）。"""
    serde = make_serde()
    strict = JsonPlusSerializer(allowed_msgpack_modules=[k for k in SERDE_ALLOWLIST if k[1] != "Usage"])
    raw = strict.loads_typed(serde.dumps_typed(Usage(1, 2)))
    assert not isinstance(raw, Usage)


async def test_checkpoint_roundtrip_through_postgres(hitl):
    fake = FakeLLM(translations=["x"], clarify=AMBIGUOUS)
    request = req(text="Please send it to the bank.", mode="standard", session=session(), glossaryIds=[7])
    rid, _ = await run(request, make_deps(fake), hitl)
    fresh = TurnCheckpoints(get_settings())  # 模拟进程重启后的新实例
    await fresh.open()
    try:
        snap = await fresh.snapshot(f"turn:{rid}", 2)
        values = snap.values
        assert values["request"] == request
        assert all(isinstance(h, TermHit) and all(isinstance(s, tuple) for s in h.spans) for h in values["term_hits"])
        assert isinstance(values["features"], TextFeatures) and isinstance(values["usage"], Usage)
        assert all(isinstance(t, NodeTrace) for t in values["node_traces"])
        assert values["ambiguity"]["span"] == "bank"
        await fresh.delete_thread(f"turn:{rid}")
    finally:
        await fresh.close()
