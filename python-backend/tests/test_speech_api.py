"""语音内部接口与能力连通性测试（tasks 3.5，契约 §1.1–§1.4）。"""

import base64
import sys
import types

import httpx
import pytest
import respx

from app.speech import engines as engines_mod
from app.speech.tts import tts_cache
from tests.speech_fakes import MODELS_READY, SAMPLE_ZH, make_wav

pytestmark = pytest.mark.usefixtures("db_admin")


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    """不访问真实 Edge 服务；每个用例重新探测、清空 TTS 缓存。"""

    async def _edge_ok():
        return True, None

    monkeypatch.setattr(engines_mod, "probe_edge_tts", _edge_ok)
    engines_mod.reset_probe_cache()
    tts_cache.clear()
    yield
    engines_mod.reset_probe_cache()


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def _by_id(items):
    return {e["id"]: e for e in items}


# ---------------- 引擎清单 ----------------


async def test_engines_without_configs(client):
    resp = await client.get("/internal/speech/engines")
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert set(data) == {"asr", "tts", "interpret", "image", "chat"}
    asr, tts, interpret, image = (_by_id(data[k]) for k in ("asr", "tts", "interpret", "image"))
    assert set(asr) == {"local-sensevoice", "openai-transcribe"}
    assert asr["openai-transcribe"]["available"] is False and asr["openai-transcribe"]["kind"] == "config"
    assert "ASR" in asr["openai-transcribe"]["reason"]
    assert tts["edge-tts"]["available"] is True and tts["browser"]["available"] is True
    assert tts["openai-speech"]["available"] is False
    assert set(interpret) == {"cascade", "qwen-livetranslate", "openai-realtime", "gemini-live-translate", "doubao-ast"}
    for eid, key in (("openai-realtime", "OpenAI"), ("gemini-live-translate", "Gemini"), ("doubao-ast", "豆包")):
        item = interpret[eid]
        assert item["available"] is False and item["kind"] == "config" and key in item["reason"]  # 需配置
        assert item["s2s"] is True and item["maxTargets"] == 3 and item["autoConverse"] is False
    assert interpret["cascade"]["available"] is False  # 没有对话模型
    assert interpret["cascade"]["autoConverse"] is True and interpret["cascade"]["maxTargets"] == 5
    qwen = interpret["qwen-livetranslate"]
    assert qwen["available"] is False and qwen["s2s"] is True and qwen["maxTargets"] == 3
    assert qwen["autoConverse"] is False and qwen["modelConfigId"] is None
    assert image["vision"]["available"] is False and image["qwen-mt-image"]["available"] is False
    chat = _by_id(data["chat"])
    assert set(chat) == {"cascade", "realtime-chat"}
    assert chat["cascade"]["available"] is False  # 与级联同传一致：没有对话模型
    assert chat["realtime-chat"]["available"] is False and "未配置实时语音对话模型" in chat["realtime-chat"]["reason"]
    assert "provider" not in chat["realtime-chat"]
    for item in data["asr"] + data["tts"] + data["interpret"] + data["image"]:
        assert set(item) >= {
            "id",
            "type",
            "name",
            "vendor",
            "kind",
            "available",
            "reason",
            "languages",
            "modelConfigId",
        }
        assert (item["reason"] is None) == item["available"]


async def test_engines_local_model_missing(client, monkeypatch):
    monkeypatch.setattr(
        engines_mod.LocalSenseVoiceASR, "availability", staticmethod(lambda: (False, "本地识别模型未下载"))
    )
    data = (await client.get("/internal/speech/engines?refresh=true")).json()["data"]
    local = _by_id(data["asr"])["local-sensevoice"]
    assert local["available"] is False and local["reason"] == "本地识别模型未下载"
    assert _by_id(data["tts"])["edge-tts"]["available"] is True


async def test_engines_with_configs(client, insert_config):
    chat = insert_config(model_name="gpt-5.6-luna", is_default=True, supports_vision=True)
    asr = insert_config(model_name="whisper-1", capability="ASR")
    qwen = insert_config(
        provider="DASHSCOPE",
        base_url="wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
        model_name="qwen3.8-livetranslate-flash-realtime",
        capability="REALTIME_TRANSLATE",
    )
    img = insert_config(provider="DASHSCOPE", model_name="qwen-mt-image-2.0", capability="IMAGE_TRANSLATE")
    insert_config(model_name="tts-1", capability="TTS", enabled=False)
    openai_rt = insert_config(
        base_url="https://api.openai.com/v1", model_name="gpt-realtime-translate", capability="REALTIME_TRANSLATE"
    )
    gemini = insert_config(
        provider="GOOGLE", base_url="", model_name="gemini-3.5-live-translate-preview", capability="REALTIME_TRANSLATE"
    )
    doubao = insert_config(
        provider="VOLCENGINE", base_url="", model_name="doubao-ast-2.0", capability="REALTIME_TRANSLATE"
    )
    data = (await client.get("/internal/speech/engines")).json()["data"]
    interpret = _by_id(data["interpret"])
    for eid, cid, langs in (
        ("openai-realtime", openai_rt, 12),
        ("gemini-live-translate", gemini, 15),
        ("doubao-ast", doubao, 8),
    ):
        assert interpret[eid]["available"] is True and interpret[eid]["reason"] is None
        assert interpret[eid]["modelConfigId"] == cid and len(interpret[eid]["languages"]) == langs
    assert "ar" not in interpret["openai-realtime"]["languages"]
    assert "中文/英文" in interpret["doubao-ast"]["constraint"]
    assert interpret["qwen-livetranslate"]["available"] is True
    assert interpret["qwen-livetranslate"]["modelConfigId"] == qwen
    assert interpret["cascade"]["modelConfigId"] == chat
    assert _by_id(data["asr"])["openai-transcribe"]["modelConfigId"] == asr
    assert len(interpret["cascade"]["languages"]) == 15  # 配置了远程转写后不受本地 4 语种限制
    assert _by_id(data["tts"])["openai-speech"]["available"] is False  # 停用的配置不算
    image = _by_id(data["image"])
    assert image["vision"]["available"] is True and image["vision"]["modelConfigId"] == chat
    assert image["qwen-mt-image"]["available"] is True and image["qwen-mt-image"]["modelConfigId"] == img
    chat_engines = _by_id(data["chat"])
    assert chat_engines["cascade"]["available"] is True and chat_engines["cascade"]["modelConfigId"] == chat
    assert chat_engines["realtime-chat"]["available"] is False  # 只配置了实时同传，没有实时语音对话


@pytest.mark.parametrize(("provider", "tested"), [("DASHSCOPE", True), ("OPENAI_COMPATIBLE", False)])
async def test_engines_realtime_chat_configured(client, insert_config, provider, tested):
    cid = insert_config(
        provider=provider,
        base_url="wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
        model_name="qwen3-omni-flash-realtime",
        capability="REALTIME_CHAT",
    )
    insert_config(provider="VOLCENGINE", base_url="", model_name="x", capability="REALTIME_CHAT")  # 不支持的提供方
    data = (await client.get("/internal/speech/engines")).json()["data"]
    rc = _by_id(data["chat"])["realtime-chat"]
    assert rc["available"] is True and rc["reason"] is None and rc["modelConfigId"] == cid
    assert rc["provider"] == provider and rc["tested"] is tested


async def test_engines_probe_is_cached(client, monkeypatch):
    calls = []

    async def _edge():
        calls.append(1)
        return False, "Edge 在线语音不可达"

    monkeypatch.setattr(engines_mod, "probe_edge_tts", _edge)
    first = (await client.get("/internal/speech/engines")).json()["data"]
    await client.get("/internal/speech/engines")
    assert len(calls) == 1
    assert _by_id(first["tts"])["edge-tts"]["reason"] == "Edge 在线语音不可达"
    await client.get("/internal/speech/engines?refresh=true")
    assert len(calls) == 2


async def test_speech_requires_internal_token(client):
    resp = await client.get("/internal/speech/engines", headers={"X-Internal-Token": "wrong"})
    assert resp.status_code == 401 and resp.json()["code"] == "B0100"


# ---------------- 听写 ----------------


@pytest.mark.parametrize(
    ("audio", "fragment"),
    [("@@@", "base64"), (_b64(b"hello"), "格式不支持"), (_b64(make_wav(75, rate=8000)), "超过上限 60 秒")],
    ids=["bad-base64", "not-wav", "too-long"],
)
async def test_transcribe_invalid_audio(client, audio, fragment):
    resp = await client.post("/internal/speech/transcribe", json={"audioBase64": audio, "engine": "local-sensevoice"})
    assert resp.status_code == 400
    body = resp.json()
    assert body["code"] == "A0454" and fragment in body["message"]


async def test_transcribe_local_model_missing(client, monkeypatch):
    monkeypatch.setattr(
        engines_mod.LocalSenseVoiceASR, "availability", staticmethod(lambda: (False, "本地识别模型未下载"))
    )
    resp = await client.post("/internal/speech/transcribe", json={"audioBase64": _b64(make_wav(1))})
    assert resp.status_code == 503 and resp.json()["code"] == "C0173"


async def test_transcribe_remote_not_configured(client):
    resp = await client.post(
        "/internal/speech/transcribe", json={"audioBase64": _b64(make_wav(1)), "engine": "openai-transcribe"}
    )
    assert resp.status_code == 503 and resp.json()["code"] == "C0173"


@pytest.mark.skipif(not MODELS_READY, reason="本地语音模型未下载")
async def test_transcribe_local_chinese(client):
    resp = await client.post("/internal/speech/transcribe", json={"audioBase64": _b64(SAMPLE_ZH.read_bytes())})
    data = resp.json()["data"]
    assert resp.status_code == 200
    assert "你好" in data["text"] and data["lang"] == "zh" and data["engine"] == "local-sensevoice"
    assert 900 < data["durationMs"] < 1500


@respx.mock
async def test_transcribe_defaults_to_remote_when_configured(client, insert_config):
    insert_config(model_name="whisper-1", capability="ASR", base_url="https://asr.test/v1")
    respx.post("https://asr.test/v1/audio/transcriptions").mock(
        return_value=httpx.Response(200, json={"text": "你好世界", "language": "zh"})
    )
    resp = await client.post("/internal/speech/transcribe", json={"audioBase64": _b64(SAMPLE_ZH.read_bytes())})
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"] == {"text": "你好世界", "lang": "zh", "durationMs": 1055, "engine": "openai-transcribe"}


# ---------------- 朗读 ----------------


@pytest.fixture
def fake_edge(monkeypatch):
    import edge_tts

    state = {"error": None, "voices": [], "rates": [], "fail_after_first": False}

    class _Comm:
        def __init__(self, text, voice, **kwargs):
            state["voices"].append(voice)
            state["rates"].append(kwargs.get("rate"))

        async def stream(self):
            if state["error"]:
                raise state["error"]
            yield {"type": "audio", "data": b"ID3" + b"\x00" * 100}
            if state["fail_after_first"]:
                raise RuntimeError("connection reset")
            yield {"type": "audio", "data": b"\xff" * 50}

    monkeypatch.setattr(edge_tts, "Communicate", _Comm)
    return state


async def test_tts_edge_binary(client, fake_edge):
    resp = await client.post("/internal/speech/tts", json={"text": "Hello", "lang": "en", "gender": "male"})
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "audio/mpeg"
    assert resp.headers["x-tts-engine"] == "edge-tts"
    assert resp.headers["x-tts-voice"] == "en-US-AndrewMultilingualNeural"
    assert resp.content.startswith(b"ID3") and len(resp.content) == 153
    assert resp.headers["x-tts-cache"] == "miss"


async def test_tts_cache_hit_and_rate(client, fake_edge):
    body = {"text": "Hello", "lang": "en", "rate": 1.2}
    first = await client.post("/internal/speech/tts", json=body)
    second = await client.post("/internal/speech/tts", json=body)
    assert first.headers["x-tts-cache"] == "miss" and second.headers["x-tts-cache"] == "hit"
    assert second.content == first.content and fake_edge["rates"] == ["+20%"]  # 命中缓存不再合成
    third = await client.post("/internal/speech/tts", json={**body, "rate": 1.0})
    assert third.headers["x-tts-cache"] == "miss"  # 语速不同不命中


@pytest.mark.parametrize("rate", [0.4, 2.5])
async def test_tts_rate_out_of_range(client, fake_edge, rate):
    resp = await client.post("/internal/speech/tts", json={"text": "Hello", "lang": "en", "rate": rate})
    assert resp.status_code == 400 and resp.json()["code"] == "A0410"


async def test_tts_mid_stream_failure_truncates(client, fake_edge):
    fake_edge["fail_after_first"] = True
    resp = await client.post("/internal/speech/tts", json={"text": "Hello", "lang": "en"})
    assert resp.status_code == 200 and resp.content == b"ID3" + b"\x00" * 100  # 首包后中断：只返回已合成部分
    again = await client.post("/internal/speech/tts", json={"text": "Hello", "lang": "en"})
    assert again.headers["x-tts-cache"] == "miss"  # 不完整的音频不入缓存


async def test_tts_detects_language_when_missing(client, fake_edge):
    resp = await client.post("/internal/speech/tts", json={"text": "今天天气很好，我们出去散步吧"})
    assert resp.status_code == 200 and resp.headers["x-tts-voice"] == "zh-CN-XiaoxiaoNeural"


async def test_tts_failure_returns_c0172(client, fake_edge):
    fake_edge["error"] = RuntimeError("403 Forbidden")
    resp = await client.post("/internal/speech/tts", json={"text": "Hello", "lang": "en"})
    assert resp.status_code == 502 and resp.json()["code"] == "C0172"


@pytest.mark.parametrize(
    ("body", "code", "status"),
    [
        ({"text": "  ", "lang": "en"}, "A0410", 400),
        ({"text": "x" * 2001, "lang": "en"}, "A0410", 400),
        ({"text": "hi", "lang": "en", "engine": "browser"}, "A0410", 400),
        ({"text": "hi", "lang": "en", "engine": "openai-speech"}, "C0173", 503),
    ],
)
async def test_tts_rejects(client, body, code, status):
    resp = await client.post("/internal/speech/tts", json=body)
    assert resp.status_code == status and resp.json()["code"] == code


@respx.mock
async def test_tts_openai_speech_pcm(client, insert_config):
    insert_config(model_name="tts-1", capability="TTS", base_url="https://tts.test/v1", is_default=True)
    respx.post("https://tts.test/v1/audio/speech").mock(return_value=httpx.Response(200, content=b"\x01\x02" * 500))
    resp = await client.post("/internal/speech/tts", json={"text": "你好", "lang": "zh"})
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "audio/L16;rate=24000"
    assert resp.headers["x-tts-engine"] == "openai-speech" and resp.headers["x-tts-voice"] == "nova"
    assert len(resp.content) == 1000


# ---------------- 连通性测试按能力分支 ----------------


@respx.mock
async def test_model_test_asr(client, insert_config):
    cid = insert_config(model_name="whisper-1", capability="ASR", base_url="https://asr.test/v1")
    route = respx.post("https://asr.test/v1/audio/transcriptions").mock(
        return_value=httpx.Response(200, json={"text": "你好，世界。", "language": "zh"})
    )
    data = (await client.post("/internal/llm/test", json={"modelConfigId": cid})).json()["data"]
    assert data["ok"] is True and data["reply"] == "你好，世界。" and data["model"] == "whisper-1"
    assert b"RIFF" in route.calls.last.request.content


@respx.mock
async def test_model_test_tts(client, insert_config):
    cid = insert_config(model_name="tts-1", capability="TTS", base_url="https://tts.test/v1")
    respx.post("https://tts.test/v1/audio/speech").mock(return_value=httpx.Response(200, content=b"\x00" * 12346))
    data = (await client.post("/internal/llm/test", json={"modelConfigId": cid})).json()["data"]
    assert data["ok"] is True and data["reply"] == "音频 12346 字节"


@respx.mock
async def test_model_test_tts_rate_limited(client, insert_config):
    cid = insert_config(model_name="tts-1", capability="TTS", base_url="https://tts.test/v1")
    respx.post("https://tts.test/v1/audio/speech").mock(return_value=httpx.Response(429))
    data = (await client.post("/internal/llm/test", json={"modelConfigId": cid})).json()["data"]
    assert data["ok"] is False and data["errorCode"] == "C0123" and "429" in data["errorMessage"]


async def test_model_test_realtime(client, insert_config, monkeypatch):
    from app.interpret import qwen_livetranslate

    seen = {}

    async def _probe(cfg, api_key):
        seen.update(model=cfg.model_name, key=api_key)
        return "会话已建立"

    monkeypatch.setattr(qwen_livetranslate, "probe", _probe)
    cid = insert_config(
        provider="DASHSCOPE",
        model_name="qwen3.8-livetranslate-flash-realtime",
        capability="REALTIME_TRANSLATE",
        api_key="sk-dashscope-xyz",
    )
    data = (await client.post("/internal/llm/test", json={"modelConfigId": cid})).json()["data"]
    assert data["ok"] is True and data["reply"] == "会话已建立"
    assert seen == {"model": "qwen3.8-livetranslate-flash-realtime", "key": "sk-dashscope-xyz"}


@pytest.mark.parametrize(
    ("provider", "module_name"),
    [
        ("OPENAI_COMPATIBLE", "openai_realtime"),
        ("GOOGLE", "gemini_live_translate"),
        ("VOLCENGINE", "doubao_ast"),
    ],
)
async def test_model_test_realtime_dispatches_by_provider(client, insert_config, monkeypatch, provider, module_name):
    import importlib

    module = importlib.import_module(f"app.interpret.{module_name}")
    seen = {}

    async def _probe(cfg, api_key):
        seen.update(provider=cfg.provider, key=api_key)
        return "会话已建立"

    monkeypatch.setattr(module, "probe", _probe)
    cid = insert_config(provider=provider, model_name="rt-model", capability="REALTIME_TRANSLATE", api_key="sk-rt")
    data = (await client.post("/internal/llm/test", json={"modelConfigId": cid})).json()["data"]
    assert data["ok"] is True and data["reply"] == "会话已建立"
    assert seen == {"provider": provider, "key": "sk-rt"}


async def test_model_test_realtime_fake_key_is_classified(client, insert_config):
    """假密钥：上游握手返回 401 → 归类为 C0121（OpenAI 实时翻译，经本地模拟服务）。"""
    from websockets.asyncio.server import serve

    def _reject(connection, request):
        return connection.respond(401, "invalid api key")

    async def _never(ws):  # pragma: no cover - 握手阶段已被拒绝
        await ws.close()

    async with serve(_never, "127.0.0.1", 0, process_request=_reject) as server:
        port = server.sockets[0].getsockname()[1]
        cid = insert_config(
            base_url=f"http://127.0.0.1:{port}/v1",
            model_name="gpt-realtime-translate",
            capability="REALTIME_TRANSLATE",
            api_key="sk-fake",
        )
        data = (await client.post("/internal/llm/test", json={"modelConfigId": cid})).json()["data"]
    assert data["ok"] is False and data["errorCode"] == "C0121" and "401" in data["errorMessage"]


async def test_model_test_realtime_upstream_failure(client, insert_config, monkeypatch):
    from app.core.errors import ErrorCode
    from app.interpret import qwen_livetranslate
    from app.interpret.engine import EngineError

    async def _probe(cfg, api_key):
        raise EngineError(ErrorCode.REALTIME_UPSTREAM_FAILED, "百炼同传会话配置失败：Voice 'Chelsie' is not supported")

    monkeypatch.setattr(qwen_livetranslate, "probe", _probe)
    cid = insert_config(
        provider="DASHSCOPE", model_name="qwen3.8-livetranslate-flash-realtime", capability="REALTIME_TRANSLATE"
    )
    data = (await client.post("/internal/llm/test", json={"modelConfigId": cid})).json()["data"]
    assert data["ok"] is False and data["errorCode"] == "C0174" and "Chelsie" in data["errorMessage"]


async def test_model_test_image_not_implemented(client, insert_config, monkeypatch):
    monkeypatch.setitem(sys.modules, "app.image.qwen_mt_image", None)  # 导入时抛 ImportError
    cid = insert_config(provider="DASHSCOPE", model_name="qwen-mt-image-2.0", capability="IMAGE_TRANSLATE")
    data = (await client.post("/internal/llm/test", json={"modelConfigId": cid})).json()["data"]
    assert data["ok"] is False and data["errorMessage"] == "图片翻译引擎未实现"


async def test_model_test_image_probe(client, insert_config, monkeypatch):
    from app.core.errors import BizException, ErrorCode

    module = types.ModuleType("app.image.qwen_mt_image")
    calls = []

    async def probe(cfg, api_key):
        calls.append(api_key)
        if len(calls) > 1:
            raise BizException(ErrorCode.LLM_AUTH_FAILED, "百炼鉴权失败")
        return "结果图 64×32"

    module.probe = probe
    monkeypatch.setitem(sys.modules, "app.image.qwen_mt_image", module)
    cid = insert_config(provider="DASHSCOPE", model_name="qwen-mt-image-2.0", capability="IMAGE_TRANSLATE")
    data = (await client.post("/internal/llm/test", json={"modelConfigId": cid})).json()["data"]
    assert data["ok"] is True and data["reply"] == "结果图 64×32"
    data = (await client.post("/internal/llm/test", json={"modelConfigId": cid})).json()["data"]
    assert data == {**data, "ok": False, "errorCode": "C0121", "errorMessage": "百炼鉴权失败"}


async def test_model_test_unknown_config(client):
    resp = await client.post("/internal/llm/test", json={"modelConfigId": 9999})
    assert resp.status_code == 400 and resp.json()["code"] == "C0130"
