"""解读提示词（design D11）：一次 JSON 调用给出备选译法与关键表达；追问以中文流式答疑，不改动译文。"""

from collections.abc import Sequence

from app.lang.languages import AUTO, display_name
from app.llm.base import ChatMessage

REGISTERS = ("正式", "中性", "口语", "书面", "文学")

INSIGHTS_ROLE = "你是资深翻译讲解员"
ASK_ROLE = "你是翻译答疑助手"


def _lang(code: str) -> str:
    return "原文语言（未指定）" if code == AUTO else display_name(code)


def _pair(source: str, translation: str, source_lang: str, target_lang: str) -> str:
    return f"原文（{_lang(source_lang)}）：\n{source}\n\n当前译文（{display_name(target_lang)}）：\n{translation}"


def insights_messages(source: str, translation: str, source_lang: str, target_lang: str) -> list[ChatMessage]:
    tgt = display_name(target_lang)
    system = "\n".join(
        [
            f"{INSIGHTS_ROLE}，帮助用户理解一段译文，并给出其他可选的译法。",
            "输出要求：",
            f"1. alternatives：2–3 个与当前译文不同、且都忠实于原文的{tgt}备选译法；"
            "彼此之间在语体或措辞上要有明显区别。"
            "每项包含 text（备选译文）、register（语体，只能取：" + "、".join(REGISTERS) + "）、"
            "note（用中文一句话说明适用场景或与当前译文的差别）。",
            "2. expressions：原文中最值得讲解的关键表达（习语、搭配、术语、文化相关说法、易误译之处），至多 5 个。"
            f"每项包含 source（原文中的表达，一字不差）、target（在当前译文中对应的{tgt}说法）、"
            "meaning（中文释义）、note（中文用法说明或翻译要点）。原文很短且没有值得讲解的表达时可以为空数组。",
            "3. summary：用一句中文总结这段译文的处理思路或理解要点。",
            '只输出 JSON，格式为 {"alternatives": [{"text": "", "register": "中性", "note": ""}], '
            '"expressions": [{"source": "", "target": "", "meaning": "", "note": ""}], "summary": ""}，'
            "不要输出其他内容。",
        ]
    )
    return [
        ChatMessage(role="system", content=system),
        ChatMessage(role="user", content=_pair(source, translation, source_lang, target_lang)),
    ]


def ask_messages(
    source: str,
    translation: str,
    source_lang: str,
    target_lang: str,
    question: str,
    history: Sequence[tuple[str, str]],
) -> list[ChatMessage]:
    """history 为 (问, 答)，按时间顺序。"""
    system = "\n".join(
        [
            f"{ASK_ROLE}，围绕下面这段原文与译文回答用户的问题。",
            "规则：",
            "1. 一律用中文回答，简洁、具体，必要时引用原文或译文中的词句说明；不要使用 Markdown 标题。",
            "2. 你只负责解答，不会修改记录中的译文。用户要求改译时，可以给出建议译法并说明理由，"
            "同时提醒用户可在「备选译法」中采用或自行修改。",
            "3. 与这段翻译无关的问题，礼貌说明只能解答与当前翻译相关的问题。",
            "",
            _pair(source, translation, source_lang, target_lang),
        ]
    )
    messages = [ChatMessage(role="system", content=system)]
    for q, a in history:
        messages.append(ChatMessage(role="user", content=q))
        messages.append(ChatMessage(role="assistant", content=a))
    messages.append(ChatMessage(role="user", content=question))
    return messages
