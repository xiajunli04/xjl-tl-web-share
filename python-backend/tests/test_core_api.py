import httpx

from app.core.config import get_settings
from app.core.db import Database
from app.main import create_app


async def test_missing_internal_token_returns_b0100(client):
    resp = await client.post("/internal/llm/test", json={"modelConfigId": 1}, headers={"X-Internal-Token": ""})
    assert resp.status_code == 401
    assert resp.json()["code"] == "B0100"


async def test_no_token_header_at_all_returns_b0100(app):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.get("/internal/health")
    assert resp.status_code == 401
    assert resp.json()["code"] == "B0100"


async def test_wrong_internal_token_returns_b0100(client):
    resp = await client.get("/internal/health", headers={"X-Internal-Token": "wrong"})
    assert resp.status_code == 401
    assert resp.json()["code"] == "B0100"


async def test_health_ok_with_db_up_and_trace_id_echo(client):
    resp = await client.get("/internal/health", headers={"X-Trace-Id": "trace-abc"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["code"] == "00000"
    assert body["data"] == {"status": "UP", "version": "0.1.0", "db": "UP"}
    assert body["traceId"] == "trace-abc"
    assert resp.headers["X-Trace-Id"] == "trace-abc"


async def test_trace_id_generated_when_absent(client):
    resp = await client.get("/internal/health")
    tid = resp.headers["X-Trace-Id"]
    assert tid and resp.json()["traceId"] == tid


async def test_health_db_down_still_up():
    settings = get_settings()
    bad_db = Database(settings, conninfo="host=127.0.0.1 port=1 dbname=x user=x password=x connect_timeout=1")
    application = create_app(settings, db=bad_db)
    async with application.router.lifespan_context(application):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application),
            base_url="http://test",
            headers={"X-Internal-Token": settings.internal_token},
        ) as c:
            resp = await c.get("/internal/health")
    body = resp.json()
    assert resp.status_code == 200
    assert body["code"] == "00000"
    assert body["data"]["status"] == "UP"
    assert body["data"]["db"] == "DOWN"


async def test_unexpected_exception_returns_b0001_without_stack(app, client):
    @app.get("/internal/_boom")
    async def boom():
        raise RuntimeError("secret-internal-detail")

    resp = await client.get("/internal/_boom", headers={"X-Trace-Id": "t-boom"})
    assert resp.status_code == 500
    body = resp.json()
    assert body["code"] == "B0001"
    assert body["traceId"] == "t-boom"
    assert "secret-internal-detail" not in resp.text
    assert "Traceback" not in resp.text


async def test_validation_error_returns_a0410(client):
    resp = await client.post("/internal/llm/test", json={"modelConfigId": "abc"})
    assert resp.status_code == 400
    assert resp.json()["code"] == "A0410"
