"""语音内部接口（契约 §1.1–§1.3）：引擎清单、听写转写、朗读合成。

- GET  /internal/speech/engines?refresh=false：四类 EngineInfo；内置引擎探测结果缓存 10 分钟
- POST /internal/speech/transcribe：WAV（base64）→ {text, lang, durationMs, engine}；
  空 / 超过 60 s / 非 WAV → A0454，引擎不可用 → C0173
- POST /internal/speech/tts：成功以分块传输返回音频（首包就绪后开始返回，improve-speech-playback-latency D2），
  带 X-Tts-Engine / X-Tts-Voice / X-Tts-Cache（hit | miss）头；命中缓存时整段返回；
  首包前失败为信封 JSON（C0172 / C0173 / A0410），首包后中断则提前结束连接
"""

import asyncio
import base64
import binascii
import logging
from typing import Literal

from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import Field

from app.core.errors import BizException, ErrorCode, ok
from app.core.schema import CamelModel
from app.core.security import verify_internal_token
from app.lang import languages
from app.speech.audio import decode_wav, duration_ms
from app.speech.engines import list_engines, resolve_asr, resolve_tts
from app.speech.tts import RATE_MAX, RATE_MIN, open_stream

log = logging.getLogger("app.api.speech")

router = APIRouter(prefix="/internal/speech", tags=["internal"], dependencies=[Depends(verify_internal_token)])


class TranscribeRequest(CamelModel):
    audio_base64: str = ""
    lang: str = languages.AUTO
    engine: str | None = None
    model_config_id: int | None = Field(default=None, ge=1)


class TtsRequest(CamelModel):
    text: str = ""
    lang: str | None = None
    voice: str | None = None
    gender: Literal["female", "male"] | None = None
    rate: float = Field(default=1.0, ge=RATE_MIN, le=RATE_MAX)
    engine: str | None = None
    model_config_id: int | None = Field(default=None, ge=1)


@router.get("/engines")
async def engines(request: Request, refresh: bool = False) -> dict:
    return ok(await list_engines(request.app.state.registry.repo, refresh))


@router.post("/transcribe")
async def transcribe(body: TranscribeRequest, request: Request) -> dict:
    settings = request.app.state.settings
    try:
        raw = base64.b64decode(body.audio_base64, validate=True)
    except (binascii.Error, ValueError) as e:
        raise BizException(ErrorCode.AUDIO_INVALID, "音频 base64 解码失败") from e
    samples = decode_wav(raw, settings.speech_transcribe_max_seconds)
    asr = await resolve_asr(body.engine, body.model_config_id, request.app.state.registry, request.app.state.detector)
    try:
        result = await asr.transcribe(samples, body.lang)
    finally:
        await asr.aclose()
    log.info(
        "听写完成 engine=%s duration=%sms latency=%sms lang=%s",
        asr.id,
        result.duration_ms,
        result.latency_ms,
        result.lang,
    )
    return ok({"text": result.text, "lang": result.lang, "durationMs": duration_ms(samples), "engine": asr.id})


@router.post("/tts")
async def tts(body: TtsRequest, request: Request) -> Response:
    settings = request.app.state.settings
    text = body.text.strip()
    if not text:
        raise BizException(ErrorCode.PARAM_INVALID, "朗读文本不能为空")
    if len(text) > settings.speech_tts_max_chars:
        raise BizException(ErrorCode.PARAM_INVALID, f"朗读文本不能超过 {settings.speech_tts_max_chars} 字符")
    lang = body.lang if languages.is_supported(body.lang) else None
    if lang is None:
        candidates = await asyncio.to_thread(request.app.state.detector.lingua_candidates, text)
        lang = candidates[0][0] if candidates else "en"
    engine = await resolve_tts(body.engine, body.model_config_id, request.app.state.registry)
    try:
        stream = await open_stream(engine, text, lang, body.voice, body.gender, body.rate)
    except BaseException:
        await engine.aclose()
        raise
    headers = {
        "X-Tts-Engine": stream.engine,
        "X-Tts-Voice": stream.voice,
        "X-Tts-Cache": "hit" if stream.cached else "miss",
    }
    log.info(
        "朗读合成 engine=%s voice=%s rate=%s cached=%s firstMs=%s",
        stream.engine,
        stream.voice,
        body.rate,
        stream.cached,
        stream.first_ms,
    )

    async def body_iter():
        try:
            async for chunk in stream:
                yield chunk
        except Exception as e:  # noqa: BLE001 - 首包后中断：只能提前结束连接，客户端据此停止播放
            log.info("朗读流中断 engine=%s: %s", stream.engine, e)
        finally:
            await stream.aclose()
            await engine.aclose()

    if stream.cached:
        data = b"".join([chunk async for chunk in body_iter()])
        return Response(content=data, media_type=stream.mime, headers=headers)
    return StreamingResponse(body_iter(), media_type=stream.mime, headers=headers)
