"""与语言相关的提示词素材（improve-prompts-and-context-memory D0 / D1 / D3）。

- LANG_NOTES：目标语言的表达习惯（标点、敬语或礼貌程度、口语习惯），同传译文、AI 对话回复与母语字幕共用
- FILLERS：源语言的口语填充词，写进同传规则"去掉没有实际意义的填充词"
- COACH_PHRASES：AI 对话陪练的示范句式
"""

from app.lang.languages import display_name

LANG_NOTES: dict[str, str] = {
    "zh": "使用简体中文和中文全角标点；表达自然，避免翻译腔。",
    "en": "使用自然的口语表达，可以使用常见的缩约形式（如 I'm、don't）。",
    "ja": "默认使用です・ます体；使用日文标点（、。）。",
    "ko": "默认使用해요체；正式场合（如商务）使用합니다체。",
    "fr": "对不熟悉的人默认用 vous；遵循法语标点习惯（? ! : ; 前加空格）。",
    "de": "对不熟悉的人默认用 Sie。",
    "es": "礼貌场合用 usted，轻松场合用 tú；疑问句和感叹句使用 ¿ ¡。",
    "ru": "对不熟悉的人默认用 Вы。",
    "pt": "使用通行的巴西葡萄牙语表达，默认用 você。",
    "it": "对不熟悉的人默认用礼貌式 Lei。",
    "ar": "使用现代标准阿拉伯语和阿拉伯文标点（، ؟）。",
    "th": "语气礼貌；无法判断说话人性别时省略句末礼貌助词。",
    "vi": "根据语境选择得体的人称代词，默认礼貌、中性的称呼。",
    "id": "使用标准印尼语，礼貌场合用 Anda。",
    "tr": "对不熟悉的人默认用 siz。",
}

FILLERS: dict[str, str] = {
    "zh": "嗯、呃、啊、那个、就是、就是说",
    "en": "um, uh, er, like, you know",
    "ja": "えーと、あの、まあ",
    "ko": "음, 어, 그, 저기",
}

COACH_PHRASES: dict[str, str] = {
    "en": 'You could say: "…"',
    "ja": "こう言うと自然ですよ：「…」",
    "ko": '이렇게 말해 보세요: "…"',
    "fr": "Tu pourrais dire : « … »",
    "de": "Du könntest sagen: „…“",
    "es": "Podrías decir: «…»",
    "zh": "你可以说：“……”",
}


def lang_note(code: str | None) -> str:
    """目标语言的表达习惯；粤语按中文处理，未收录的语言为空串。"""
    return LANG_NOTES.get("zh" if code == "yue" else code or "", "")


def fillers(code: str | None) -> str:
    return FILLERS.get("zh" if code == "yue" else code or "", "语气填充词")


def coach_phrase(code: str) -> str:
    return COACH_PHRASES.get(code) or f"用{display_name(code)}说“你可以这样说：……”"
