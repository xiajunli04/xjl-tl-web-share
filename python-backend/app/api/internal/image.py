"""POST /internal/image/translate：图片翻译 SSE（design D10，契约 §1.5）。

- 参数、图片与模型配置在建立流之前校验，失败时返回普通 JSON：A0410 / A0420 / A0450 / C0130 / C0170
- 流建立后：start → node / blocks / translation … → done | error；SSE 心跳、超时与断开取消复用文本翻译流的实现
"""

import asyncio
import logging

from fastapi import APIRouter, Depends, Request
from fastapi.sse import EventSourceResponse

from app.api.internal.translate import _sse_response
from app.core.config import Settings
from app.core.errors import BizException, ErrorCode
from app.core.logging import get_trace_id
from app.core.security import verify_internal_token
from app.image.pipeline import VISION, ImageDeps, ImageTranslateRequest, run_qwen_mt_image, run_vision
from app.image.preprocess import MAX_SIDE, decode_base64, prepare_image
from app.llm.registry import LLMRegistry
from app.repositories.model_config import IMAGE_TRANSLATE

log = logging.getLogger("app.api.image")

router = APIRouter(prefix="/internal/image", tags=["internal"], dependencies=[Depends(verify_internal_token)])

DASHSCOPE = "DASHSCOPE"
TIMEOUT_MARGIN_SECONDS = 60.0


def total_timeout(settings: Settings) -> float:
    """整次图片翻译上限：OCR 与翻译两次 LLM 调用各自的超时之和，再留出余量。"""
    return 2 * settings.image_llm_timeout_seconds + TIMEOUT_MARGIN_SECONDS


@router.post("/translate")
async def image_translate(body: ImageTranslateRequest, request: Request) -> EventSourceResponse:
    settings: Settings = request.app.state.settings
    body.check()
    raw = decode_base64(body.image_base64)
    registry: LLMRegistry = request.app.state.registry
    deps = ImageDeps(
        settings=settings,
        glossary_repo=request.app.state.glossary_repo,
        detector=getattr(request.app.state, "detector", None),
    )
    trace_id = get_trace_id()
    if body.engine == VISION:
        resolved = await registry.get(body.model_config_id)  # 未指定时取 CHAT 默认模型；不存在/停用 -> C0130
        if not resolved.config.supports_vision:
            raise BizException(ErrorCode.VISION_UNSUPPORTED)
        image = await asyncio.to_thread(prepare_image, raw, settings.image_max_side)
        log.info(
            "开始图片翻译 engine=vision userId=%s model=%s %s->%s size=%dx%d scale=%.3f glossaries=%s",
            body.user_id,
            resolved.config.id,
            body.source_lang,
            body.target_lang,
            image.orig_width,
            image.orig_height,
            image.scale,
            body.glossary_ids,
        )
        return _sse_response(
            lambda: run_vision(body, image, resolved, deps),
            settings,
            trace_id,
            timeout_seconds=total_timeout(settings),
        )

    cfg, api_key = await registry.config_with_key(IMAGE_TRANSLATE, body.model_config_id)  # 无可用配置 -> C0130
    if cfg.provider != DASHSCOPE:
        raise BizException(ErrorCode.MODEL_CONFIG_UNAVAILABLE, f"配置 {cfg.id} 不是百炼图片翻译配置")
    image = await asyncio.to_thread(prepare_image, raw, MAX_SIDE)  # 一体化引擎保留原图分辨率，只做 EXIF 校正
    log.info(
        "开始图片翻译 engine=qwen-mt-image userId=%s config=%s %s->%s size=%dx%d",
        body.user_id,
        cfg.id,
        body.source_lang,
        body.target_lang,
        image.orig_width,
        image.orig_height,
    )
    return _sse_response(
        lambda: run_qwen_mt_image(body, image, cfg, api_key, deps),
        settings,
        trace_id,
        timeout_seconds=total_timeout(settings),
    )
