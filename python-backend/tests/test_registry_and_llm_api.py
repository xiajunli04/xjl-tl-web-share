import httpx
import pytest
import respx

from app.core.errors import BizException
from app.llm.anthropic_client import AnthropicClient
from app.llm.openai_compat import OpenAICompatibleClient
from tests.test_llm_clients import OAI_URL, oai_completion

pytestmark = pytest.mark.usefixtures("db_admin")


# ---------------- registry ----------------


async def test_registry_get_by_id(app, insert_config):
    cid = insert_config(provider="ANTHROPIC", base_url="https://anthropic.test", model_name="claude-test")
    resolved = await app.state.registry.get(cid)
    assert resolved.config.id == cid
    assert isinstance(resolved.client, AnthropicClient)
    assert resolved.client.model == "claude-test"


async def test_registry_default_model(app, insert_config):
    insert_config(model_name="other")
    did = insert_config(model_name="deepseek-chat", is_default=True)
    resolved = await app.state.registry.get(None)
    assert resolved.config.id == did
    assert isinstance(resolved.client, OpenAICompatibleClient)


async def test_registry_cache_hit_and_invalidate_on_update(app, insert_config, db_admin):
    cid = insert_config()
    first = await app.state.registry.get(cid)
    second = await app.state.registry.get(cid)
    assert first.client is second.client
    db_admin.execute("update biz.model_config set updated_at = now() + interval '1 second' where id = %s", (cid,))
    third = await app.state.registry.get(cid)
    assert third.client is not first.client


@pytest.mark.parametrize("case", ["missing", "disabled", "deleted", "no_default"])
async def test_registry_config_unavailable(app, insert_config, case):
    if case == "missing":
        target = 9999
    elif case == "disabled":
        target = insert_config(enabled=False)
    elif case == "deleted":
        target = insert_config(deleted=True)
    else:
        insert_config(is_default=False)
        target = None
    with pytest.raises(BizException) as ei:
        await app.state.registry.get(target)
    assert ei.value.error.code == "C0130"


async def test_registry_default_ignores_other_capabilities(app, insert_config):
    """add-speech-and-image-translation 3.1：默认模型按能力唯一，对话默认不会取到 TTS 默认配置。"""
    insert_config(model_name="tts-1", is_default=True, capability="TTS")
    with pytest.raises(BizException):
        await app.state.registry.get(None)
    chat = insert_config(model_name="deepseek-chat", is_default=True)
    assert (await app.state.registry.get(None)).config.id == chat


async def test_registry_rejects_non_chat_config_by_id(app, insert_config):
    tts = insert_config(model_name="tts-1", capability="TTS")
    with pytest.raises(BizException) as ei:
        await app.state.registry.get(tts)
    assert ei.value.error.code == "C0130"


async def test_config_with_key_by_capability(app, insert_config):
    qwen = insert_config(
        provider="DASHSCOPE",
        base_url="wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
        model_name="qwen3.8-livetranslate-flash-realtime",
        api_key="sk-dashscope-123456",
        params={"extra": {"voice": "Tina"}},
        is_default=True,
        capability="REALTIME_TRANSLATE",
    )
    cfg, key = await app.state.registry.config_with_key("REALTIME_TRANSLATE")
    assert cfg.id == qwen and key == "sk-dashscope-123456"
    assert cfg.extra == {"voice": "Tina"}
    with pytest.raises(BizException):
        await app.state.registry.config_with_key("TTS", qwen)  # 能力不符
    repo = app.state.registry._repo
    assert [c.id for c in await repo.find_enabled("REALTIME_TRANSLATE")] == [qwen]


# ---------------- /internal/llm/test ----------------


@respx.mock
async def test_llm_test_success(client, insert_config):
    cid = insert_config()
    respx.post(OAI_URL).mock(return_value=httpx.Response(200, json=oai_completion("pong")))
    resp = await client.post("/internal/llm/test", json={"modelConfigId": cid})
    assert resp.status_code == 200
    body = resp.json()
    assert body["code"] == "00000"
    data = body["data"]
    assert data["ok"] is True
    assert data["model"] == "deepseek-chat"
    assert data["reply"] == "pong"
    assert data["usage"] == {"promptTokens": 9, "completionTokens": 2}
    assert isinstance(data["latencyMs"], int)
    assert "errorCode" not in data


@respx.mock
async def test_llm_test_bad_key_returns_ok_false_c0121(client, insert_config):
    cid = insert_config(api_key="sk-bad-key-should-not-leak")
    respx.post(OAI_URL).mock(
        return_value=httpx.Response(
            401, json={"error": {"message": "Incorrect API key provided: sk-bad-key-should-not-leak"}}
        )
    )
    resp = await client.post("/internal/llm/test", json={"modelConfigId": cid})
    assert resp.status_code == 200
    body = resp.json()
    assert body["code"] == "00000"
    assert body["data"]["ok"] is False
    assert body["data"]["errorCode"] == "C0121"
    assert body["data"]["errorMessage"]
    assert "sk-bad-key" not in resp.text


@respx.mock
async def test_llm_test_timeout_returns_c0122(client, insert_config):
    cid = insert_config()
    respx.post(OAI_URL).mock(side_effect=httpx.ReadTimeout("timed out"))
    resp = await client.post("/internal/llm/test", json={"modelConfigId": cid})
    assert resp.json()["data"]["errorCode"] == "C0122"


async def test_llm_test_missing_config_returns_c0130(client):
    resp = await client.post("/internal/llm/test", json={"modelConfigId": 9999})
    assert resp.status_code == 400
    body = resp.json()
    assert body["code"] == "C0130"
    assert body["message"] == "模型配置不存在或已停用"


async def test_llm_test_disabled_config_returns_c0130(client, insert_config):
    cid = insert_config(enabled=False)
    resp = await client.post("/internal/llm/test", json={"modelConfigId": cid})
    assert resp.status_code == 400
    assert resp.json()["code"] == "C0130"
