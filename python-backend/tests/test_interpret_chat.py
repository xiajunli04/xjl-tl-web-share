"""AI 对话引擎（add-ai-avatar-and-landing 3.1–3.4）：配置校验、提示词、开场白、一轮对话、打断与插话；
对话记忆压缩、字幕上下文与发言流重建恢复（improve-prompts-and-context-memory 2.2 / 4.2 / 5.2）。

识别部分沿用级联测试的脚本化 ASR（直接驱动 _finalize）；回复与字幕由同一个假 LLM 按提示词区分。
"""

import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass, field

import pytest

from app.api.internal.interpret import engine_class
from app.interpret.cascade import CascadeEngine
from app.interpret.chat import CascadeChatEngine, split_sentences
from app.interpret.chat_prompts import build_messages, system_prompt
from app.interpret.engine import ConfigError, StreamConfig
from app.llm.base import ChatChunk, ChatMessage, ChatRequest, ChatResult, LLMError, LLMErrorKind, Usage
from tests.fakes import resolved
from tests.speech_fakes import Collector, FakeASR, FakeTTS, StubRegistry, engine_deps, target_of
from tests.test_interpret_cascade import say

REPLY = "Welcome to Lumi's Kitchen! Can I get you something to drink? We have fresh juice today."
MEMORY_ROLE = "你是对话记忆整理助手"


@dataclass
class ChatLLM:
    """系统提示词含"## 场景"时按 REPLY 流式回复（每包 delay 秒），否则按翻译请求返回 "[目标]原文"；
    非流式调用为对话记忆压缩：gate 不为空时等它放行，memory_error 不为空时抛出。"""

    reply: str = REPLY
    model: str = "fake-chat"
    delay: float = 0.0
    requests: list[ChatRequest] = field(default_factory=list)
    memory_requests: list[ChatRequest] = field(default_factory=list)
    gate: asyncio.Event | None = None
    memory_error: LLMError | None = None

    async def chat(self, req):
        assert req.messages[0].content.startswith(MEMORY_ROLE)
        self.memory_requests.append(req)
        if self.gate is not None:
            await self.gate.wait()
        if self.memory_error is not None:
            raise self.memory_error
        return ChatResult(content=f"摘要{len(self.memory_requests)}", model=self.model, usage=Usage(1, 1), latency_ms=1)

    async def stream(self, req: ChatRequest) -> AsyncIterator[ChatChunk]:
        self.requests.append(req)
        system = req.messages[0].content
        if "## 场景" in system:
            text = self.reply
        else:
            text = f"[{target_of(system)}]{req.messages[-1].content}"
        for i in range(0, len(text), 6):
            if self.delay:
                await asyncio.sleep(self.delay)
            yield ChatChunk(delta=text[i : i + 6], model="fake")
        yield ChatChunk(model="fake", usage=Usage(10, 5), latency_ms=1, done=True)

    async def close(self) -> None:
        pass

    def chat_requests(self) -> list[ChatRequest]:
        return [r for r in self.requests if "## 场景" in r.messages[0].content]

    def subtitle_requests(self) -> list[ChatRequest]:
        return [r for r in self.requests if "字幕译者" in r.messages[0].content]


def chat_cfg(my="zh", ai="en", scenario="restaurant", **extra) -> dict:
    return {
        "type": "config",
        "mode": "CHAT",
        "engine": "cascade",
        "sourceLangs": [my, ai],
        "targetLangs": [],
        "chat": {"scenario": scenario, "myLang": my, "aiLang": ai, "persona": "Lumi"},
        **extra,
    }


def make_chat(asr=(), *, tts=None, llm=None, **cfg_kw):
    config = StreamConfig.model_validate(chat_cfg(**cfg_kw))
    out = Collector()
    llm = llm or ChatLLM()
    engine = CascadeChatEngine(config, out, engine_deps(StubRegistry(llm=llm), None, detect_lang="zh"))
    engine._asr = FakeASR(list(asr))
    engine._llm = resolved(llm)
    engine._tts = tts if config.tts else None
    return engine, out, llm


async def settle(engine) -> None:
    while engine._tasks:
        await asyncio.gather(*list(engine._tasks), return_exceptions=True)


def ai_events(out: Collector, uid: int) -> list[dict]:
    return [e for e in out.events if e.get("utteranceId") == uid]


# ---------------- 配置 ----------------


def test_chat_config_validation_and_engine_class():
    cfg = StreamConfig.model_validate(chat_cfg())
    cfg.check(6)
    assert cfg.chat.my_lang == "zh" and cfg.chat.greet is True
    assert engine_class(cfg) is CascadeChatEngine
    assert engine_class(StreamConfig.model_validate({"type": "config", "targetLangs": ["en"]})) is CascadeEngine
    with pytest.raises(ConfigError):
        StreamConfig.model_validate({**chat_cfg(), "chat": None}).check(6)
    with pytest.raises(ConfigError):
        StreamConfig.model_validate(chat_cfg(ai="xx")).check(6)
    with pytest.raises(ValueError):
        StreamConfig.model_validate(chat_cfg(scenario="karaoke"))
    # 两种语言相同：识别语种确定
    assert StreamConfig.model_validate(chat_cfg(my="en", ai="en")).declared_source == "en"
    assert cfg.declared_source is None


# ---------------- 提示词 ----------------


def test_prompt_contains_language_and_scenario_role():
    s = system_prompt("interview", "zh", "en")
    assert "始终只用英语回复" in s and "面试官" in s and "母语是中文" in s
    assert "母语" not in system_prompt("free", "en", "en")
    # 窗口由对话记忆维护，build_messages 不再截断
    history = [ChatMessage(role="user" if i % 2 == 0 else "assistant", content=f"m{i}") for i in range(40)]
    msgs = build_messages("free", "zh", "en", history, "hello")
    assert len(msgs) == 1 + 40 + 1 and msgs[1].content == "m0" and msgs[-1].content == "hello"
    opener = build_messages("travel", "zh", "en", [], None)[-1].content
    assert "先开口" in opener and "游客" in opener


def test_split_sentences():
    done, rest = split_sentences("Hi! Welcome to our place. We have 3.5 kinds of ")
    assert done == ["Hi! Welcome to our place."] and rest == "We have 3.5 kinds of "
    done, rest = split_sentences("欢迎光临！请问几位？我们")
    assert done == ["欢迎光临！请问几位？"] and rest == "我们"


# ---------------- 开场白与一轮对话 ----------------


async def test_greeting_reply_sequence_all_tagged_assistant():
    tts = FakeTTS(chunks=2, chunk_bytes=100)
    engine, out, llm = make_chat(tts=tts)
    engine._start_reply(None, 0.0)
    await settle(engine)
    events = ai_events(out, 1)
    assert all(e.get("role") == "assistant" for e in events)
    types = [e["type"] for e in events]
    assert types[0] == "transcript.partial" and types[-1] == "metrics"
    final = next(e for e in events if e["type"] == "transcript.final")
    assert final["text"] == REPLY and final["lang"] == "en" and final["ttsFallback"] is False
    subtitle = next(e for e in events if e["type"] == "translation.final")
    # 字幕逐句翻译后按句序拼接（假模型给每句加 [zh] 前缀；中文句间不加空格）
    assert subtitle["lang"] == "zh" and subtitle["text"] == (
        "[zh]Welcome to Lumi's Kitchen![zh]Can I get you something to drink?[zh]We have fresh juice today."
    )
    deltas = [e["delta"] for e in events if e["type"] == "translation.delta"]
    assert "".join(deltas) == subtitle["text"] and len(deltas) == 3
    audio = [e for e in events if e["type"] == "audio"]
    assert audio and audio[-1]["last"] is True and all(a["lang"] == "en" for a in audio)
    assert sorted({a["seg"] for a in audio if a["data"]}) == [0, 1, 2]  # 每句一个段
    # 按句合成：3 句各合成一次
    assert [t for t, _ in tts.calls] == [
        "Welcome to Lumi's Kitchen!",
        "Can I get you something to drink?",
        "We have fresh juice today.",
    ]
    assert "先开口" in llm.chat_requests()[0].messages[-1].content
    metrics = events[-1]
    assert metrics["e2eMs"] is not None and metrics["ttsFirstMs"] is not None


async def test_user_turn_then_reply_with_history():
    engine, out, llm = make_chat([("我想要一份不辣的菜", "zh")], tts=FakeTTS(chunks=1, chunk_bytes=10))
    await say(engine)
    await settle(engine)
    user = ai_events(out, 1)
    assert [e["type"] for e in user] == ["transcript.final", "metrics"]
    assert "role" not in user[0] and user[0]["lang"] == "zh"
    assert user[1]["asrMs"] is not None and user[1]["e2eMs"] is None
    reply = ai_events(out, 2)
    assert reply and all(e["role"] == "assistant" for e in reply)
    req = llm.chat_requests()[0]
    assert req.messages[-1].content == "我想要一份不辣的菜"
    assert [m.role for m in engine._dialog] == ["user", "assistant"]
    # 第二轮带上历史
    engine._asr = FakeASR([("要一杯橙汁", "zh")])
    await say(engine)
    await settle(engine)
    second = llm.chat_requests()[1]
    assert [m.content for m in second.messages[1:]] == ["我想要一份不辣的菜", REPLY, "要一杯橙汁"]


async def test_same_language_has_no_subtitle_and_no_tts_metrics_after_final():
    engine, out, _ = make_chat(my="en", ai="en", tts=None, tts_engine=None)
    engine._tts = None
    engine._start_reply(None, 0.0)
    await settle(engine)
    types = [e["type"] for e in ai_events(out, 1)]
    assert "translation.final" not in types and "audio" not in types
    assert types[-2:] == ["transcript.final", "metrics"]
    assert ai_events(out, 1)[-1]["e2eMs"] is not None


# ---------------- 打断 ----------------


async def test_interrupt_during_speech_stops_audio_and_truncates_history():
    tts = FakeTTS(chunks=6, chunk_bytes=50, delay=0.01)
    # LLM 慢于首句合成：打断发生在生成途中
    engine, out, llm = make_chat(tts=tts, llm=ChatLLM(delay=0.05))
    engine._start_reply(None, 0.0)
    for _ in range(200):
        if out.of("audio"):
            break
        await asyncio.sleep(0.01)
    assert out.of("audio"), "应当已开始播报"
    engine.interrupt()
    cut = len(out.events)
    await settle(engine)
    interrupted = out.of("reply.interrupted")
    assert len(interrupted) == 1 and interrupted[0]["utteranceId"] == 1 and interrupted[0]["role"] == "assistant"
    assert interrupted[0]["text"] and len(interrupted[0]["text"]) < len(REPLY)
    after = out.events[cut:]
    assert not [e for e in after if e["type"] == "audio"]
    assert out.of("transcript.final")[0]["text"] == interrupted[0]["text"]
    assert engine._dialog[-1].content.endswith("…")
    assert engine._reply is None


async def test_new_user_utterance_barges_in():
    engine, out, llm = make_chat(
        [("等一下", "zh")], tts=FakeTTS(chunks=6, chunk_bytes=50, delay=0.02), llm=ChatLLM(delay=0.01)
    )
    engine._start_reply(None, 0.0)
    await asyncio.sleep(0.05)
    await say(engine)
    await settle(engine)
    assert out.of("reply.interrupted")[0]["utteranceId"] == 1
    # 用户句 uid=2，新回复 uid=3 完整生成
    assert [e["type"] for e in ai_events(out, 2)][0] == "transcript.final"
    finals = [e for e in ai_events(out, 3) if e["type"] == "transcript.final"]
    assert finals and finals[0]["text"] == REPLY


async def test_interrupt_without_active_reply_acknowledges_last():
    engine, out, _ = make_chat(tts=None)
    engine.interrupt()
    assert out.of("reply.interrupted") == []
    engine._start_reply(None, 0.0)
    await settle(engine)
    engine.interrupt()
    assert out.of("reply.interrupted")[-1]["utteranceId"] == 1


async def test_control_frame_interrupt():
    engine, out, _ = make_chat(tts=FakeTTS(chunks=6, chunk_bytes=50, delay=0.02), llm=ChatLLM(delay=0.01))
    engine._start_reply(None, 0.0)
    await asyncio.sleep(0.05)
    await engine.control({"type": "interrupt"})
    await settle(engine)
    assert len(out.of("reply.interrupted")) == 1


# ---------------- 逐句成段与逐句字幕（improve-speech-playback-latency 3.1 / 3.2） ----------------


async def test_first_sentence_audio_before_reply_finishes():
    tts = FakeTTS(chunks=1, chunk_bytes=10)
    engine, out, _ = make_chat(tts=tts, llm=ChatLLM(delay=0.03))
    engine._start_reply(None, 0.0)
    for _ in range(300):
        if out.of("audio"):
            break
        await asyncio.sleep(0.01)
    first_audio = out.of("audio")[0]
    assert first_audio["seg"] == 0
    partials = out.of("transcript.partial")
    assert "We have fresh juice today." not in partials[-1]["text"]  # 第 3 句尚未生成完
    assert out.of("transcript.final") == []
    await settle(engine)


@dataclass
class SlowSubtitleLLM(ChatLLM):
    """回复正常流式；字幕翻译按句子设置延迟，fail_on 中的句子翻译失败。"""

    subtitle_delays: dict[str, float] = field(default_factory=dict)
    fail_on: str | None = None

    async def stream(self, req: ChatRequest) -> AsyncIterator[ChatChunk]:
        if "## 场景" not in req.messages[0].content:
            source = req.messages[-1].content
            if self.fail_on and self.fail_on in source:
                self.requests.append(req)
                raise LLMError(LLMErrorKind.RATE_LIMIT)
            await asyncio.sleep(next((d for k, d in self.subtitle_delays.items() if k in source), 0))
        async for chunk in super().stream(req):
            yield chunk


async def test_slow_subtitles_do_not_block_audio_and_keep_order():
    llm = SlowSubtitleLLM(subtitle_delays={"Welcome": 0.3, "drink": 0.05})
    engine, out, _ = make_chat(tts=FakeTTS(chunks=1, chunk_bytes=10), llm=llm)
    engine._start_reply(None, 0.0)
    await settle(engine)
    types = [e["type"] for e in ai_events(out, 1)]
    assert types.index("audio") < types.index("translation.delta")  # 语音不等字幕
    deltas = [e["delta"] for e in out.of("translation.delta")]
    assert [d.split("]")[1][:4] for d in deltas] == ["Welc", "Can ", "We h"]  # 第 1 句最慢，仍按句序追加


async def test_single_subtitle_failure_uses_original():
    llm = SlowSubtitleLLM(fail_on="drink")
    engine, out, _ = make_chat(tts=FakeTTS(chunks=1, chunk_bytes=10), llm=llm)
    engine._start_reply(None, 0.0)
    await settle(engine)
    subtitle = out.of("translation.final")[0]["text"]
    assert subtitle == "[zh]Welcome to Lumi's Kitchen!Can I get you something to drink?[zh]We have fresh juice today."
    errors = out.of("error")
    assert len(errors) == 1 and errors[0]["fatal"] is False and "字幕翻译失败" in errors[0]["message"]
    assert out.of("transcript.final")[0]["text"] == REPLY  # 对话本身不受影响


async def test_interrupt_cancels_pending_subtitles():
    llm = SlowSubtitleLLM(subtitle_delays={"Welcome": 0.5}, delay=0.01)
    engine, out, _ = make_chat(tts=FakeTTS(chunks=1, chunk_bytes=10), llm=llm)
    engine._start_reply(None, 0.0)
    await asyncio.sleep(0.2)
    engine.interrupt()
    await settle(engine)
    await asyncio.sleep(0.4)
    assert out.of("translation.final") == []  # 未完成的字幕随打断取消


# ---------------- 字幕上下文（improve-prompts-and-context-memory 2.2）----------------


async def test_subtitle_uses_subtitle_prompt_with_user_and_previous_sentences():
    engine, out, llm = make_chat([("有什么喝的", "zh")], tts=None, tts_engine=None)
    engine._tts = None
    await say(engine)
    await settle(engine)
    subs = llm.subtitle_requests()
    assert len(subs) == 3 and all(r.temperature == 0.3 for r in subs)
    second = subs[1].messages[0].content
    assert "用户：有什么喝的" in second and "Welcome to Lumi's Kitchen!" in second
    assert "保留原文，后面用括号附上中文意思" in second
    assert subs[1].messages[-1].content == "Can I get you something to drink?"


async def test_turn_hint_after_coaching_reply_and_for_native_question():
    llm = ChatLLM(reply='You could say: "Two people, please." Welcome!')
    engine, _, _ = make_chat([("两个人", "zh")], tts=None, tts_engine=None)
    engine._tts = None
    engine._llm = resolved(llm)
    await say(engine)
    await settle(engine)
    assert "## 本轮提示" not in llm.chat_requests()[0].messages[0].content  # 母语陈述句：交给模型判断
    engine._asr = FakeASR([("有什么推荐的吗", "zh")])
    await say(engine)
    await settle(engine)
    assert llm.chat_requests()[1].messages[0].content.rstrip().endswith("这一轮不要示范，直接回应用户。")


# ---------------- 对话记忆（improve-prompts-and-context-memory 4.2）----------------


async def chat_turns(engine, llm, n: int, start: int = 1) -> None:
    for i in range(start, start + n):
        engine._asr = FakeASR([(f"第{i}句", "zh")])
        await say(engine)
        await settle(engine)


async def test_memory_compresses_in_background_without_gap():
    llm = ChatLLM(gate=asyncio.Event())
    engine, out, _ = make_chat(tts=None, tts_engine=None, my="en", ai="en", llm=llm)
    engine._tts = None
    for i in range(1, 17):
        engine._asr = FakeASR([(f"turn{i}", "en")])
        await say(engine)
        # 只等回复完成，不等后台压缩
        for _ in range(200):
            if engine._reply is None and len(llm.chat_requests()) == i:
                break
            await asyncio.sleep(0.01)
    assert len(llm.memory_requests) == 1  # 第 16 轮回复后触发一次压缩
    batch_text = llm.memory_requests[0].messages[-1].content
    assert "turn1" in batch_text and "turn4" in batch_text and "turn5" not in batch_text
    # 压缩返回前的第 17 轮：提示词仍包含第 1 轮原文，回复不等待压缩
    engine._asr = FakeASR([("turn17", "en")])
    await say(engine)
    for _ in range(200):
        if engine._reply is None and len(llm.chat_requests()) == 17:
            break
        await asyncio.sleep(0.01)
    contents = [m.content for m in llm.chat_requests()[-1].messages]
    assert "turn1" in contents and not out.of("memory")
    llm.gate.set()
    await settle(engine)
    memory = out.of("memory")
    assert memory == [{"type": "memory", "summary": "摘要1", "turns": 4}]
    # 之后的提示词带摘要、不再包含第 1–4 轮
    engine._asr = FakeASR([("turn18", "en")])
    await say(engine)
    await settle(engine)
    last = llm.chat_requests()[-1].messages
    assert "## 对话记忆" in last[0].content and last[0].content.rstrip().endswith("摘要1")
    texts = [m.content for m in last[1:]]
    assert "turn4" not in texts and "turn5" in texts


async def test_memory_failure_keeps_dialog_and_retries():
    llm = ChatLLM(memory_error=LLMError(LLMErrorKind.TIMEOUT, "超时"))
    engine, out, _ = make_chat(tts=None, tts_engine=None, my="en", ai="en", llm=llm)
    engine._tts = None
    for i in range(1, 18):
        engine._asr = FakeASR([(f"turn{i}", "en")])
        await say(engine)
        await settle(engine)
    assert len(llm.memory_requests) == 2  # 第 16、17 轮之后各尝试一次
    assert not out.of("memory") and engine._memory.summary is None
    assert engine._dialog[0].content == "turn1"
    assert len(llm.chat_requests()) == 17 and not out.of("error")


# ---------------- 发言流重建恢复（improve-prompts-and-context-memory 5.2）----------------


async def test_rebuilt_chat_restores_dialog_and_memory_without_greeting():
    history = [
        {"role": "user", "lang": "zh", "text": "我叫小林"},
        {"role": "assistant", "lang": "en", "text": "Nice to meet you, Xiaolin!", "translations": {"zh": "你好"}},
    ]
    engine, out, llm = make_chat(
        [("你还记得我叫什么吗", "zh")],
        tts=None,
        tts_engine=None,
        history=history,
        chat={"scenario": "free", "myLang": "zh", "aiLang": "en", "greet": False, "memory": "用户信息：考研中"},
    )
    engine._tts = None
    assert [m.content for m in engine._dialog] == ["我叫小林", "Nice to meet you, Xiaolin!"]
    await say(engine)
    await settle(engine)
    req = llm.chat_requests()[0]
    assert [m.content for m in req.messages[1:]] == ["我叫小林", "Nice to meet you, Xiaolin!", "你还记得我叫什么吗"]
    assert "## 对话记忆" in req.messages[0].content and "用户信息：考研中" in req.messages[0].content
    assert all("先开口" not in r.messages[-1].content for r in llm.chat_requests())
