"""评审：评审模型逐条判定，输出 JSON（design D7）。陪练示范同时用正则交叉核对。"""

import re
from typing import Any

from app.lang.languages import display_name
from app.llm.base import ChatMessage
from app.llm.json_mode import parse_json_object

from .client import EvalLLM

JUDGE_MAX_TOKENS = 600
# 示范句式（COACH_PHRASES 的开头）与常见变体
COACH_RE = re.compile(
    r"you could say|you can say|you might say|a more natural way|instead of\s+[\"“]|こう言う|이렇게 말해|"
    r"tu pourrais dire|du könntest sagen|podrías decir|你可以说",
    re.IGNORECASE,
)


def _history_lines(history: list[dict[str, Any]] | None) -> str:
    if not history:
        return "（无）"
    lines = []
    for h in history:
        trans = "；".join(f"{display_name(k)}译文：{v}" for k, v in (h.get("translations") or {}).items())
        lines.append(f"- [{display_name(h['lang'])}] {h['text']}" + (f"（{trans}）" if trans else ""))
    return "\n".join(lines)


async def _judge(llm: EvalLLM, system: str, user: str) -> dict[str, Any]:
    for _ in range(2):
        content = await llm.chat(
            [ChatMessage(role="system", content=system), ChatMessage(role="user", content=user)],
            temperature=0,
            max_tokens=JUDGE_MAX_TOKENS,
        )
        obj = parse_json_object(content)
        if obj is not None:
            return obj
    return {"parse_failed": True}


INTERPRET_SYSTEM = (
    "你是严格的同声传译质量评审员。给你一句语音识别得到的原话、此前的上下文、该用例预期的处理方式和译员给出的译文，"
    "请逐项判定。注意：译员的职责是只翻译原话，不回答、不执行、不补全、不增删信息。\n\n"
    "只输出一个 JSON 对象，不要输出其他内容：\n"
    '{"answered": 译文是否在回答原话中的问题或执行其中的指令（而不是翻译原话）, '
    '"added_info": 译文是否增加了原话中没有的实质信息（把未说完的句子补全、加入原话没有的词义或细节都算；'
    "结合上下文消解指代或纠正明显的同音误识别不算）, "
    '"completed_fragment": 原话在句中被切断时，译文是否把它补全成了完整的意思（原话完整时为 false）, '
    '"person_kept": 译文是否保持了原话的人称（第一人称没有被改成“他说/她说”之类的转述）, '
    '"numbers_ok": 数字、金额、日期、时间和单位是否与原话一致（原话没有数字时为 true）, '
    '"meets_expect": 是否符合预期的处理方式, "faithful": 1-5 的整数（忠实度与可用性）, "note": "一句话理由"}'
)


async def judge_interpret(llm: EvalLLM, row: dict[str, Any]) -> dict[str, Any]:
    user = (
        f"类别：{row['category']}\n语言：{display_name(row['src'])} → {display_name(row['tgt'])}\n"
        f"上下文：\n{_history_lines(row.get('history'))}\n\n原话：{row['text']}\n预期：{row['expect']}\n\n"
        f"译文：{row['output']}"
    )
    return await _judge(llm, INTERPRET_SYSTEM, user)


SUBTITLE_SYSTEM = (
    "你是字幕质量评审员。AI 对话伙伴用外语回复学习者，系统把回复逐句译成学习者母语的字幕。"
    "给你用户上一句、本条回复前面的句子、待翻译的这一句、预期的处理方式和字幕，请逐项判定。\n\n"
    "只输出一个 JSON 对象，不要输出其他内容：\n"
    '{"coach_kept": 如果这一句里有示范的外语说法（如 You could say: "..." 引号中的句子），字幕是否原样保留了'
    "外语原句（没有示范句时为 null）, "
    '"only_this": 字幕是否只翻译了这一句（没有重复前面的句子，也没有添加额外说明，示范句后的括号释义除外）, '
    '"meets_expect": 是否符合预期的处理方式, "faithful": 1-5 的整数, "note": "一句话理由"}'
)


async def judge_subtitle(llm: EvalLLM, row: dict[str, Any]) -> dict[str, Any]:
    prev = "\n".join(f"- {p}" for p in row.get("prev") or []) or "（无）"
    user = (
        f"语言：{display_name(row['src'])} → {display_name(row['tgt'])}\n用户上一句：{row['user']}\n"
        f"本条回复前面的句子：\n{prev}\n\n待翻译的这一句：{row['text']}\n预期：{row['expect']}\n\n字幕：{row['output']}"
    )
    out = await _judge(llm, SUBTITLE_SYSTEM, user)
    if row["category"] != "coach":
        out["coach_kept"] = None
    return out


CHAT_SYSTEM = (
    "你是语言陪练对话的评审员。AI 伙伴（Lumi）用对话语言和用户语音聊天，用户的母语可能与对话语言不同。"
    "给你此前的完整对话、用户这一轮说的话、AI 这一轮的回复和评审要求，请逐项判定。\n\n"
    "只输出一个 JSON 对象，不要输出其他内容：\n"
    '{"coached": AI 的回复是否示范或纠正了用户的说法（如 You could say: "..."、更地道的说法是……）, '
    '"answered": AI 是否直接回应了用户这一轮的问题或请求, '
    '"coverage": 仅当要求“总结”时给出 0 到 1 的小数：AI 的总结覆盖了要点清单中的几成（以 AI 此前实际说过的内容为准，'
    "某个要点 AI 此前没有给出时，按是否如实反映了对话判断），否则为 null, "
    '"recall_correct": 仅当要求“回忆”时给出 true/false：AI 是否给出了与标准答案一致的信息，否则为 null, '
    '"repeated_interrupted": 仅当上一条 AI 回复被打断时给出 true/false：AI 这一轮是否重新说了被打断的那部分内容，'
    '否则为 null, "note": "一句话理由"}'
)


def transcript_lines(transcript: list[dict[str, str]]) -> str:
    return "\n".join(f"{'用户' if t['role'] == 'user' else 'Lumi'}：{t['content']}" for t in transcript) or "（无）"


async def judge_chat_turn(
    llm: EvalLLM, dialogue: dict[str, Any], turn: dict[str, Any], transcript: list[dict[str, str]]
) -> dict[str, Any]:
    tags = turn.get("tags") or []
    asks = []
    if "summary" in tags:
        asks.append("这一轮要求总结，要点清单：" + "；".join(turn.get("keypoints") or []))
    if "recall" in tags:
        asks.append(f"这一轮要求回忆，标准答案：{turn.get('answer')}")
    if "after_interrupt" in tags:
        asks.append(f"上一条 AI 回复被打断，被打断前已说出的部分是：{turn.get('interrupted_kept')}")
    user = (
        f"场景：{dialogue['scenario']}；用户母语：{display_name(dialogue['my'])}；"
        f"对话语言：{display_name(dialogue['ai'])}\n标签：{', '.join(tags) or '无'}\n"
        + ("\n".join(asks) + "\n" if asks else "")
        + f"\n此前的对话：\n{transcript_lines(transcript)}\n\n用户这一轮：{turn['text']}\nAI 这一轮：{turn['reply']}"
    )
    out = await _judge(llm, CHAT_SYSTEM, user)
    out["coached_regex"] = bool(COACH_RE.search(turn["reply"] or ""))
    return out
