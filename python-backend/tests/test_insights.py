"""4.4：POST /internal/insights（JSON）与 /internal/insights/ask（SSE）。"""

import json

import pytest

from app.insights.service import normalize_register, parse_insights
from app.llm.base import LLMError, LLMErrorKind
from tests.fakes import FakeLLM, parse_sse, use_fake_llm

URL = "/internal/insights"
ASK_URL = "/internal/insights/ask"

pytestmark = pytest.mark.usefixtures("db_admin")

SOURCE = "It's raining cats and dogs."
TRANSLATION = "下着倾盆大雨。"

GOOD = {
    "alternatives": [
        {"text": "雨下得很大。", "register": "中性", "note": "日常叙述最常用"},
        {"text": "外面雨大得不得了。", "register": "colloquial", "note": "口头表达"},
        {"text": "大雨滂沱。", "register": "偏文学", "note": "书面描写"},
        {"text": "暴雨如注。", "register": "书面", "note": "多余的第四个"},
    ],
    "expressions": [
        {"source": "raining cats and dogs", "target": "倾盆大雨", "meaning": "形容雨下得非常大", "note": "英语习语"}
    ],
    "summary": "原文是英语习语，译文采用中文成语对应。",
}


def body(**kw) -> dict:
    base = {"source": SOURCE, "translation": TRANSLATION, "sourceLang": "en", "targetLang": "zh"}
    base.update(kw)
    return base


class InsightsFake(FakeLLM):
    """chat 依次返回 replies；stream 复用 FakeLLM 的 translations。"""

    def __init__(self, replies: list[str] | None = None, **kw):
        super().__init__(**kw)
        self.replies = list(replies or [])

    async def chat(self, req):
        from app.llm.base import ChatResult, Usage

        self.calls.append(("insights", req))
        return ChatResult(content=self.replies.pop(0), model=self.model, usage=Usage(210, 180), latency_ms=1)


async def test_insights_success_normalized(app, client, monkeypatch):
    fake = InsightsFake([json.dumps(GOOD, ensure_ascii=False)])
    use_fake_llm(app, monkeypatch, fake)
    resp = await client.post(URL, json=body())
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert set(data) == {"alternatives", "expressions", "summary", "usage"}
    assert [a["text"] for a in data["alternatives"]] == ["雨下得很大。", "外面雨大得不得了。", "大雨滂沱。"]
    assert [a["register"] for a in data["alternatives"]] == ["中性", "口语", "文学"]
    assert data["expressions"][0]["source"] == "raining cats and dogs"
    assert data["summary"].startswith("原文是英语习语")
    assert data["usage"] == {"promptTokens": 210, "completionTokens": 180}
    req = fake.calls[0][1]
    assert SOURCE in req.messages[1].content and TRANSLATION in req.messages[1].content
    assert "正式、中性、口语、书面、文学" in req.messages[0].content


async def test_insights_retries_when_invalid(app, client, monkeypatch):
    too_few = {"alternatives": [{"text": TRANSLATION, "register": "中性", "note": "与当前译文相同"}]}
    fake = InsightsFake(["not json", json.dumps(GOOD, ensure_ascii=False)])
    use_fake_llm(app, monkeypatch, fake)
    resp = await client.post(URL, json=body())
    assert resp.status_code == 200 and len(fake.calls) == 2
    assert resp.json()["data"]["usage"] == {"promptTokens": 420, "completionTokens": 360}

    fake2 = InsightsFake([json.dumps(too_few, ensure_ascii=False), "{}"])
    use_fake_llm(app, monkeypatch, fake2)
    resp = await client.post(URL, json=body())
    assert resp.status_code == 502
    assert resp.json()["code"] == "C0140"


async def test_insights_source_too_long_returns_a0410(client):
    resp = await client.post(URL, json=body(source="a" * 3000))
    assert resp.status_code == 400
    assert resp.json()["code"] == "A0410"


@pytest.mark.parametrize(
    "patch,code",
    [({"translation": " "}, "A0410"), ({"targetLang": "xx"}, "A0420"), ({"sourceLang": "xx"}, "A0420")],
)
async def test_insights_validation(client, patch, code):
    resp = await client.post(URL, json=body(**patch))
    assert resp.json()["code"] == code


async def test_insights_llm_error(app, client, monkeypatch):
    class Failing(InsightsFake):
        async def chat(self, req):
            raise LLMError(LLMErrorKind.TIMEOUT)

    use_fake_llm(app, monkeypatch, Failing())
    resp = await client.post(URL, json=body())
    assert resp.json()["code"] == "C0122"


def test_parse_insights_filters_and_truncates():
    obj = dict(GOOD, expressions=[{"source": f"e{i}", "target": "t"} for i in range(7)] + [{"source": ""}])
    data = parse_insights(json.dumps(obj, ensure_ascii=False), TRANSLATION)
    assert len(data["alternatives"]) == 3 and len(data["expressions"]) == 5
    assert data["expressions"][0] == {"source": "e0", "target": "t", "meaning": "", "note": ""}
    assert parse_insights('{"alternatives": "x"}', TRANSLATION) is None


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("正式", "正式"),
        ("Formal", "正式"),
        ("非正式", "口语"),
        ("中性偏口语", "中性"),
        ("奇怪", "中性"),
        (None, "中性"),
    ],
)
def test_normalize_register(raw, expected):
    assert normalize_register(raw) == expected


# ---------------- ask ----------------


async def test_ask_streams_delta_then_done(app, client, monkeypatch):
    fake = FakeLLM(translations=["因为直译会让中文读者困惑。"], chunk_size=4)
    use_fake_llm(app, monkeypatch, fake)
    history = [{"q": "这是习语吗？", "a": "是的，是英语习语。"}]
    resp = await client.post(ASK_URL, json=body(question="为什么不直译？", history=history))
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    events = [e for e in parse_sse(resp.text) if e.event]
    assert {e.event for e in events[:-1]} == {"delta"}
    assert "".join(e.data["text"] for e in events[:-1]) == "因为直译会让中文读者困惑。"
    assert events[-1].event == "done"
    assert events[-1].data == {"usage": {"promptTokens": 200, "completionTokens": 20}}
    msgs = fake.calls[0][1].messages
    assert [m.role for m in msgs] == ["system", "user", "assistant", "user"]
    assert "中文回答" in msgs[0].content and "不会修改记录中的译文" in msgs[0].content
    assert SOURCE in msgs[0].content
    assert msgs[1].content == "这是习语吗？" and msgs[-1].content == "为什么不直译？"


async def test_ask_llm_error_event(app, client, monkeypatch):
    fake = FakeLLM(error=LLMError(LLMErrorKind.RATE_LIMIT))
    use_fake_llm(app, monkeypatch, fake)
    events = [e for e in parse_sse((await client.post(ASK_URL, json=body(question="为什么？"))).text) if e.event]
    assert [e.event for e in events] == ["error"]
    assert events[0].data["code"] == "C0123"


@pytest.mark.parametrize(
    "patch",
    [
        {"question": "  "},
        {"question": "q" * 501},
        {"question": "为什么？", "history": [{"q": "a", "a": "b"}] * 7},
        {"question": "为什么？", "source": "a" * 2001},
    ],
)
async def test_ask_validation_returns_a0410(client, patch):
    resp = await client.post(ASK_URL, json=body(**patch))
    assert resp.status_code == 400
    assert resp.json()["code"] == "A0410"
