"""客户端的离线单元测试：SSE 切分、信封解包与令牌续期（用 httpx.MockTransport 模拟平台）。"""

import json

import httpx
import pytest

from eval.client import PlatformClient, PlatformError, parse_sse_lines


def test_parse_sse_handles_optional_space_and_comments():
    lines = ["event:start", 'data:{"a":1}', "", ":ping", "event: final", 'data: {"b":2}', ""]
    assert list(parse_sse_lines(iter(lines))) == [("start", '{"a":1}'), ("final", '{"b":2}')]


def test_parse_sse_multiline_data_and_crlf():
    lines = ["event: delta\r", "data: line1\r", "data: line2\r", "\r"]
    assert list(parse_sse_lines(iter(lines))) == [("delta", "line1\nline2")]


def _client(handler) -> PlatformClient:
    c = PlatformClient(base_url="http://test", username="u", password="p", timeout=5)
    c._http = httpx.Client(base_url="http://test", transport=httpx.MockTransport(handler))
    return c


def _ok(data):
    return httpx.Response(200, json={"code": "00000", "message": "成功", "data": data, "traceId": "t"})


def test_unwrap_error_raises_platform_error():
    def handler(req: httpx.Request):
        if req.url.path == "/api/auth/login":
            return _ok({"accessToken": "a1", "refreshToken": "r1"})
        return httpx.Response(409, json={"code": "A0431", "message": "状态不允许", "data": None, "traceId": "x"})

    with pytest.raises(PlatformError) as ei:
        _client(handler).retry_doc_task(1)
    assert ei.value.code == "A0431" and ei.value.status == 409


def test_expired_token_refreshes_once_then_retries():
    calls = []

    def handler(req: httpx.Request):
        calls.append((req.url.path, req.headers.get("authorization")))
        if req.url.path == "/api/auth/login":
            return _ok({"accessToken": "a1", "refreshToken": "r1"})
        if req.url.path == "/api/auth/refresh":
            assert json.loads(req.content) == {"refreshToken": "r1"}
            return _ok({"accessToken": "a2", "refreshToken": "r2"})
        if req.headers.get("authorization") == "Bearer a1":
            return httpx.Response(401, json={"code": "A0230", "message": "过期", "data": None, "traceId": "x"})
        return _ok({"id": 7, "status": "COMPLETED"})

    task = _client(handler).doc_task(7)
    assert task["status"] == "COMPLETED"
    assert [p for p, _ in calls] == ["/api/auth/login", "/api/doc-tasks/7", "/api/auth/refresh", "/api/doc-tasks/7"]


def test_translate_stream_collects_final_and_ttfe():
    body = 'event:start\ndata:{"requestId":"r"}\n\n:ping\n\nevent:final\ndata:{"translation":"你好","recordId":3}\n\n'

    def handler(req: httpx.Request):
        if req.url.path == "/api/auth/login":
            return _ok({"accessToken": "a1", "refreshToken": "r1"})
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=body.encode())

    res = _client(handler).translate_stream("hello", mode="fast")
    assert res.ok and res.final["translation"] == "你好"
    assert [e for e, _ in res.events] == ["start", "final"]
    assert res.ttfe_ms is not None and res.total_ms is not None


def test_confirm_terms_and_review_model_in_requests():
    seen = []

    def handler(req: httpx.Request):
        if req.url.path == "/api/auth/login":
            return _ok({"accessToken": "a1", "refreshToken": "r1"})
        seen.append((req.url.path, json.loads(req.content) if req.content else None))
        return _ok({"id": 9})

    c = _client(handler)
    c.create_doc_task("text", title="t", review_model_config_id=3)
    c.create_doc_task("text", title="t")
    c.confirm_doc_terms(9, [{"id": 1, "source": "Pod", "target": "Pod", "status": "CONFIRMED"}])
    assert seen[0][1]["reviewModelConfigId"] == 3 and "reviewModelConfigId" not in seen[1][1]
    assert seen[2] == ("/api/doc-tasks/9/terms/confirm",
                       {"terms": [{"id": 1, "source": "Pod", "target": "Pod", "status": "CONFIRMED"}]})


def test_wait_doc_task_stops_at_until_status():
    def handler(req: httpx.Request):
        if req.url.path == "/api/auth/login":
            return _ok({"accessToken": "a1", "refreshToken": "r1"})
        return _ok({"id": 5, "status": "AWAITING_CONFIRM"})

    task = _client(handler).wait_doc_task(5, timeout=5, poll=0.01, until={"AWAITING_CONFIRM"})
    assert task["status"] == "AWAITING_CONFIRM"


def test_clarify_stream_and_session_id():
    clarify = '{"threadId":"turn:r","question":"q","options":["a","b"],"span":"bank"}'
    body = f'event:start\ndata:{{"requestId":"r"}}\n\nevent:clarify\ndata:{clarify}\n\n'
    seen = []

    def handler(req: httpx.Request):
        if req.url.path == "/api/auth/login":
            return _ok({"accessToken": "a1", "refreshToken": "r1"})
        seen.append((req.url.path, json.loads(req.content)))
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=body.encode())

    c = _client(handler)
    res = c.translate_stream("Send it to the bank.", session_id=9)
    assert not res.ok and res.clarify["threadId"] == "turn:r"
    assert seen[0][1]["sessionId"] == 9
    c.clarify_stream(9, "turn:r", "银行")
    assert seen[1] == ("/api/translate/sessions/9/clarify", {"threadId": "turn:r", "answer": "银行"})


def test_tm_clear_deletes_until_empty():
    pages = [[{"id": 1}, {"id": 2}], [{"id": 3}], []]
    deleted = []

    def handler(req: httpx.Request):
        if req.url.path == "/api/auth/login":
            return _ok({"accessToken": "a1", "refreshToken": "r1"})
        if req.method == "DELETE":
            deleted.append(int(req.url.path.rsplit("/", 1)[1]))
            return _ok(None)
        return _ok({"records": pages.pop(0), "total": 3})

    assert _client(handler).tm_clear() == 3 and deleted == [1, 2, 3]
