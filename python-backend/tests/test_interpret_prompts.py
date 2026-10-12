"""同传、字幕、AI 对话与对话记忆的提示词，以及输出清理。

对应 improve-prompts-and-context-memory 1.2–1.4 / 2.2 / 3.1–3.2 / 4.1。

提示词快照位于 tests/snapshots/；提示词改动后用 UPDATE_SNAPSHOTS=1 重新生成，并在 diff 中审阅。
"""

import logging
import os
from pathlib import Path

from app.agent.state import TranslationContext
from app.glossary.matcher import TermHit
from app.interpret.chat_prompts import (
    DIALOG_START,
    NO_COACH_AFTER_COACH,
    NO_COACH_FOR_QUESTION,
    build_messages,
    coached,
    is_question,
    normalize,
    opener_instruction,
    system_prompt,
    turn_hint,
)
from app.interpret.dialog_memory import DialogMemory, memory_messages
from app.interpret.interpret_prompts import (
    Utterance,
    interpret_system_prompt,
    subtitle_system_prompt,
    window,
)
from app.interpret.lang_notes import COACH_PHRASES, LANG_NOTES, coach_phrase, fillers, lang_note
from app.interpret.output_filter import HOLD, LeadingCleaner, clean_final
from app.lang import languages
from app.llm.base import ChatMessage

SNAPSHOTS = Path(__file__).parent / "snapshots"


def check_snapshot(name: str, text: str) -> None:
    snap = SNAPSHOTS / name
    if os.environ.get("UPDATE_SNAPSHOTS") or not snap.exists():
        snap.parent.mkdir(exist_ok=True)
        snap.write_text(text, encoding="utf-8")
    assert text == snap.read_text(encoding="utf-8")


# ---------------------------------------------------------------- 语言素材


def test_lang_notes_cover_all_supported_languages():
    assert set(languages.CODES) <= set(LANG_NOTES)
    assert lang_note("yue") == LANG_NOTES["zh"] and lang_note("xx") == ""
    assert fillers("en").startswith("um") and fillers("fr") == "语气填充词"
    assert coach_phrase("ja") == COACH_PHRASES["ja"] and "泰语" in coach_phrase("th")


# ---------------------------------------------------------------- 同传


RECENT = [
    Utterance("zh", "你们觉得这个价格合适吗", {"en": "Do you think this price is reasonable?"}),
    Utterance("en", "It's a bit high for us.", {"zh": "对我们来说有点高。"}),
]


def test_interpret_prompt_layers_and_rules():
    ctx = TranslationContext(terms=[TermHit("大模型", "LLM", 0)], domain_hint="技术发布会")
    system = interpret_system_prompt(ctx, RECENT, "zh", "en")
    check_snapshot("interpret_zh_en.txt", system)
    for phrase in ("只译不答", "保持人称和语气", "不要猜测补全", "## 处理示例（中文 → 英语", "## 英语的表达习惯"):
        assert phrase in system
    assert "占位符" not in system and "段落与换行" not in system
    # 静态在前、动态在后：规则 → 示例 → 表达习惯 → 术语 → 最近的发言 → 末尾提醒
    order = ["## 传译规则", "## 处理示例", "## 英语的表达习惯", "## 领域", "| 大模型 | LLM |", "## 最近的发言"]
    assert [system.index(s) for s in order] == sorted(system.index(s) for s in order)
    assert "- [中文] 你们觉得这个价格合适吗 ｜ 英语译文：Do you think this price is reasonable?" in system
    assert "- [英语] It's a bit high for us.\n" in system  # 原话是目标语言以外、但没有英语译文时只显示原话
    assert system.splitlines()[-1] == "最后提醒：只输出用户消息中这句原话的英语译文。"


def test_interpret_prompt_generic_examples_for_other_pairs():
    system = interpret_system_prompt(TranslationContext(), [], "zh", "ja")
    check_snapshot("interpret_zh_ja.txt", system)
    assert "原话是提问（如“明天的航班改到几点了”）→ 译成同样的提问，不回答" in system
    assert "What time has" not in system and "Manager Wang" not in system
    assert "です・ます体" in system
    assert "## 领域" not in system and "术语表" not in system.split("## 传译规则")[0]
    assert "## 最近的发言" not in system


def test_window_keeps_recent_within_limits():
    items = [Utterance("zh", f"句{i}", {"en": f"s{i}"}) for i in range(1, 10)]
    assert [u.text for u in window(items, "en", 6, 1500)] == [f"句{i}" for i in range(4, 10)]
    # 每句 2 + 2 字符：上限 9 字符时只能放下 2 句
    assert [u.text for u in window(items, "en", 6, 9)] == ["句8", "句9"]
    assert window(items, "en", 0, 1500) == []
    # 原话就是目标语言时不计译文长度
    assert len(window([Utterance("en", "a" * 10, {"en": "b" * 100})], "en", 6, 10)) == 1


# ---------------------------------------------------------------- 字幕


def test_subtitle_prompt_keeps_coaching_sentence_and_context():
    system = subtitle_system_prompt("我想要靠窗的座位", ["Sure."], "en", "zh")
    check_snapshot("subtitle_en_zh.txt", system)
    assert "保留原文，后面用括号附上中文意思" in system
    assert "用户：我想要靠窗的座位" in system and "Lumi（本条回复前面的句子）：Sure." in system
    assert system.splitlines()[-1] == "最后提醒：只输出这一句的中文字幕。"
    assert "## 上下文" not in subtitle_system_prompt(None, [], "en", "zh")


# ---------------------------------------------------------------- 输出清理


def run_cleaner(deltas: list[str], source: str = "你好") -> tuple[str, list[str]]:
    cleaner = LeadingCleaner(source)
    emitted = [cleaner.feed(d) for d in deltas]
    emitted.append(cleaner.flush())
    return "".join(emitted), emitted


def test_leading_cleaner_strips_split_label():
    text, _ = run_cleaner(["Tran", "slat", "ion:", " Hel", "lo"])
    assert text == "Hello"
    text, _ = run_cleaner(["译文", "：你好"], "hello")
    assert text == "你好"


def test_leading_cleaner_passes_through_plain_output_immediately():
    text, emitted = run_cleaner(["What ", "time do you close?"])
    assert text == "What time do you close?" and emitted[0] == "What "
    # 可能是标签的开头只缓冲到 HOLD 个字符
    text, emitted = run_cleaner(["Translat", "ions of this book are rare"])
    assert text == "Translations of this book are rare"
    long = "translation" + " " * HOLD
    assert run_cleaner([long])[0] == long


def test_leading_cleaner_quotes_and_flush():
    assert run_cleaner(["“Hello", "”"])[0] == "Hello”"
    assert run_cleaner(["“Hello”"], source="“你好”")[0] == "“Hello”"
    assert run_cleaner(["Tr"])[0] == "Tr"  # 流结束时缓冲被完整冲出
    assert clean_final("Translation: “Hello”", "你好") == "Hello"
    assert clean_final("“Hello”", "“你好”") == "“Hello”"
    assert clean_final("  Hi  ", "x") == "Hi"


# ---------------------------------------------------------------- AI 对话


def test_chat_prompt_sections():
    system = system_prompt("free", "zh", "en")
    check_snapshot("chat_free_zh_en.txt", system)
    assert "## 语言陪练" in system and "你上一轮已经示范过时，这一轮不再示范" in system
    assert "最多 6 句" in system and "被用户打断了：不要重复被打断的内容" in system
    assert 'You could say: "…"' in system and "## 对话记忆" not in system
    same = system_prompt("free", "en", "en")
    assert "## 语言陪练" not in same and "母语" not in same
    assert "こう言うと自然ですよ" in system_prompt("free", "zh", "ja")


def test_chat_prompt_scenario_flow_and_memory_last():
    system = system_prompt("restaurant", "zh", "en", memory="用户信息：小林，对花生过敏")
    check_snapshot("chat_restaurant_zh_en_memory.txt", system)
    assert "流程：迎客入座 → 饮品" in system and "语气：礼貌、热情的服务用语。" in system
    assert system.rindex("## 对话记忆") > system.index("## 英语的表达习惯")
    assert system.rstrip().endswith("用户信息：小林，对花生过敏")
    assert "第一句简短" in opener_instruction("interview")


def test_build_messages_normalizes_sequence():
    greeting = ChatMessage(role="assistant", content="Hi!")
    msgs = build_messages("free", "zh", "en", [greeting], "你好")
    assert [(m.role, m.content) for m in msgs[1:]] == [("user", DIALOG_START), ("assistant", "Hi!"), ("user", "你好")]
    # 打断后用户连说两句：合并为一条
    history = [ChatMessage(role="user", content="等一下"), ChatMessage(role="assistant", content="Sure…")]
    merged = normalize([*history, ChatMessage(role="user", content="a"), ChatMessage(role="user", content="b")])
    assert [(m.role, m.content) for m in merged] == [("user", "等一下"), ("assistant", "Sure…"), ("user", "a\nb")]
    # 空历史生成开场白
    opener = build_messages("travel", "zh", "en", [], None)
    assert [m.role for m in opener] == ["system", "user"] and "先开口" in opener[-1].content
    assert "## 对话记忆" in build_messages("free", "zh", "en", [], "hi", memory="摘要")[0].content


def test_turn_hint_backs_up_on_demand_coaching():
    # D3 后备方案 B：上一轮已示范、或用户用母语提问时，本轮提示明确要求不示范
    assert coached('You could say: "Could we pay separately?" Of course.') and coached("“You can say …")
    assert coached("こう言うと自然ですよ：「…」") and not coached("Sure, you could say that.")
    assert is_question("天气的话需要带伞吗") and is_question("What should I pack") and not is_question("我叫小林")
    assert turn_hint("交货期要多久", "zh", 'You could say: "…"', "zh", "en") == NO_COACH_AFTER_COACH
    assert turn_hint("交货期要多久", "zh", "Sure.", "zh", "en") == NO_COACH_FOR_QUESTION
    assert turn_hint("我叫小林", "zh", "Hi!", "zh", "en") is None  # 母语陈述句：交给模型按规则示范
    assert turn_hint("What I should pack?", "en", "Hi!", "zh", "en") is None  # 说错对话语言的提问仍可示范
    assert turn_hint("How are you?", "en", 'You could say: "…"', "en", "en") is None  # 同语言不陪练
    assert turn_hint(None, None, None, "zh", "en") is None  # 开场白
    system = system_prompt("free", "zh", "en", memory="摘要", hint=NO_COACH_FOR_QUESTION)
    assert system.rstrip().endswith(f"## 本轮提示\n{NO_COACH_FOR_QUESTION}")
    assert system.index("## 对话记忆") < system.index("## 本轮提示")


# ---------------------------------------------------------------- 对话记忆


def turns(n: int, greeting: bool = False) -> list[ChatMessage]:
    out = [ChatMessage(role="assistant", content="hello")] if greeting else []
    for i in range(1, n + 1):
        out += [ChatMessage(role="user", content=f"u{i}"), ChatMessage(role="assistant", content=f"a{i}")]
    return out


def memory_with(messages: list[ChatMessage], **kw) -> DialogMemory:
    m = DialogMemory(**kw)
    for msg in messages:
        m.append(msg)
    return m


def test_due_after_sixteen_turns_returns_earliest_four():
    mem = memory_with(turns(15))
    assert mem.due() is None
    mem.append(ChatMessage(role="user", content="u16"))
    mem.append(ChatMessage(role="assistant", content="a16"))
    batch = mem.due()
    assert [m.content for m in batch] == ["u1", "a1", "u2", "a2", "u3", "a3", "u4", "a4"]
    assert mem.due() is None  # 同一时间最多一个压缩任务
    # 开场白算半轮：开场白 + 15 轮不触发，压缩批次带上开场白
    mem2 = memory_with(turns(15, greeting=True))
    assert mem2.turns() == 15.5 and mem2.due() is None
    mem2.append(ChatMessage(role="user", content="u16"))
    mem2.append(ChatMessage(role="assistant", content="a16"))
    assert [m.content for m in mem2.due()][:3] == ["hello", "u1", "a1"]


def test_due_early_when_chars_exceed_limit():
    mem = memory_with(
        [ChatMessage(role="user" if i % 2 == 0 else "assistant", content="x" * 1000) for i in range(8)], max_chars=6000
    )
    batch = mem.due()
    assert batch is not None and mem.chars(mem.history()[len(batch) :]) <= 6000


def test_commit_removes_only_the_batch():
    mem = memory_with(turns(16))
    batch = mem.due()
    mem.append(ChatMessage(role="user", content="new"))  # 压缩期间新追加的消息
    assert mem.history()[0].content == "u1"  # 提交前仍在提示词中（没有缺口）
    mem.commit(batch, "摘要")
    assert mem.summary == "摘要" and mem.memorized_turns == 4
    assert [m.content for m in mem.history()][:2] == ["u5", "a5"] and mem.history()[-1].content == "new"
    mem.fail()
    assert mem.due() is None  # 12.5 轮，不再触发


def test_failure_keeps_messages_and_hard_cap_drops_oldest(caplog):
    mem = memory_with(turns(16))
    batch = mem.due()
    mem.fail()
    assert mem.history()[0].content == "u1" and mem.due() == batch  # 失败后下次重试
    mem.fail()
    with caplog.at_level(logging.WARNING, logger="app.interpret.memory"):
        for msg in turns(10):
            mem.append(msg)
    assert mem.turns() <= 24 and "丢弃最早" in caplog.text


def test_ordered_append_and_seed():
    mem = DialogMemory()
    mem.append(ChatMessage(role="assistant", content="reply"), order=5)
    mem.append(ChatMessage(role="user", content="late user"), order=4)  # 用户转写晚于回复到达
    assert [m.content for m in mem.history()] == ["late user", "reply"]
    mem.seed([ChatMessage(role="user", content="old")], "  摘要  ")
    mem.append(ChatMessage(role="assistant", content="x"), order=1)
    assert [m.content for m in mem.history()] == ["old", "x"] and mem.summary == "摘要"


def test_memory_prompt_format():
    batch = turns(2, greeting=True)
    batch[-1] = ChatMessage(role="assistant", content="Two lemon teas…")
    msgs = memory_messages("用户信息：无", batch, scenario="restaurant", persona="Lumi", max_chars=400)
    check_snapshot("memory_restaurant.txt", msgs[0].content + "\n\n---\n\n" + msgs[1].content)
    system, user = msgs[0].content, msgs[1].content
    for section in ("用户信息：", "话题与要点：", "用户的问题：", "待办与约定："):
        assert section in system
    assert "场景：餐厅点餐" in system and "不超过 400 字" in system
    assert user.startswith("## 已有记忆\n用户信息：无") and "Lumi：Two lemon teas…" in user
    empty = memory_messages(None, batch, scenario="free", persona="Lumi", max_chars=400)
    assert "## 已有记忆\n（无）" in empty[1].content
