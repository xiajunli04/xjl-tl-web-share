"""默认音色表（design D5）：平台 15 语种 × 女声/男声。"""

FEMALE = "female"
MALE = "male"

# Edge 在线语音（ShortName，已用 edge_tts.list_voices() 核对存在）
EDGE_VOICES: dict[str, dict[str, str]] = {
    "zh": {FEMALE: "zh-CN-XiaoxiaoNeural", MALE: "zh-CN-YunxiNeural"},
    "en": {FEMALE: "en-US-AvaMultilingualNeural", MALE: "en-US-AndrewMultilingualNeural"},
    "ja": {FEMALE: "ja-JP-NanamiNeural", MALE: "ja-JP-KeitaNeural"},
    "ko": {FEMALE: "ko-KR-SunHiNeural", MALE: "ko-KR-InJoonNeural"},
    "fr": {FEMALE: "fr-FR-DeniseNeural", MALE: "fr-FR-HenriNeural"},
    "de": {FEMALE: "de-DE-KatjaNeural", MALE: "de-DE-ConradNeural"},
    "es": {FEMALE: "es-ES-ElviraNeural", MALE: "es-ES-AlvaroNeural"},
    "ru": {FEMALE: "ru-RU-SvetlanaNeural", MALE: "ru-RU-DmitryNeural"},
    "pt": {FEMALE: "pt-BR-FranciscaNeural", MALE: "pt-BR-AntonioNeural"},
    "it": {FEMALE: "it-IT-ElsaNeural", MALE: "it-IT-DiegoNeural"},
    "ar": {FEMALE: "ar-SA-ZariyahNeural", MALE: "ar-SA-HamedNeural"},
    "th": {FEMALE: "th-TH-PremwadeeNeural", MALE: "th-TH-NiwatNeural"},
    "vi": {FEMALE: "vi-VN-HoaiMyNeural", MALE: "vi-VN-NamMinhNeural"},
    "id": {FEMALE: "id-ID-GadisNeural", MALE: "id-ID-ArdiNeural"},
    "tr": {FEMALE: "tr-TR-EmelNeural", MALE: "tr-TR-AhmetNeural"},
}
EDGE_FALLBACK = EDGE_VOICES["en"]  # 未知语种用多语种英文音色

# OpenAI 兼容 /audio/speech 的音色（模型配置 extra.voice 优先）
OPENAI_VOICES: dict[str, str] = {FEMALE: "nova", MALE: "onyx"}


def edge_voice(lang: str | None, gender: str | None = FEMALE) -> str:
    table = EDGE_VOICES.get((lang or "").split("-")[0], EDGE_FALLBACK)
    return table.get(gender or FEMALE, table[FEMALE])


def openai_voice(gender: str | None = FEMALE) -> str:
    return OPENAI_VOICES.get(gender or FEMALE, OPENAI_VOICES[FEMALE])
