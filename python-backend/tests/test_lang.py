"""2.1–2.3：语种清单、语种识别、/internal/lang/detect。"""

import httpx
import pytest
import respx

from app.core.config import get_settings
from app.core.errors import BizException
from app.lang import languages
from app.lang.detector import LanguageDetector, _parse_llm_detect
from app.llm.base import LLMError, LLMErrorKind
from tests.fakes import FakeLLM
from tests.test_llm_clients import OAI_URL, oai_completion


@pytest.fixture(scope="module")
def detector() -> LanguageDetector:
    d = LanguageDetector(get_settings())
    d.warmup()
    return d


def provider_of(fake):
    async def _p():
        return fake

    return _p


# ---------------- 2.1 语种清单 ----------------


def test_languages_15_unique():
    codes = [lang.code for lang in languages.LANGUAGES]
    assert len(codes) == 15
    assert len(set(codes)) == 15
    assert set(codes) == {"zh", "en", "ja", "ko", "fr", "de", "es", "ru", "pt", "it", "ar", "th", "vi", "id", "tr"}
    assert len({lang.lingua for lang in languages.LANGUAGES}) == 15
    assert languages.BY_CODE["ja"].to_vo() == {"code": "ja", "name": "日语", "nativeName": "日本語"}
    for lang in languages.LANGUAGES:
        assert lang.lingua.iso_code_639_1.name.lower() == lang.code


def test_language_get_unsupported():
    with pytest.raises(BizException) as ei:
        languages.get("xx")
    assert ei.value.error.code == "A0420"


# ---------------- 2.2 语种识别 ----------------


async def test_detect_chinese(detector):
    fake = FakeLLM()
    r = await detector.detect("今天天气很好，我们去公园散步吧。", provider_of(fake))
    assert (r.lang, r.method) == ("zh", "lingua")
    assert r.confidence >= 0.9
    assert fake.calls == []
    assert 1 <= len(r.candidates) <= 3


async def test_detect_japanese_not_chinese(detector):
    r = await detector.detect("今日はいい天気ですね。", provider_of(FakeLLM()))
    assert r.lang == "ja"
    assert r.method == "lingua"


async def test_detect_french(detector):
    r = await detector.detect("Bonjour, comment allez-vous aujourd'hui ?", provider_of(FakeLLM()))
    assert r.lang == "fr"
    assert r.method == "lingua"


async def test_detect_short_text_uses_llm(detector):
    fake = FakeLLM(detect='{"lang": "en", "confidence": 0.95}')
    r = await detector.detect("Hi", provider_of(fake))
    assert fake.kinds() == ["detect"]
    assert (r.lang, r.method, r.confidence) == ("en", "llm", 0.95)
    assert r.usage is not None
    assert r.to_vo()["candidates"] == [{"lang": c, "confidence": v} for c, v in r.candidates]


async def test_detect_llm_failure_falls_back_to_lingua(detector):
    class Broken(FakeLLM):
        async def chat(self, req):
            raise LLMError(LLMErrorKind.AUTH)

    r = await detector.detect("Hi", provider_of(Broken()))
    assert r.method == "lingua"
    assert r.lang in languages.CODES


@pytest.mark.parametrize("text", ["", "   \n\t"])
async def test_detect_blank_text_a0410(detector, text):
    with pytest.raises(BizException) as ei:
        await detector.detect(text, provider_of(FakeLLM()))
    assert ei.value.error.code == "A0410"


def test_parse_llm_detect_tolerant():
    assert _parse_llm_detect('```json\n{"lang":"JA","confidence":0.8}\n```') == ("ja", 0.8)
    assert _parse_llm_detect("The language is: ko") == ("ko", None)
    assert _parse_llm_detect('{"lang":"xx"}') == (None, None)


# ---------------- 2.3 /internal/lang/detect ----------------


async def test_detect_api_lingua(client):
    resp = await client.post("/internal/lang/detect", json={"text": "Bonjour, comment allez-vous aujourd'hui ?"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["code"] == "00000"
    data = body["data"]
    assert set(data) == {"lang", "confidence", "method", "candidates"}
    assert data["lang"] == "fr" and data["method"] == "lingua"
    assert all(set(c) == {"lang", "confidence"} for c in data["candidates"])


@respx.mock
async def test_detect_api_short_text_llm_fallback(client, db_admin, insert_config):
    insert_config(is_default=True)
    route = respx.post(OAI_URL).mock(
        return_value=httpx.Response(200, json=oai_completion('{"lang": "en", "confidence": 0.9}'))
    )
    resp = await client.post("/internal/lang/detect", json={"text": "Hi"})
    data = resp.json()["data"]
    assert (data["lang"], data["method"]) == ("en", "llm")
    sent = route.calls.last.request.read().decode()
    assert '"response_format"' in sent and "json_object" in sent


async def test_detect_api_blank_a0410(client):
    resp = await client.post("/internal/lang/detect", json={"text": "  "})
    assert resp.status_code == 400
    assert resp.json()["code"] == "A0410"


async def test_detect_api_requires_token(client):
    resp = await client.post("/internal/lang/detect", json={"text": "hello"}, headers={"X-Internal-Token": ""})
    assert resp.status_code == 401
    assert resp.json()["code"] == "B0100"
