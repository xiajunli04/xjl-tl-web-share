"""支持语种清单（design D3）。与 Spring 的语种常量保持同一份映射。"""

from dataclasses import dataclass

from lingua import Language

from app.core.errors import BizException, ErrorCode

AUTO = "auto"


@dataclass(frozen=True)
class LanguageInfo:
    code: str  # ISO 639-1
    name: str  # 中文名
    native_name: str  # 本族语名称
    lingua: Language
    # 是否按子串匹配术语（中日韩、泰文没有空格分词）；其余文字要求词边界
    substring_match: bool = False

    def to_vo(self) -> dict[str, str]:
        return {"code": self.code, "name": self.name, "nativeName": self.native_name}


LANGUAGES: tuple[LanguageInfo, ...] = (
    LanguageInfo("zh", "中文", "中文", Language.CHINESE, True),
    LanguageInfo("en", "英语", "English", Language.ENGLISH),
    LanguageInfo("ja", "日语", "日本語", Language.JAPANESE, True),
    LanguageInfo("ko", "韩语", "한국어", Language.KOREAN, True),
    LanguageInfo("fr", "法语", "Français", Language.FRENCH),
    LanguageInfo("de", "德语", "Deutsch", Language.GERMAN),
    LanguageInfo("es", "西班牙语", "Español", Language.SPANISH),
    LanguageInfo("ru", "俄语", "Русский", Language.RUSSIAN),
    LanguageInfo("pt", "葡萄牙语", "Português", Language.PORTUGUESE),
    LanguageInfo("it", "意大利语", "Italiano", Language.ITALIAN),
    LanguageInfo("ar", "阿拉伯语", "العربية", Language.ARABIC),
    LanguageInfo("th", "泰语", "ไทย", Language.THAI, True),
    LanguageInfo("vi", "越南语", "Tiếng Việt", Language.VIETNAMESE),
    LanguageInfo("id", "印尼语", "Bahasa Indonesia", Language.INDONESIAN),
    LanguageInfo("tr", "土耳其语", "Türkçe", Language.TURKISH),
)

BY_CODE: dict[str, LanguageInfo] = {lang.code: lang for lang in LANGUAGES}
BY_LINGUA: dict[Language, LanguageInfo] = {lang.lingua: lang for lang in LANGUAGES}
CODES: tuple[str, ...] = tuple(BY_CODE)


def is_supported(code: str | None) -> bool:
    return code in BY_CODE


def get(code: str) -> LanguageInfo:
    info = BY_CODE.get(code)
    if info is None:
        raise BizException(ErrorCode.UNSUPPORTED_LANGUAGE, f"不支持的语种: {code}")
    return info


def display_name(code: str | None) -> str:
    """提示词与摘要中使用的名称，如"英语"；未知代码原样返回。"""
    info = BY_CODE.get(code or "")
    return info.name if info else (code or "未知")
