"""mock LLM 的单元测试：用 openai SDK 调用，校验流式格式与各类 JSON 形态能被平台的解析逻辑接受。"""

import asyncio
import json
import socket
import threading
import time

import httpx
import pytest
import uvicorn
from openai import AsyncOpenAI, OpenAI

from mock_llm.server import Latency, create_app, guess_lang

# 平台提示词的关键片段（与 python-backend/app/agent/prompts.py、app/doc/prompts.py、app/lang/detector.py 一致）
SHORT_TRANSLATE_SYS = "你是一名专业译者，负责把英语（en）文本翻译成中文（zh）。\n\n## 硬性规则\n1. 只输出译文本身"
SHORT_REVIEW_SYS = (
    "你是一名严格的翻译质量评审员，负责评审英语（en）到中文（zh）的译文。\n\n## 输出格式\n只输出一个 JSON 对象"
)
SHORT_REFINE_SYS = "你是一名专业译者，负责根据评审意见修改英语（en）到中文（zh）的译文。"
DOMAIN_SYS = "判断用户消息中文本所属的专业领域，只输出一个简短的中文领域名称（2–6 个字）"
DETECT_SYS = '你是语种识别器。判断用户消息中文本所属的语种，只输出 JSON，格式为 {"lang": "代码"}'
DOC_ANALYZE_SYS = (
    "你是一名文档分析助手，负责在翻译前分析一篇英语（en）文档。\n\n## 输出格式\n只输出一个 JSON 对象，"
    '不要输出任何其他内容：\n{"summary": "中文摘要", "domain": "领域", "genre": "文体", '
    '"terms": [{"source": "原文写法", "target": "建议译法", "type": "term|name", "count": 1}]}'
)
DOC_ANALYZE_NO_SUMMARY_SYS = (
    "你是一名文档分析助手，负责在翻译前分析一篇英语（en）文档。\n\n## 输出格式\n"
    '{"domain": "领域", "genre": "文体", "terms": [{"source": "原文写法"}]}'
)
DOC_REDUCE_SYS = '你是一名文档摘要汇总助手。\n\n## 输出格式\n只输出一个 JSON 对象：{"summary": "全文摘要"}'
DOC_TRANSLATE_SYS = (
    "你是一名专业的篇章译者，负责把一篇英语（en）文档逐段翻译成中文（zh）。\n\n## 输出格式\n"
    '{"segments": [{"id": 段落编号, "text": "译文"}], "names": [{"source": "原文专名", "target": "译名"}]}'
)
DOC_REVIEW_SYS = "你是一名严格的文档翻译评审员，负责评审一批英语（en）到中文（zh）的文档段落译文。"
DOC_REFINE_SYS = "你是一名专业的篇章译者，负责根据评审意见修改文档译文（英语（en）→中文（zh））。"
DOC_FIX_SYS = "你是一名译文术语统一助手，处理英语（en）到中文（zh）的文档译文。"

JSON_MODE = {"response_format": {"type": "json_object"}}


def _client(app) -> AsyncOpenAI:
    http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://mock")
    return AsyncOpenAI(base_url="http://mock/v1", api_key="x", http_client=http, max_retries=0)


@pytest.fixture
def app():
    return create_app(Latency(first_token_ms=0, token_ms=0))


def _chat(app, system: str, user: str, **kw) -> tuple[str, object]:
    async def run():
        client = _client(app)
        resp = await client.chat.completions.create(
            model="mock-llm",
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            temperature=0,
            **kw,
        )
        await client.close()
        return resp

    resp = asyncio.run(run())
    return resp.choices[0].message.content, resp.usage


def test_models_endpoint(app):
    async def run():
        client = _client(app)
        page = await client.models.list()
        await client.close()
        return [m.id for m in page.data]

    assert asyncio.run(run()) == ["mock-llm"]


def test_stream_chunks_and_final_usage(app):
    async def run():
        client = _client(app)
        stream = await client.chat.completions.create(
            model="mock-llm",
            messages=[{"role": "system", "content": SHORT_TRANSLATE_SYS}, {"role": "user", "content": "Hello world"}],
            stream=True,
            stream_options={"include_usage": True},
        )
        chunks = [c async for c in stream]
        await client.close()
        return chunks

    chunks = asyncio.run(run())
    text = "".join(c.choices[0].delta.content or "" for c in chunks if c.choices)
    assert text == "【译】Hello world"
    assert len([c for c in chunks if c.choices and c.choices[0].delta.content]) > 1  # 分多个 token 输出
    assert chunks[-1].choices == [] and chunks[-1].usage.completion_tokens > 0  # 最后一个 chunk 带 usage
    assert any(c.choices and c.choices[0].finish_reason == "stop" for c in chunks)


def test_raw_sse_ends_with_done(app):
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://mock") as http:
            body = {"model": "m", "stream": True, "messages": [{"role": "user", "content": "hi"}]}
            resp = await http.post("/v1/chat/completions", json=body)
            return resp.headers["content-type"], resp.text

    ctype, text = asyncio.run(run())
    assert ctype.startswith("text/event-stream")
    events = [line for line in text.split("\n\n") if line]
    assert all(e.startswith("data: ") for e in events)
    assert events[-1] == "data: [DONE]"
    assert "usage" in json.loads(events[-2][6:])


def test_short_review_json_parses_as_passing(app):
    content, _ = _chat(
        app, SHORT_REVIEW_SYS, "<source>\nHi\n</source>\n\n<translation>\n你好\n</translation>", **JSON_MODE
    )
    obj = json.loads(content)
    assert obj == {"score": 95, "issues": []}


def test_short_refine_returns_current_translation(app):
    user = "<source>\nHi\n</source>\n\n<translation>\n【译】Hi\n</translation>\n\n<issues>\n1. x\n</issues>"
    content, _ = _chat(app, SHORT_REFINE_SYS, user)
    assert content == "【译】Hi"


def test_domain_and_detect(app):
    assert _chat(app, DOMAIN_SYS, "Kubernetes pods")[0] == "通用"
    obj = json.loads(_chat(app, DETECT_SYS, "こんにちは", **JSON_MODE)[0])
    assert obj["lang"] == "ja" and 0 <= obj["confidence"] <= 1


def test_guess_lang_scripts():
    assert [guess_lang(t) for t in ["你好", "안녕", "привет", "مرحبا", "สวัสดี", "hello"]] == [
        "zh",
        "ko",
        "ru",
        "ar",
        "th",
        "en",
    ]


def test_doc_translate_echoes_segments_with_prefix(app):
    items = {"segments": [{"id": 3, "text": "Run ⟦0⟧ now."}, {"id": 4, "text": "Second {para}."}]}
    user = "## 全文摘要\n摘要 {不是JSON}\n\n## 待译段落\n" + json.dumps(items, ensure_ascii=False)
    obj = json.loads(_chat(app, DOC_TRANSLATE_SYS, user, **JSON_MODE)[0])
    assert obj["segments"] == [{"id": 3, "text": "【译】Run ⟦0⟧ now."}, {"id": 4, "text": "【译】Second {para}."}]
    assert obj["names"] == []


def test_doc_review_refine_fix(app):
    items = {"segments": [{"id": 1, "source": "A", "translation": "【译】A"}]}
    review = json.loads(_chat(app, DOC_REVIEW_SYS, json.dumps(items), **JSON_MODE)[0])
    assert review == {"score": 95, "issues": []}
    refine = json.loads(_chat(app, DOC_REFINE_SYS, json.dumps({**items, "issues": []}), **JSON_MODE)[0])
    assert refine == {"segments": [{"id": 1, "text": "【译】A"}]}
    fix = json.loads(_chat(app, DOC_FIX_SYS, json.dumps(items), **JSON_MODE)[0])
    assert fix == {"segments": [{"id": 1, "text": "【译】A"}]}


def test_doc_analyze_respects_requested_fields(app):
    full = json.loads(_chat(app, DOC_ANALYZE_SYS, "body", **JSON_MODE)[0])
    assert full["terms"] == [] and full["summary"] and full["domain"] and full["genre"]
    partial = json.loads(_chat(app, DOC_ANALYZE_NO_SUMMARY_SYS, "body", **JSON_MODE)[0])
    assert "summary" not in partial and partial["terms"] == []
    reduce = json.loads(_chat(app, DOC_REDUCE_SYS, "【第 1 部分】\nx", **JSON_MODE)[0])
    assert set(reduce) == {"summary", "domain", "genre"}


def test_usage_counts(app):
    _, usage = _chat(app, SHORT_TRANSLATE_SYS, "abcdefgh")
    assert usage.prompt_tokens > 0 and usage.completion_tokens == 3  # "【译】abcdefgh" 共 10 字符，4 字符/token


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_real_server_latency_with_sync_sdk():
    """真实监听端口：首 token 延迟与 token 间隔生效，流式逐块到达。"""
    port = _free_port()
    app = create_app(Latency(first_token_ms=150, token_ms=10, chars_per_token=4))
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        for _ in range(100):
            if server.started:
                break
            time.sleep(0.05)
        client = OpenAI(base_url=f"http://127.0.0.1:{port}/v1", api_key="x", max_retries=0)
        started = time.perf_counter()
        stream = client.chat.completions.create(
            model="mock-llm",
            messages=[{"role": "user", "content": "x" * 38}],  # 输出 40 字符 = 10 个 token
            stream=True,
        )
        first = None
        for c in stream:
            if first is None and c.choices and c.choices[0].delta.content:
                first = time.perf_counter() - started
        total = time.perf_counter() - started
        assert 0.14 <= first < 0.6
        assert total >= 0.15 + 9 * 0.01 - 0.02  # 允许一个时钟分辨率（Windows 约 15.6 ms）的误差
    finally:
        server.should_exit = True
        thread.join(timeout=5)
