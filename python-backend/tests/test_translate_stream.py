"""3.4 / 3.5：POST /internal/translate/stream（与契约样例结构一致、心跳、超时、断开取消、错误事件）。"""

import asyncio
import json
import socket
import threading
import time

import httpx
import pytest
import respx
import uvicorn

from app.core.config import get_settings
from tests.conftest import INTERNAL_TOKEN
from tests.fakes import FakeLLM, load_sample_streams, parse_sse, review_json, structure, use_fake_llm
from tests.test_llm_clients import OAI_URL

URL = "/internal/translate/stream"

pytestmark = pytest.mark.usefixtures("db_admin")


def body(**kw) -> dict:
    base = {"text": "Good morning", "sourceLang": "auto", "targetLang": "zh", "mode": "auto", "userId": 1}
    base.update(kw)
    return base


def override_settings(app, **kw) -> None:
    app.state.settings = app.state.settings.model_copy(update=kw)


async def post_stream(client, payload) -> tuple[httpx.Response, str]:
    resp = await client.post(URL, json=payload)
    return resp, resp.text


def assert_single_line_json(text: str) -> None:
    for line in text.splitlines():
        if line.startswith("data:"):
            json.loads(line[len("data:") :])  # 每个 data 行都是完整 JSON


# ---------------- 与契约样例结构一致 ----------------


def _collapse(events):
    """去掉心跳，并把连续的 delta 合并为第一个。"""
    named = [e for e in events if e.event]
    return [e for i, e in enumerate(named) if not (e.event == "delta" and i and named[i - 1].event == "delta")]


# 契约样例之后在事件中新增的字段（旧客户端忽略即可）：
# improve-agent-from-experiments D7 的评审模型；add-session-context-and-memory 契约 C 的 final.clarification / tmHits
ADDED_FIELDS = {"review": {"reviewer", "fallback"}, "final": {"clarification", "tmHits"}}


def _added(event) -> set[str]:
    added = set(ADDED_FIELDS.get(event.event, set()))
    if event.event == "node" and event.data.get("node") == "retrieve" and event.data.get("status") == "completed":
        added.add("detail")  # retrieve 节点的 detail：{tmHits, sessionTurns}
    return added


def _assert_same_shape(ours, sample):
    assert structure(ours) == structure(sample)
    # 每个事件的字段集合一致（Python 侧 final 不带 recordId）
    for a, b in zip(_collapse(ours), _collapse(sample), strict=True):
        expected = (set(b.data) - {"recordId"}) | _added(a)
        assert set(a.data) == expected, (a.event, a.data, b.data)


async def test_fast_path_matches_sample(app, client, monkeypatch):
    fake = FakeLLM(translations=["早上好"], chunk_size=2)
    use_fake_llm(app, monkeypatch, fake)
    resp, text = await post_stream(client, body())
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    assert resp.headers["cache-control"] == "no-cache"
    assert resp.headers["x-accel-buffering"] == "no"
    assert_single_line_json(text)
    ours = parse_sse(text)
    _assert_same_shape(ours, load_sample_streams()["fast"])
    final = ours[-1]
    assert final.event == "final"
    assert final.data["translation"] == "早上好"
    assert final.data["path"] == "fast" and final.data["domain"] == "通用"
    assert "recordId" not in final.data
    assert ours[0].data["requestId"] == resp.headers["x-trace-id"]


async def test_standard_path_with_one_refine_matches_sample(app, client, monkeypatch, insert_glossary):
    g7 = insert_glossary(terms=[("GPU", "图形处理器"), ("machine learning", "机器学习")])
    g9 = insert_glossary(target_lang="ja", terms=[("GPU", "GPU")])
    issue = {
        "category": "terminology",
        "severity": "major",
        "span": "显卡",
        "suggestion": "术语 GPU 应译为“图形处理器”",
    }
    fake = FakeLLM(
        translations=["机器学习模型\n通常在 显卡上训练。", "机器学习模型\n通常在 图形处理器上训练。"],
        reviews=[review_json(72, [issue]), review_json(93)],
        chunk_size=8,
    )
    use_fake_llm(app, monkeypatch, fake)
    payload = body(text="Machine learning models are usually trained on GPU.", glossaryIds=[g7, g9])
    resp, text = await post_stream(client, payload)
    ours = parse_sse(text)
    _assert_same_shape(ours, load_sample_streams()["standard"])
    terms = next(e.data for e in ours if e.event == "terms")
    assert terms["skippedGlossaries"] == [g9]
    final = ours[-1].data
    assert final["translation"] == "机器学习模型\n通常在 图形处理器上训练。"
    assert final["compliance"] == [
        {"source": "machine learning", "target": "机器学习", "compliant": True},
        {"source": "GPU", "target": "图形处理器", "compliant": True},
    ]
    # delta 中的换行与前导空格经 JSON 往返后完全一致
    deltas = "".join(e.data["text"] for e in ours if e.event == "delta" and e.data["round"] == 1)
    assert deltas == "机器学习模型\n通常在 图形处理器上训练。"


@pytest.mark.parametrize(("review_id", "reviewer", "fallback"), [(3, "gpt-6-luna", False), (404, "fake", True)])
async def test_review_model_config_id_selects_reviewer(app, client, monkeypatch, review_id, reviewer, fallback):
    """reviewModelConfigId：评审发往评审模型；评审模型不可用时退回译者模型并在 review 事件中标注。"""
    from app.core.errors import BizException, ErrorCode
    from tests.fakes import resolved

    translator = FakeLLM(translations=["译文"], reviews=[review_json(90)])
    luna = FakeLLM(reviews=[review_json(90)], model="gpt-6-luna")
    calls = []

    async def _get(model_config_id=None):
        calls.append(model_config_id)
        if model_config_id is None:
            return resolved(translator)
        if model_config_id == 3:
            m = resolved(luna)
            m.config.id, m.config.name = 3, "gpt-6-luna"
            return m
        raise BizException(ErrorCode.MODEL_CONFIG_UNAVAILABLE)

    monkeypatch.setattr(app.state.registry, "get", _get)
    _, text = await post_stream(client, body(mode="standard", reviewModelConfigId=review_id))
    review = next(e.data for e in parse_sse(text) if e.event == "review")
    assert review["reviewer"] == reviewer and review["fallback"] is fallback
    assert calls == [None, review_id]
    assert ("review" in luna.kinds()) is not fallback
    assert ("review" in translator.kinds()) is fallback
    assert parse_sse(text)[-1].event == "final"


async def test_non_ascii_not_escaped(app, client, monkeypatch):
    use_fake_llm(app, monkeypatch, FakeLLM(translations=["早上好"]))
    _, text = await post_stream(client, body())
    assert "早上好" in text and "\\u" not in text


# ---------------- 建立流之前的错误：普通 JSON ----------------


@pytest.mark.parametrize(
    ("payload", "status", "code"),
    [
        (body(targetLang="xx"), 400, "A0420"),
        (body(text=""), 400, "A0410"),
        (body(text="x" * 5001), 400, "A0410"),
        (body(sourceLang="zh", targetLang="zh"), 400, "A0410"),
        (body(mode="slow"), 400, "A0410"),
    ],
)
async def test_validation_errors_before_stream(client, payload, status, code):
    resp = await client.post(URL, json=payload)
    assert resp.status_code == status
    assert resp.headers["content-type"].startswith("application/json")
    assert resp.json()["code"] == code


async def test_no_default_model_c0130(client):
    resp = await client.post(URL, json=body())
    assert resp.status_code == 400
    assert resp.json()["code"] == "C0130"


async def test_requires_internal_token(client):
    resp = await client.post(URL, json=body(), headers={"X-Internal-Token": "wrong"})
    assert resp.status_code == 401
    assert resp.json()["code"] == "B0100"


# ---------------- 流建立之后的错误：error 事件 ----------------


@respx.mock
async def test_llm_auth_failure_c0121(client, insert_config):
    insert_config(is_default=True, api_key="sk-bad-key-should-not-leak")
    respx.post(OAI_URL).mock(return_value=httpx.Response(401, json={"error": {"message": "invalid api key"}}))
    resp, text = await post_stream(client, body(sourceLang="en", mode="fast"))
    assert resp.status_code == 200
    events = parse_sse(text)
    assert events[0].event == "start"
    assert events[-1].event == "error"
    assert events[-1].data["code"] == "C0121"
    assert "sk-bad" not in text
    assert not any(e.event == "final" for e in events)


async def test_unexpected_exception_c0140(app, client, monkeypatch):
    class Boom(FakeLLM):
        async def stream(self, req):
            raise RuntimeError("boom")
            yield  # pragma: no cover

    use_fake_llm(app, monkeypatch, Boom())
    _, text = await post_stream(client, body(sourceLang="en"))
    last = parse_sse(text)[-1]
    assert (last.event, last.data["code"]) == ("error", "C0140")


async def test_total_timeout_c0141(app, client, monkeypatch):
    fake = FakeLLM(translations=["早上好早上好"], chunk_size=1, delay=0.3)
    use_fake_llm(app, monkeypatch, fake)
    override_settings(app, translate_total_timeout_seconds=0.5)
    start = time.perf_counter()
    _, text = await post_stream(client, body(sourceLang="en"))
    assert time.perf_counter() - start < 3
    events = parse_sse(text)
    assert events[-1].event == "error"
    assert events[-1].data["code"] == "C0141"
    assert not any(e.event == "final" for e in events)
    for _ in range(50):  # 超时后 Agent 任务被取消
        if fake.cancelled.is_set():
            break
        await asyncio.sleep(0.05)
    assert fake.cancelled.is_set()


async def test_heartbeat_when_idle(app, client, monkeypatch):
    fake = FakeLLM(translations=["早上好"], chunk_size=3, delay=0.5)
    use_fake_llm(app, monkeypatch, fake)
    override_settings(app, sse_heartbeat_seconds=0.15)
    _, text = await post_stream(client, body(sourceLang="en"))
    assert ": ping\n\n" in text
    events = parse_sse(text)
    assert any(e.comment == "ping" for e in events)
    assert events[-1].event == "final"


# ---------------- 客户端断开：取消图任务与 LLM 调用（真实 HTTP 服务器） ----------------


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def live_server():
    from app.main import create_app

    application = create_app(get_settings())
    port = _free_port()
    server = uvicorn.Server(uvicorn.Config(application, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(
        target=lambda: asyncio.run(server.serve(), loop_factory=asyncio.SelectorEventLoop), daemon=True
    )
    thread.start()
    for _ in range(200):
        if server.started:
            break
        time.sleep(0.05)
    assert server.started
    yield application, f"http://127.0.0.1:{port}"
    server.should_exit = True
    thread.join(timeout=10)


async def test_client_disconnect_cancels_agent(live_server, monkeypatch):
    application, base_url = live_server
    fake = FakeLLM(translations=["早上好" * 50], chunk_size=1, delay=0.2)
    use_fake_llm(application, monkeypatch, fake)
    async with httpx.AsyncClient(base_url=base_url, headers={"X-Internal-Token": INTERNAL_TOKEN}, timeout=10) as c:
        async with c.stream("POST", URL, json=body(sourceLang="en")) as resp:
            assert resp.status_code == 200
            buf = ""
            async for chunk in resp.aiter_text():
                buf += chunk
                if "event: delta" in buf:
                    break  # 收到首个增量后断开
    for _ in range(100):
        if fake.cancelled.is_set():
            break
        await asyncio.sleep(0.05)
    assert fake.cancelled.is_set(), "客户端断开后 LLM 流式调用应被取消"
    assert len(fake.translations) == 0  # 译文只取过一次，未继续执行后续节点
    assert fake.kinds() == ["translate"]
