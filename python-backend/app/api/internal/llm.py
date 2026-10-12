"""POST /internal/llm/test：模型连通性测试，按配置的 capability 分支（契约 §1.4）。

| capability | 测试 | reply |
| CHAT | 原有 ping | 回复片段 |
| ASR | 转写内置样本 app/speech/assets/sample_zh.wav | 识别文本 |
| TTS | 合成"你好" | "音频 N 字节" |
| REALTIME_TRANSLATE | 按 provider 分发到各同传引擎的 probe：建立上游会话并完成会话配置后关闭 | "会话已建立" |
| REALTIME_CHAT | 实时语音对话（app.interpret.realtime_chat.probe）：建立会话并完成配置后关闭 | "会话已建立" |
| IMAGE_TRANSLATE | 翻译内置小图（app.image.qwen_mt_image.probe） | "结果图 64×32" |
"""

import logging
import time
from pathlib import Path

from fastapi import APIRouter, Depends, Request
from pydantic import Field

from app.core.errors import BizException, ErrorCode, ok
from app.core.schema import CamelModel
from app.core.security import verify_internal_token
from app.interpret import doubao_ast, gemini_live_translate, openai_realtime, qwen_livetranslate
from app.interpret.engine import EngineError
from app.llm.base import ChatMessage, ChatRequest, LLMError, build_error, classify_status
from app.llm.registry import LLMRegistry
from app.repositories.model_config import (
    ASR,
    CHAT,
    IMAGE_TRANSLATE,
    REALTIME_CHAT,
    REALTIME_TRANSLATE,
    TTS,
    ModelConfig,
)
from app.speech.asr import OpenAITranscribeASR
from app.speech.audio import decode_wav
from app.speech.engines import DASHSCOPE, GOOGLE, OPENAI_COMPATIBLE, VOLCENGINE
from app.speech.errors import SpeechHttpError
from app.speech.tts import OpenAISpeechTTS, synthesize

log = logging.getLogger("app.api.llm")

router = APIRouter(prefix="/internal/llm", tags=["internal"], dependencies=[Depends(verify_internal_token)])

PING_PROMPT = "Reply with exactly one word: pong"
PING_MAX_TOKENS = 16
SAMPLE_WAV = Path(__file__).resolve().parents[2] / "speech" / "assets" / "sample_zh.wav"
TTS_PROBE_TEXT = "你好"
# REALTIME_TRANSLATE 连通性测试：provider → 同传引擎模块（调用时取 module.probe）
REALTIME_PROBES = {
    DASHSCOPE: qwen_livetranslate,
    OPENAI_COMPATIBLE: openai_realtime,
    GOOGLE: gemini_live_translate,
    VOLCENGINE: doubao_ast,
}


class ModelTestRequest(CamelModel):
    model_config_id: int | None = Field(default=None, ge=1)


class UsageVO(CamelModel):
    prompt_tokens: int
    completion_tokens: int


class ModelTestResult(CamelModel):
    ok: bool
    model: str | None = None
    latency_ms: int
    reply: str | None = None
    usage: UsageVO | None = None
    error_code: str | None = None
    error_message: str | None = None


@router.post("/test")
async def test_model(body: ModelTestRequest, request: Request) -> dict:
    registry: LLMRegistry = request.app.state.registry
    if body.model_config_id is not None:
        cfg = await registry.repo.find_active_by_id(body.model_config_id)
        if cfg is None:
            raise BizException(ErrorCode.MODEL_CONFIG_UNAVAILABLE)
        if cfg.capability != CHAT:
            result = await _test_capability(registry, cfg)
            return ok(result.model_dump(by_alias=True, exclude_none=True))
    resolved = await registry.get(body.model_config_id)  # 不存在/停用 -> C0130
    timeout = resolved.params.get("timeoutSeconds")
    req = ChatRequest(
        messages=[ChatMessage(role="user", content=PING_PROMPT)],
        max_tokens=PING_MAX_TOKENS,
        timeout=float(timeout) if timeout else None,
    )
    start = time.perf_counter()
    try:
        res = await resolved.client.chat(req)
    except LLMError as e:
        latency = int((time.perf_counter() - start) * 1000)
        log.info("模型连通性测试失败 id=%s kind=%s", resolved.config.id, e.kind)
        result = ModelTestResult(ok=False, latency_ms=latency, error_code=e.error_code.code, error_message=e.message)
    else:
        result = ModelTestResult(
            ok=True,
            model=res.model,
            latency_ms=res.latency_ms,
            reply=res.content.strip(),
            usage=UsageVO(prompt_tokens=res.usage.prompt_tokens, completion_tokens=res.usage.completion_tokens),
        )
    return ok(result.model_dump(by_alias=True, exclude_none=True))


async def _probe(registry: LLMRegistry, cfg: ModelConfig) -> str:
    _, api_key = await registry.config_with_key(cfg.capability, cfg.id)
    if cfg.capability == ASR:
        asr = OpenAITranscribeASR(cfg, api_key)
        try:
            res = await asr.transcribe(decode_wav(SAMPLE_WAV.read_bytes()), "zh")
        finally:
            await asr.aclose()
        return res.text or "（未识别到文字）"
    if cfg.capability == TTS:
        tts = OpenAISpeechTTS(cfg, api_key)
        try:
            audio = await synthesize(tts, TTS_PROBE_TEXT, "zh", cache=None)
        finally:
            await tts.aclose()
        return f"音频 {len(audio.data)} 字节"
    if cfg.capability == REALTIME_TRANSLATE:
        module = REALTIME_PROBES.get(cfg.provider)
        if module is None:
            raise EngineError(ErrorCode.SPEECH_ENGINE_UNAVAILABLE, "该实时同传引擎未实现")
        return await module.probe(cfg, api_key)
    if cfg.capability == REALTIME_CHAT:
        from app.interpret.realtime_chat import probe as realtime_chat_probe

        return await realtime_chat_probe(cfg, api_key)
    if cfg.capability == IMAGE_TRANSLATE:
        try:
            from app.image.qwen_mt_image import probe as image_probe
        except ImportError:
            raise EngineError(ErrorCode.SPEECH_ENGINE_UNAVAILABLE, "图片翻译引擎未实现") from None
        return await image_probe(cfg, api_key)
    raise EngineError(ErrorCode.PARAM_INVALID, f"不支持的能力类型: {cfg.capability}")


def _speech_error_code(e: SpeechHttpError) -> str:
    """远程语音接口按 HTTP 状态归类（鉴权 C0121、限流 C0123），其余沿用 C0172 / C0173。"""
    if e.status is None:
        return e.error.code
    err = build_error(classify_status(e.status), e.status).error_code
    return err.code if err in (ErrorCode.LLM_AUTH_FAILED, ErrorCode.LLM_RATE_LIMITED) else e.error.code


async def _test_capability(registry: LLMRegistry, cfg: ModelConfig) -> ModelTestResult:
    start = time.perf_counter()
    code: str | None = None
    message: str | None = None
    reply: str | None = None
    try:
        reply = await _probe(registry, cfg)
    except SpeechHttpError as e:
        code, message = _speech_error_code(e), e.message
    except EngineError as e:
        code, message = e.error.code, e.message
    except BizException as e:
        code, message = e.error.code, e.message
    except LLMError as e:
        code, message = e.error_code.code, e.message
    except Exception as e:  # noqa: BLE001 - 连通性测试不向外抛异常
        log.exception("连通性测试异常 id=%s capability=%s", cfg.id, cfg.capability)
        code, message = ErrorCode.SYSTEM_ERROR.code, f"测试失败（{type(e).__name__}）"
    latency = int((time.perf_counter() - start) * 1000)
    if code is not None:
        log.info("连通性测试失败 id=%s capability=%s code=%s", cfg.id, cfg.capability, code)
        return ModelTestResult(
            ok=False, model=cfg.model_name, latency_ms=latency, error_code=code, error_message=message
        )
    return ModelTestResult(ok=True, model=cfg.model_name, latency_ms=latency, reply=reply)
