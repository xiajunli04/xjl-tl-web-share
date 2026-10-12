"""百炼 qwen-mt-image-2.0 一体化图片翻译引擎（design D10）。

- 同步调用：POST {host}/api/v1/services/aigc/image2image/image-synthesis，Bearer 鉴权，不带 X-DashScope-Async
- 请求体 {model, input:{image_url, source_lang, target_lang}, ext?}；成功响应 output.image_url（24 h 有效）
- 接口文档要求公网 image_url；2026-10-04 用真实密钥实测 data URL 同样被接受（同步约 5 s），因此直接以 data URL 传图。
  若服务端日后拒绝 data URL，调用与连通性测试返回明确错误"需公网图床"（不引入对象存储）
- 下载返回的译图并以 JPEG 字节返回，由调用方转 base64 交给 Spring 落盘
"""

import io
import logging
import time
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpx
from PIL import Image, ImageDraw, ImageFont, UnidentifiedImageError

from app.core.errors import BizException, ErrorCode
from app.image.preprocess import encode_jpeg, to_data_url
from app.repositories.model_config import ModelConfig

log = logging.getLogger("app.image.qwen_mt_image")

DEFAULT_HOST = "https://dashscope.aliyuncs.com"
SYNTHESIS_PATH = "/api/v1/services/aigc/image2image/image-synthesis"
DEFAULT_MODEL = "qwen-mt-image-2.0"
DEFAULT_TIMEOUT_SECONDS = 120.0
MAX_TERMS = 50  # ext.terminologies 的条数上限
DATA_URL_REJECTED = "百炼图片翻译不接受 data URL 传图，需要配置公网图床，该引擎暂不可用"


@dataclass
class QwenImageResult:
    image: bytes  # JPEG
    width: int
    height: int
    latency_ms: int
    request_id: str | None = None


def endpoint(cfg: ModelConfig) -> str:
    """配置的 base_url 只取协议与主机（兼容填写 https://dashscope.aliyuncs.com 或带 /api/v1 的写法）。"""
    parts = urlsplit((cfg.base_url or "").strip())
    host = f"{parts.scheme}://{parts.netloc}" if parts.scheme in ("http", "https") and parts.netloc else DEFAULT_HOST
    return host + SYNTHESIS_PATH


def _timeout(cfg: ModelConfig, default: float) -> float:
    return float(cfg.params.get("timeoutSeconds") or default)


def _status_error(status: int, code: str, message: str) -> BizException:
    if status in (401, 403) or code in ("InvalidApiKey", "AccessDenied"):
        return BizException(ErrorCode.LLM_AUTH_FAILED)
    if status == 429 or code.startswith("Throttling"):
        return BizException(ErrorCode.LLM_RATE_LIMITED)
    lowered = message.lower()
    if 400 <= status < 500 and "url" in lowered and ("invalid" in lowered or "download" in lowered):
        return BizException(ErrorCode.LLM_CALL_FAILED, DATA_URL_REJECTED)
    detail = f"{code}：{message[:120]}" if code or message else f"HTTP {status}"
    return BizException(ErrorCode.LLM_CALL_FAILED, f"百炼图片翻译失败（{detail}）")


async def translate_image(
    cfg: ModelConfig,
    api_key: str,
    image: bytes,
    mime: str,
    source_lang: str,
    target_lang: str,
    *,
    terms: Sequence[tuple[str, str]] = (),
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    client: httpx.AsyncClient | None = None,
) -> QwenImageResult:
    """调用 qwen-mt-image 翻译一张图并下载译图。source_lang 可为 auto。

    失败时抛出 BizException：鉴权 C0121、限流 C0123、超时 C0122、其他 C0120（data URL 被拒时给出"需公网图床"）。
    """
    body: dict[str, Any] = {
        "model": cfg.model_name or DEFAULT_MODEL,
        "input": {"image_url": to_data_url(image, mime), "source_lang": source_lang, "target_lang": target_lang},
    }
    if terms:
        body["ext"] = {"terminologies": [{"src": s, "tgt": t} for s, t in list(terms)[:MAX_TERMS]]}
    timeout = _timeout(cfg, timeout)
    own_client = client is None
    http = client or httpx.AsyncClient(timeout=timeout)
    start = time.perf_counter()
    try:
        resp = await http.post(endpoint(cfg), headers={"Authorization": f"Bearer {api_key}"}, json=body)
        payload = _json(resp)
        if resp.status_code != 200 or payload.get("code"):
            code, message = str(payload.get("code") or ""), str(payload.get("message") or "")
            log.warning("qwen-mt-image 调用失败 status=%s code=%s message=%s", resp.status_code, code, message[:200])
            raise _status_error(resp.status_code, code, message)
        url = ((payload.get("output") or {}).get("image_url")) or ""
        if not url:
            raise BizException(ErrorCode.LLM_CALL_FAILED, "百炼图片翻译未返回译图地址")
        img_resp = await http.get(url)
        if img_resp.status_code != 200:
            raise BizException(ErrorCode.LLM_CALL_FAILED, f"下载译图失败（HTTP {img_resp.status_code}）")
        data, width, height = _as_jpeg(img_resp.content)
    except httpx.TimeoutException:
        raise BizException(ErrorCode.LLM_TIMEOUT) from None
    except httpx.HTTPError as e:
        log.warning("qwen-mt-image 网络错误: %s", type(e).__name__)
        raise BizException(ErrorCode.LLM_CALL_FAILED, "百炼图片翻译服务不可达") from None
    finally:
        if own_client:
            await http.aclose()
    latency = int((time.perf_counter() - start) * 1000)
    return QwenImageResult(data, width, height, latency, payload.get("request_id"))


def _json(resp: httpx.Response) -> dict[str, Any]:
    try:
        data = resp.json()
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _as_jpeg(raw: bytes) -> tuple[bytes, int, int]:
    """返回 JPEG 字节与宽高；非 JPEG 时转码（契约约定 resultImageBase64 为 JPG）。"""
    try:
        img = Image.open(io.BytesIO(raw))
        img.load()
    except (UnidentifiedImageError, OSError, ValueError):
        raise BizException(ErrorCode.LLM_CALL_FAILED, "百炼返回的译图无法解码") from None
    if (img.format or "").upper() == "JPEG":
        return raw, img.width, img.height
    return encode_jpeg(img.convert("RGB")), img.width, img.height


def probe_image() -> bytes:
    """连通性测试用的 64×32 白底黑字 "Hi" 小图（JPEG）。"""
    img = Image.new("RGB", (64, 32), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    try:
        font: Any = ImageFont.load_default(size=20)
    except TypeError:  # 旧版 Pillow 的 load_default 不接受 size
        font = ImageFont.load_default()
    draw.text((16, 4), "Hi", fill=(0, 0, 0), font=font)
    return encode_jpeg(img)


async def probe(cfg: ModelConfig, api_key: str) -> str:
    """IMAGE_TRANSLATE 配置的连通性测试（/internal/llm/test 调用）：翻译内置小图，返回如"结果图 64×32"。

    失败时抛出 BizException（错误码同 translate_image）。
    """
    result = await translate_image(cfg, api_key, probe_image(), "image/jpeg", "en", "zh")
    return f"结果图 {result.width}×{result.height}"
