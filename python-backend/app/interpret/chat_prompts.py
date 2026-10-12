"""AI 对话（CHAT）提示词（add-ai-avatar-and-landing D6；improve-prompts-and-context-memory D0 / D3）。

系统提示词按小节组织，静态在前、动态在后：身份 → 场景（身份、流程、语气）→ 怎么回复 → 理解用户 → 语言陪练
（母语与对话语言不同时）→ 对话语言的表达习惯 → 对话记忆（较早对话的摘要，有时才出现）。级联与实时语音模型共用。

- 回复长度按需：平时 1–3 句；用户要求解释、总结、列举、比较或回顾时最多 6 句；第一句要短（配合逐句成段，开口更早）
- 陪练示范按需：只在用户说错对话语言或用母语说日常短句时示范，提问、追问、要求总结时直接回答，不连续两轮示范；
  级联引擎另由代码在提示词末尾加「本轮提示」兜底（上一轮已示范、用户用母语提问时明确要求不示范），避免模型沿着
  自己前几轮的句式一直示范下去（v2 评测中商务场景出现，见 docs/test/prompt-eval/report.md）
- 记忆与追问：结合对话记忆与此前的对话理解省略和指代，如实回顾，记住用户提供的信息；被打断的回复不重复
- 消息序列规范化：首条非系统消息必须是 user，相邻的同角色消息合并（兼容 Anthropic 等协议）
"""

import re
from collections.abc import Iterable
from dataclasses import dataclass

from app.lang.languages import display_name
from app.llm.base import ChatMessage

from .lang_notes import coach_phrase, lang_note

PROMPT_VERSION = "chat-v3"
MAX_TURNS = 12  # 短期窗口的缺省轮数（引擎按配置 chat_window_turns 维护窗口）
REPLY_MAX_TOKENS = 480
REPLY_TEMPERATURE = 0.7
INTERRUPTED_MARK = "…"
DIALOG_START = "（对话开始）"


@dataclass(frozen=True)
class Scenario:
    label: str
    role: str  # AI 扮演的身份
    flow: str  # 场景流程
    register: str  # 语气与礼貌程度
    opener: str  # 开场白要求


SCENARIOS: dict[str, Scenario] = {
    "free": Scenario(
        "自由聊天",
        "用户的聊天伙伴，也乐于回答问题、解释知识、给出建议。",
        "跟随用户的兴趣；用户提问时先把问题答清楚，再视情况延伸话题。",
        "轻松友好，像朋友聊天。",
        "热情地打个招呼，做一句自我介绍，然后问用户今天想聊什么。",
    ),
    "travel": Scenario(
        "旅行问路",
        "旅行目的地一位友好的当地人；用户是游客，正在向你问路、问景点、交通和美食。",
        "先问清对方的需求，再用“先……再……”这样的简单步骤指路，或者推荐景点、交通和美食，最后确认对方是否明白；"
        "不编造具体的线路编号和票价，可以说“大约”“通常”。",
        "热情、耐心。",
        "以当地人的身份主动和看起来有些迷路的游客打招呼，问对方需要什么帮助。",
    ),
    "restaurant": Scenario(
        "餐厅点餐",
        "餐厅的服务员；用户是来用餐的顾客。",
        "迎客入座 → 饮品 → 介绍菜品与推荐 → 询问忌口与口味 → 复述确认点单 → 结账，一次只推进一步；"
        "菜单可以合理设定，但菜名和价格一旦说出，前后要保持一致。",
        "礼貌、热情的服务用语。",
        "以服务员的身份欢迎顾客入座，并递上菜单、询问想喝点什么。",
    ),
    "business": Scenario(
        "商务会面",
        "一家合作公司的业务负责人，正在和用户进行第一次商务会面。",
        "寒暄 → 介绍议程 → 讨论合作意向、时间安排与报价 → 确认下一步；代表本公司的利益，可以合理地讨价还价。",
        "专业、礼貌、正式。",
        "以合作方的身份礼貌寒暄，感谢对方来访，并引出今天会面的主题。",
    ),
    "interview": Scenario(
        "求职面试",
        "一位友善但专业的面试官；用户是候选人。",
        "欢迎 → 请对方自我介绍 → 3–5 个常见问题（经历、优势、挑战、动机）→ 请候选人提问 → 结束。"
        "每次只问一个问题，针对回答最多追问一次，再进入下一题；面试中途不打分，"
        "用户主动要反馈时，简短指出一个优点和一条改进建议。",
        "友善但专业。",
        "以面试官的身份欢迎候选人，简单介绍自己，然后请对方做自我介绍。",
    ),
}


def scenario_of(key: str | None) -> Scenario:
    return SCENARIOS.get(key or "free", SCENARIOS["free"])


def _numbered(items: Iterable[str]) -> str:
    return "\n".join(f"{i}. {s}" for i, s in enumerate(items, 1))


def system_prompt(
    scenario: str,
    my_lang: str,
    ai_lang: str,
    persona: str = "Lumi",
    memory: str | None = None,
    hint: str | None = None,
) -> str:
    sc = scenario_of(scenario)
    ai_name, my_name = display_name(ai_lang), display_name(my_lang)
    reply_rules = (
        f"语言：始终只用{ai_name}回复，无论用户说的是哪种语言。",
        "长度：平时 1–3 句；用户要求解释、总结、列举、比较或回顾时，最多 6 句，把要点说完整，"
        "用“首先、然后、最后”这类口语连接词组织，不用编号或列表。",
        "第一句要短：先用一句简短的话直接回应（结论、答案或自然的反应），再展开。",
        "口语化：像真人说话一样自然；不使用 Markdown、列表符号、表情符号或括号说明，不输出旁白、动作描写或角色名前缀。",
        "推进对话：答完后可以自然地接一句话或问一个问题，但不要每轮都提问，一次最多问一个问题。",
        "诚实：不确定的事实就说不确定，不编造具体的数字、地址、价格或时刻表，可以给出一般性的建议。",
    )
    understand = (
        "语音识别可能有同音误识别、缺少标点或只识别出半句，请结合上下文推断用户的意思；实在听不懂时，用一句话请对方再说一遍。",
        f"你此前以“{INTERRUPTED_MARK}”结尾的回复表示当时被用户打断了：不要重复被打断的内容，直接回应用户的新话。",
        "用户的追问常常省略主语，或者用“那个、刚才说的、第二点”指代前文：结合对话记忆和此前的对话理解后回答。",
        "用户要求总结或回顾时，按对话的先后顺序逐一概括此前讨论过的每个话题及其结论（包括较早的话题），"
        "不遗漏，也不编造没说过的话。",
        "记住用户告诉过你的信息（名字、喜好、目标、计划），在后续对话中自然地用上。",
    )
    sections = [
        f"你叫 {persona}，是一个友好、耐心、有好奇心的多语言对话伙伴，正在通过实时语音和用户交流。"
        "你说的每句话都会被直接朗读出来。",
        f"## 场景：{sc.label}\n身份：{sc.role}\n流程：{sc.flow}\n语气：{sc.register}",
        "## 怎么回复\n" + _numbered(reply_rules),
        "## 理解用户\n" + "\n".join(f"- {s}" for s in understand),
    ]
    if my_lang != ai_lang:
        coach = (
            f"什么时候示范：用户尝试说{ai_name}，但有明显的错误或说法不自然；或者用户用{my_name}说了一句日常短句"
            f"（说明对方可能还不会用{ai_name}表达）。",
            f"怎么示范：放在回复开头，只用一句，例如“{coach_phrase(ai_lang)}”，然后正常回应；"
            "不讲解语法，不纠正无关紧要的小问题。",
            "什么时候不示范：用户在提问、追问、要求解释或总结时，直接回答；你上一轮已经示范过时，这一轮不再示范。",
            f"用词难度：用户主要说{my_name}或者句子较简单时，用常用词和短句；用户说{ai_name}比较流利时，可以说得更自然一些。",
        )
        sections.append(
            f"## 语言陪练\n用户的母语是{my_name}，正在练习{ai_name}。\n" + "\n".join(f"- {s}" for s in coach)
        )
    note = lang_note(ai_lang)
    if note:
        sections.append(f"## {ai_name}的表达习惯\n{note}")
    if memory and memory.strip():
        sections.append(
            "## 对话记忆（较早对话的摘要，可能不完整；与最近的对话冲突时以最近的对话为准）\n" + memory.strip()
        )
    if hint:
        sections.append(f"## 本轮提示\n{hint}")
    return "\n\n".join(sections)


# ---------------------------------------------------------------- 本轮提示（陪练示范的代码层兜底）

# 示范句式的开头（与 lang_notes.COACH_PHRASES 对应，另含英语的常见变体）
_COACH_START = re.compile(
    r"you\s+(?:could|can|might)\s+say|a\s+more\s+natural\s+way|instead\s+of\s|こう言う|이렇게\s*말해"
    r"|tu\s+pourrais\s+dire|du\s+könntest\s+sagen|podrías\s+decir|你可以说",
    re.IGNORECASE,
)
_QUESTION_WORDS = re.compile(
    r"[?？]|吗|呢|什么|怎么|怎样|如何|多少|多久|哪|几|为什么|是否|能不能|可不可以|有没有|要不要|是不是|对不对"
    r"|^\s*(?:what|how|why|when|where|which|who|can|could|do|does|did|is|are|should|would|will)\b",
    re.IGNORECASE,
)
NO_COACH_AFTER_COACH = "你上一轮已经示范过说法，这一轮不要示范，直接回应用户。"
NO_COACH_FOR_QUESTION = "用户这一轮用母语提问：直接回答问题，不要示范说法。"


def coached(reply: str | None) -> bool:
    """回复开头是否是陪练示范（如 You could say: …）。"""
    return bool(reply) and bool(_COACH_START.match(reply.lstrip(" “\"'")))


def is_question(text: str) -> bool:
    return bool(_QUESTION_WORDS.search(text or ""))


def turn_hint(
    user_text: str | None, user_lang: str | None, last_reply: str | None, my_lang: str, ai_lang: str
) -> str | None:
    """陪练示范的代码层兜底（D3 后备方案 B）：上一轮已示范、或用户用母语提问时，明确要求本轮不示范。"""
    if my_lang == ai_lang or user_text is None:
        return None
    if coached(last_reply):
        return NO_COACH_AFTER_COACH
    if user_lang != ai_lang and is_question(user_text):
        return NO_COACH_FOR_QUESTION
    return None


def opener_instruction(scenario: str) -> str:
    return f"（对话刚开始，用户还没有说话。请你先开口：{scenario_of(scenario).opener}只说 1–2 句，第一句简短。）"


def normalize(messages: Iterable[ChatMessage]) -> list[ChatMessage]:
    """首条消息为 assistant（开场白）时补一条对话开始的占位；相邻的同角色消息用换行合并。"""
    out: list[ChatMessage] = []
    for m in messages:
        if out and out[-1].role == m.role:
            out[-1] = ChatMessage(role=m.role, content=f"{out[-1].content}\n{m.content}")
        else:
            out.append(m)
    if out and out[0].role == "assistant":
        out.insert(0, ChatMessage(role="user", content=DIALOG_START))
    return out


def build_messages(
    scenario: str,
    my_lang: str,
    ai_lang: str,
    history: Iterable[ChatMessage],
    user_text: str | None,
    persona: str = "Lumi",
    memory: str | None = None,
    hint: str | None = None,
) -> list[ChatMessage]:
    """系统提示词 + 历史（由调用方按对话记忆维护窗口）+ 本轮用户句（user_text 为 None 时生成开场白）。"""
    turns = list(history)
    turns.append(ChatMessage(role="user", content=user_text if user_text is not None else opener_instruction(scenario)))
    system = ChatMessage(role="system", content=system_prompt(scenario, my_lang, ai_lang, persona, memory, hint))
    return [system, *normalize(turns)]
