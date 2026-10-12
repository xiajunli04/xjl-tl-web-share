"""AI 对话回复让位（improve-speech-endpointing-and-live-ux 2.2 / D6）。

- 回复尚未开播时用户接着说：interrupt{yield:true} 撤回回复（discard、不写入记忆、此后该 uid 没有任何事件），
  续说定稿后与上一句合并为一轮回应
- 续说被丢弃（噪声）或超时没有新句：为原来那句重新生成回复
- 纯语气词的用户句不触发回复
"""

import asyncio

from tests.speech_fakes import FakeTTS
from tests.test_interpret_cascade import say
from tests.test_interpret_chat import ChatLLM, make_chat, settle


async def test_yield_then_merged_reply():
    engine, out, llm = make_chat([("我想订一张", "zh"), ("明天去上海的高铁票", "zh")], tts=FakeTTS())
    await say(engine)
    await asyncio.sleep(0)  # 回复开始生成
    first_ai = engine._last_ai_uid
    await engine.control({"type": "interrupt", "yield": True})
    await settle(engine)
    discard = out.of("transcript.discard")
    assert [d["utteranceId"] for d in discard] == [first_ai] and discard[0]["role"] == "assistant"
    after = [e for e in out.events[out.events.index(discard[0]) + 1 :] if e.get("utteranceId") == first_ai]
    assert after == []  # 撤回后该 uid 不再有任何事件（metrics / audio / final）
    assert all(m.role == "user" for m in engine._memory.history())  # 回复没有写入记忆

    await say(engine, start_ms=3000)
    await settle(engine)
    replies = llm.chat_requests()
    last = replies[-1].messages
    users = [m for m in last if m.role == "user"]
    # 两句用户话相邻，提示词规范化后合并为同一轮
    assert "我想订一张" in users[-1].content and "明天去上海的高铁票" in users[-1].content
    assert engine._yielded is None


async def test_yield_after_reply_completed_withdraws_memory():
    engine, out, llm = make_chat([("我想订一张", "zh")])
    await say(engine)
    await settle(engine)  # 回复已生成完（客户端可能还没开播）
    uid = engine._last_ai_uid
    assert engine._memory.last().role == "assistant"
    await engine.control({"type": "interrupt", "yield": True})
    assert engine._memory.last().role == "user"
    assert out.of("transcript.discard")[-1]["utteranceId"] == uid


async def test_yield_resumes_when_continuation_is_noise():
    engine, out, llm = make_chat([("我想订一张", "zh"), ("嗯……", "zh")])
    await say(engine)
    await asyncio.sleep(0)
    await engine.control({"type": "interrupt", "yield": True})
    await settle(engine)
    n = len(llm.chat_requests())
    await say(engine, start_ms=3000)  # 续说只有语气词：被丢弃，立即恢复回复
    await settle(engine)
    assert len(llm.chat_requests()) == n + 1
    assert llm.chat_requests()[-1].messages[-1].content.endswith("我想订一张")
    assert engine._yielded is None


async def test_yield_resumes_after_timeout(monkeypatch):
    engine, out, llm = make_chat([("我想订一张", "zh")], llm=ChatLLM())
    monkeypatch.setattr(engine.deps.settings, "chat_yield_resume_seconds", 0.05)
    await say(engine)
    await asyncio.sleep(0)
    await engine.control({"type": "interrupt", "yield": True})
    n = len(llm.chat_requests())
    await asyncio.sleep(0.15)
    await settle(engine)
    assert len(llm.chat_requests()) == n + 1


async def test_filler_only_user_turn_gets_no_reply():
    engine, out, llm = make_chat([("嗯。", "zh")])
    await say(engine)
    await settle(engine)
    assert llm.chat_requests() == [] and out.of("transcript.final") == []
