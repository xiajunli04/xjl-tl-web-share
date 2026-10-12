import json

import httpx
import pytest
import respx

from app.llm.anthropic_client import AnthropicClient
from app.llm.base import ChatMessage, ChatRequest, LLMError, LLMErrorKind, content_text, image_part, text_part
from app.llm.openai_compat import OpenAICompatibleClient
from tests.respx_bridge import make_http_client

API_KEY = "sk-super-secret-key-0001"
OAI_URL = "https://llm.test/v1/chat/completions"
ANT_BASE = "https://anthropic.test"
ANT_URL = f"{ANT_BASE}/v1/messages"


def req(**kw) -> ChatRequest:
    return ChatRequest(messages=[ChatMessage("system", "be brief"), ChatMessage("user", "hi")], **kw)


def oai_client(timeout: float = 5) -> OpenAICompatibleClient:
    return OpenAICompatibleClient(
        base_url="https://llm.test/v1",
        api_key=API_KEY,
        model="deepseek-chat",
        timeout=timeout,
        http_client=make_http_client(),
    )


def ant_client(timeout: float = 5) -> AnthropicClient:
    return AnthropicClient(
        api_key=API_KEY, model="claude-test", base_url=ANT_BASE, timeout=timeout, http_client=make_http_client()
    )


def oai_completion(content="pong"):
    return {
        "id": "c1",
        "object": "chat.completion",
        "created": 1,
        "model": "deepseek-chat",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 9, "completion_tokens": 2, "total_tokens": 11},
    }


def ant_message(text="pong"):
    return {
        "id": "msg_1",
        "type": "message",
        "role": "assistant",
        "model": "claude-test",
        "content": [{"type": "text", "text": text}],
        "stop_reason": "end_turn",
        "stop_sequence": None,
        "usage": {"input_tokens": 7, "output_tokens": 3},
    }


def sse(events: list[tuple[str | None, object]]) -> bytes:
    out = []
    for name, data in events:
        payload = data if isinstance(data, str) else json.dumps(data)
        out.append((f"event: {name}\n" if name else "") + f"data: {payload}\n\n")
    return "".join(out).encode()


def error_body(status):
    return {"error": {"message": f"Incorrect API key provided: {API_KEY}", "type": "err"}, "type": "error"}


# ---------------- OpenAI 兼容 ----------------


@respx.mock
async def test_openai_chat_success_and_extra_passthrough():
    route = respx.post(OAI_URL).mock(return_value=httpx.Response(200, json=oai_completion()))
    res = await oai_client().chat(req(temperature=0.2, max_tokens=8, extra={"translation_options": {"x": 1}}))
    assert res.content == "pong"
    assert res.model == "deepseek-chat"
    assert (res.usage.prompt_tokens, res.usage.completion_tokens) == (9, 2)
    assert res.latency_ms >= 0
    sent = json.loads(route.calls.last.request.content)
    assert sent["translation_options"] == {"x": 1}
    assert sent["max_tokens"] == 8 and sent["temperature"] == 0.2


@pytest.mark.parametrize(
    "status,kind,code",
    [
        (401, LLMErrorKind.AUTH, "C0121"),
        (429, LLMErrorKind.RATE_LIMIT, "C0123"),
        (400, LLMErrorKind.BAD_REQUEST, "C0120"),
        (503, LLMErrorKind.UNAVAILABLE, "C0120"),
    ],
)
@respx.mock
async def test_openai_error_mapping(status, kind, code):
    respx.post(OAI_URL).mock(return_value=httpx.Response(status, json=error_body(status)))
    with pytest.raises(LLMError) as ei:
        await oai_client().chat(req())
    assert ei.value.kind == kind
    assert ei.value.error_code.code == code
    assert API_KEY not in str(ei.value)
    assert ei.value.__cause__ is None


@respx.mock
async def test_openai_timeout():
    respx.post(OAI_URL).mock(side_effect=httpx.ReadTimeout("timed out"))
    with pytest.raises(LLMError) as ei:
        await oai_client(timeout=0.5).chat(req())
    assert ei.value.kind == LLMErrorKind.TIMEOUT
    assert ei.value.error_code.code == "C0122"


@respx.mock
async def test_openai_stream_last_chunk_has_usage():
    def chunk(delta=None, usage=None, choices=True):
        return {
            "id": "c1",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "deepseek-chat",
            "choices": [{"index": 0, "delta": {"content": delta} if delta else {}, "finish_reason": None}]
            if choices
            else [],
            "usage": usage,
        }

    body = sse(
        [
            (None, chunk("po")),
            (None, chunk("ng")),
            (None, chunk(choices=False, usage={"prompt_tokens": 9, "completion_tokens": 2, "total_tokens": 11})),
            (None, "[DONE]"),
        ]
    )
    route = respx.post(OAI_URL).mock(
        return_value=httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})
    )
    chunks = [c async for c in oai_client().stream(req())]
    assert "".join(c.delta for c in chunks) == "pong"
    last = chunks[-1]
    assert last.done and last.usage is not None
    assert (last.usage.prompt_tokens, last.usage.completion_tokens) == (9, 2)
    assert last.latency_ms is not None
    assert all(c.usage is None for c in chunks[:-1])
    sent = json.loads(route.calls.last.request.content)
    assert sent["stream"] is True and sent["stream_options"] == {"include_usage": True}


@respx.mock
async def test_openai_stream_error_mapped():
    respx.post(OAI_URL).mock(return_value=httpx.Response(401, json=error_body(401)))
    with pytest.raises(LLMError) as ei:
        _ = [c async for c in oai_client().stream(req())]
    assert ei.value.kind == LLMErrorKind.AUTH


# ---------------- Anthropic ----------------


@respx.mock
async def test_anthropic_chat_success_system_split():
    route = respx.post(ANT_URL).mock(return_value=httpx.Response(200, json=ant_message()))
    res = await ant_client().chat(req(max_tokens=8, extra={"metadata": {"user_id": "u1"}}))
    assert res.content == "pong"
    assert res.model == "claude-test"
    assert (res.usage.prompt_tokens, res.usage.completion_tokens) == (7, 3)
    sent = json.loads(route.calls.last.request.content)
    assert sent["system"] == "be brief"
    assert all(m["role"] != "system" for m in sent["messages"])
    assert sent["max_tokens"] == 8
    assert sent["metadata"] == {"user_id": "u1"}


@respx.mock
async def test_anthropic_ignores_temperature():
    """anthropic SDK 1.x 不再接受 temperature；传入时应被忽略而不是导致调用失败。"""
    route = respx.post(ANT_URL).mock(return_value=httpx.Response(200, json=ant_message()))
    res = await ant_client().chat(req(temperature=0, max_tokens=8))
    assert res.content == "pong"
    assert "temperature" not in json.loads(route.calls.last.request.content)


@pytest.mark.parametrize(
    "status,kind,code",
    [
        (401, LLMErrorKind.AUTH, "C0121"),
        (429, LLMErrorKind.RATE_LIMIT, "C0123"),
        (400, LLMErrorKind.BAD_REQUEST, "C0120"),
        (529, LLMErrorKind.UNAVAILABLE, "C0120"),
    ],
)
@respx.mock
async def test_anthropic_error_mapping(status, kind, code):
    respx.post(ANT_URL).mock(return_value=httpx.Response(status, json=error_body(status)))
    with pytest.raises(LLMError) as ei:
        await ant_client().chat(req())
    assert ei.value.kind == kind
    assert ei.value.error_code.code == code
    assert API_KEY not in str(ei.value)


@respx.mock
async def test_anthropic_timeout():
    respx.post(ANT_URL).mock(side_effect=httpx.ReadTimeout("timed out"))
    with pytest.raises(LLMError) as ei:
        await ant_client(timeout=0.5).chat(req())
    assert ei.value.kind == LLMErrorKind.TIMEOUT
    assert ei.value.error_code.code == "C0122"


@respx.mock
async def test_anthropic_stream_last_chunk_has_usage():
    msg = ant_message()
    msg["content"] = []
    msg["usage"] = {"input_tokens": 7, "output_tokens": 1}
    body = sse(
        [
            ("message_start", {"type": "message_start", "message": msg}),
            (
                "content_block_start",
                {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
            ),
            (
                "content_block_delta",
                {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "po"}},
            ),
            (
                "content_block_delta",
                {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "ng"}},
            ),
            ("content_block_stop", {"type": "content_block_stop", "index": 0}),
            (
                "message_delta",
                {
                    "type": "message_delta",
                    "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                    "usage": {"output_tokens": 3},
                },
            ),
            ("message_stop", {"type": "message_stop"}),
        ]
    )
    respx.post(ANT_URL).mock(
        return_value=httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})
    )
    chunks = [c async for c in ant_client().stream(req())]
    assert "".join(c.delta for c in chunks) == "pong"
    last = chunks[-1]
    assert last.done and last.usage is not None
    assert (last.usage.prompt_tokens, last.usage.completion_tokens) == (7, 3)
    assert last.model == "claude-test"
    assert all(c.usage is None for c in chunks[:-1])


# ---------------- 多模态消息（图片翻译 OCR，add-speech-and-image-translation 4.2）----------------

DATA_URL = "data:image/jpeg;base64,/9j/AAAA"


def vision_req() -> ChatRequest:
    return ChatRequest(
        messages=[
            ChatMessage("system", "ocr"),
            ChatMessage("user", [text_part("图片宽 64 像素、高 32 像素"), image_part(DATA_URL)]),
        ]
    )


@respx.mock
async def test_openai_multimodal_content_passthrough():
    route = respx.post(OAI_URL).mock(return_value=httpx.Response(200, json=oai_completion("{}")))
    await oai_client().chat(vision_req())
    sent = json.loads(route.calls.last.request.content)
    assert sent["messages"][0] == {"role": "system", "content": "ocr"}
    assert sent["messages"][1]["content"] == [
        {"type": "text", "text": "图片宽 64 像素、高 32 像素"},
        {"type": "image_url", "image_url": {"url": DATA_URL}},
    ]


@respx.mock
async def test_anthropic_multimodal_content_converted():
    route = respx.post(ANT_URL).mock(return_value=httpx.Response(200, json=ant_message("{}")))
    await ant_client().chat(vision_req())
    sent = json.loads(route.calls.last.request.content)
    assert sent["system"] == "ocr"
    assert sent["messages"][0]["content"] == [
        {"type": "text", "text": "图片宽 64 像素、高 32 像素"},
        {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "/9j/AAAA"}},
    ]


def test_content_text_joins_text_parts():
    assert content_text("plain") == "plain"
    assert content_text([text_part("a"), image_part(DATA_URL), text_part("b")]) == "a\nb"


def test_anthropic_chat_history_starts_with_user():
    """improve-prompts-and-context-memory 3.2：开场白在前的 AI 对话历史经规范化后，Anthropic 请求的首条消息为 user。"""
    from app.interpret.chat_prompts import build_messages

    history = [ChatMessage(role="assistant", content="Hi!"), ChatMessage(role="user", content="a")]
    messages = build_messages("free", "zh", "en", history, "b")
    kw = ant_client()._kwargs(ChatRequest(messages=messages))
    assert [m["role"] for m in kw["messages"]] == ["user", "assistant", "user"]
    assert "## 场景" in kw["system"]
