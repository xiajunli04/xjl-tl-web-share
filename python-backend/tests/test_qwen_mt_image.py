"""4.3：百炼 qwen-mt-image 同步调用（请求体、下载译图、错误归类、data URL 被拒、连通性测试）。"""

import io
import json
from datetime import UTC, datetime

import httpx
import pytest
import respx
from PIL import Image

from app.core.errors import BizException, ErrorCode
from app.image.qwen_mt_image import DATA_URL_REJECTED, endpoint, probe, probe_image, translate_image
from app.repositories.model_config import ModelConfig

QWEN_URL = "https://dashscope.aliyuncs.com/api/v1/services/aigc/image2image/image-synthesis"
RESULT_URL = "http://dashscope-result.oss.test/out.png"


def cfg(base_url: str = "https://dashscope.aliyuncs.com", model: str = "qwen-mt-image-2.0") -> ModelConfig:
    return ModelConfig(
        id=9,
        name="qwen-mt-image",
        provider="DASHSCOPE",
        base_url=base_url,
        model_name=model,
        api_key_cipher="",
        is_default=True,
        enabled=True,
        updated_at=datetime.now(UTC),
        params={},
        capability="IMAGE_TRANSLATE",
    )


def _image(fmt: str, size=(64, 32)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, (255, 255, 255)).save(buf, fmt)
    return buf.getvalue()


@pytest.mark.parametrize(
    "base_url,expected",
    [
        ("https://dashscope.aliyuncs.com", QWEN_URL),
        ("https://dashscope.aliyuncs.com/api/v1", QWEN_URL),
        ("wss://dashscope.aliyuncs.com/api-ws/v1/realtime", QWEN_URL),  # 非 http 地址回落到默认主机
        ("", QWEN_URL),
        ("https://dashscope-intl.aliyuncs.com/", QWEN_URL.replace("dashscope.", "dashscope-intl.")),
    ],
)
def test_endpoint(base_url, expected):
    assert endpoint(cfg(base_url)) == expected


@respx.mock
async def test_translate_image_success_converts_png_to_jpeg():
    route = respx.post(QWEN_URL).mock(
        return_value=httpx.Response(
            200, json={"output": {"image_url": RESULT_URL}, "usage": {"image_count": 1}, "request_id": "r-1"}
        )
    )
    respx.get(RESULT_URL).mock(return_value=httpx.Response(200, content=_image("PNG", (120, 60))))
    result = await translate_image(
        cfg(), "sk-dash", _image("JPEG"), "image/jpeg", "auto", "zh", terms=[("宫保鸡丁", "Kung Pao Chicken")]
    )
    assert (result.width, result.height, result.request_id) == (120, 60, "r-1")
    assert Image.open(io.BytesIO(result.image)).format == "JPEG"
    req = route.calls[0].request
    assert req.headers["authorization"] == "Bearer sk-dash"
    assert "x-dashscope-async" not in req.headers
    sent = json.loads(req.content)
    assert sent["model"] == "qwen-mt-image-2.0"
    assert sent["input"]["source_lang"] == "auto" and sent["input"]["target_lang"] == "zh"
    assert sent["input"]["image_url"].startswith("data:image/jpeg;base64,")
    assert sent["ext"] == {"terminologies": [{"src": "宫保鸡丁", "tgt": "Kung Pao Chicken"}]}


@pytest.mark.parametrize(
    "status,payload,code,message",
    [
        (401, {"code": "InvalidApiKey", "message": "Invalid API-key provided."}, ErrorCode.LLM_AUTH_FAILED, None),
        (429, {"code": "Throttling.RateQuota", "message": "rate"}, ErrorCode.LLM_RATE_LIMITED, None),
        (
            400,
            {"code": "InvalidParameter", "message": "The image_url is invalid, download failed"},
            ErrorCode.LLM_CALL_FAILED,
            DATA_URL_REJECTED,
        ),
        (
            400,
            {"code": "InvalidParameter", "message": "source_lang and target_lang must differ"},
            ErrorCode.LLM_CALL_FAILED,
            "百炼图片翻译失败（InvalidParameter：source_lang and target_lang must differ）",
        ),
        (500, {}, ErrorCode.LLM_CALL_FAILED, "百炼图片翻译失败（HTTP 500）"),
    ],
)
@respx.mock
async def test_translate_image_errors(status, payload, code, message):
    respx.post(QWEN_URL).mock(return_value=httpx.Response(status, json=payload))
    with pytest.raises(BizException) as ei:
        await translate_image(cfg(), "sk-dash", _image("JPEG"), "image/jpeg", "en", "zh")
    assert ei.value.error == code
    if message:
        assert ei.value.message == message
    assert "sk-dash" not in ei.value.message


@respx.mock
async def test_translate_image_missing_url_and_download_failure():
    respx.post(QWEN_URL).mock(return_value=httpx.Response(200, json={"output": {}}))
    with pytest.raises(BizException) as ei:
        await translate_image(cfg(), "k", _image("JPEG"), "image/jpeg", "en", "zh")
    assert ei.value.message == "百炼图片翻译未返回译图地址"

    respx.post(QWEN_URL).mock(return_value=httpx.Response(200, json={"output": {"image_url": RESULT_URL}}))
    respx.get(RESULT_URL).mock(return_value=httpx.Response(403))
    with pytest.raises(BizException) as ei:
        await translate_image(cfg(), "k", _image("JPEG"), "image/jpeg", "en", "zh")
    assert ei.value.message == "下载译图失败（HTTP 403）"


@respx.mock
async def test_translate_image_timeout_and_network_error():
    respx.post(QWEN_URL).mock(side_effect=httpx.ReadTimeout("slow"))
    with pytest.raises(BizException) as ei:
        await translate_image(cfg(), "k", _image("JPEG"), "image/jpeg", "en", "zh")
    assert ei.value.error == ErrorCode.LLM_TIMEOUT

    respx.post(QWEN_URL).mock(side_effect=httpx.ConnectError("refused"))
    with pytest.raises(BizException) as ei:
        await translate_image(cfg(), "k", _image("JPEG"), "image/jpeg", "en", "zh")
    assert ei.value.message == "百炼图片翻译服务不可达"


def test_probe_image_is_64x32():
    assert Image.open(io.BytesIO(probe_image())).size == (64, 32)


@respx.mock
async def test_probe_reports_result_size():
    route = respx.post(QWEN_URL).mock(return_value=httpx.Response(200, json={"output": {"image_url": RESULT_URL}}))
    respx.get(RESULT_URL).mock(return_value=httpx.Response(200, content=_image("JPEG")))
    assert await probe(cfg(), "sk-dash") == "结果图 64×32"
    sent = json.loads(route.calls[0].request.content)
    assert (sent["input"]["source_lang"], sent["input"]["target_lang"]) == ("en", "zh")
