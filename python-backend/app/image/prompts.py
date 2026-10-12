"""图片翻译提示词（design D10）：视觉 OCR 与批量编号翻译。"""

import json
from collections.abc import Sequence

from app.glossary.matcher import TermHit
from app.lang.languages import CODES, display_name
from app.llm.base import ChatMessage, image_part, text_part

OCR_ROLE = "你是图片文字识别（OCR）引擎"

OCR_SYSTEM_PROMPT = (
    OCR_ROLE + "，负责找出图片中所有可读的文字，并给出每个文字块在图片中的像素位置。\n"
    "规则：\n"
    "1. 按阅读顺序（从上到下、从左到右）列出文字块；同一行、语义连贯的文字合为一块，"
    "菜单的每个菜名、表格的每个单元格、标题与正文分别成块；不要把相距较远的文字合并。\n"
    "2. text 必须与图片中的文字一字不差，保留原有的标点、数字和大小写，不要翻译、纠错或补全。\n"
    "3. bbox 为该文字块的外接矩形像素坐标 [x0, y0, x1, y1]：原点在图片左上角，x 向右、y 向下，"
    "x0<x1、y0<y1，且不超出图片宽高。\n"
    "4. 忽略纯装饰图案、无法辨认的文字和水印 Logo 中的图形部分。\n"
    "5. lang 为图片文字的主要语种，只能取以下 ISO 639-1 代码之一：" + ", ".join(CODES) + "；没有文字时为 null。\n"
    '只输出 JSON，格式为 {"lang": "zh", "blocks": [{"text": "文字", "bbox": [x0, y0, x1, y1]}]}；'
    '图片中没有文字时输出 {"lang": null, "blocks": []}。不要输出其他内容。'
)

TRANSLATE_ROLE = "你是专业的图片翻译引擎"


def ocr_messages(data_url: str, width: int, height: int) -> list[ChatMessage]:
    return [
        ChatMessage(role="system", content=OCR_SYSTEM_PROMPT),
        ChatMessage(
            role="user",
            content=[
                text_part(f"图片宽 {width} 像素、高 {height} 像素。请识别图中的全部文字并给出像素 bbox。"),
                image_part(data_url),
            ],
        ),
    ]


def _escape_cell(s: str) -> str:
    return s.replace("|", "\\|").replace("\n", " ")


def translate_messages(
    blocks: Sequence[tuple[int, str]], source_lang: str | None, target_lang: str, terms: Sequence[TermHit]
) -> list[ChatMessage]:
    """批量编号翻译：整图文字作为上下文，术语库命中为硬约束。blocks 为 (id, 原文)。"""
    src = display_name(source_lang) if source_lang else "原文语言"
    tgt = display_name(target_lang)
    lines = [
        f"{TRANSLATE_ROLE}，负责把从一张图片中识别出的文字块从{src}翻译成{tgt}。",
        "规则：",
        "1. 用户消息是 JSON，blocks 按图片中的阅读顺序列出全部文字块（id 与原文）。"
        "这些文字共同构成上下文（如菜单、路牌、海报、商品包装、说明书），请先通读全部文字判断场景，再逐块翻译。",
        "2. 每块单独翻译，译文只对应该块原文；不要合并、拆分或遗漏文字块，id 与输入一一对应。",
        "3. 译文简洁自然，长度尽量与原文相当，适合覆盖回原图的相应位置；菜名、标题等按目标语言的惯用说法。",
        "4. 数字、价格、单位、URL、型号与代码原样保留；某块已是目标语言或无需翻译时原样输出。",
    ]
    if terms:
        lines.append("5. 术语表中列出的术语必须使用给定译法。")
        lines.append("")
        lines.append("术语表（必须遵循）：")
        lines.append("| 原文术语 | 译法 |")
        lines.append("| --- | --- |")
        lines += [f"| {_escape_cell(t.source)} | {_escape_cell(t.target)} |" for t in terms]
    lines.append("")
    lines.append('只输出 JSON，格式为 {"translations": [{"id": 1, "text": "译文"}]}，不要输出其他内容。')
    payload = json.dumps({"blocks": [{"id": i, "text": t} for i, t in blocks]}, ensure_ascii=False)
    return [ChatMessage(role="system", content="\n".join(lines)), ChatMessage(role="user", content=payload)]
