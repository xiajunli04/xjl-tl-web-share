"""响应信封与错误码（与 Spring 的 ErrorCode 保持一致，见 design D2）。"""

import logging
from enum import Enum
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.logging import get_trace_id

log = logging.getLogger("app.errors")


class ErrorCode(Enum):
    SUCCESS = ("00000", "成功", 200)
    NOT_FOUND = ("A0404", "资源不存在", 404)
    PARAM_INVALID = ("A0410", "请求参数校验失败", 400)
    UNSUPPORTED_LANGUAGE = ("A0420", "不支持的语种", 400)
    CLARIFY_EXPIRED = ("A0440", "追问已失效", 409)
    IMAGE_INVALID = ("A0450", "图片为空、过大或格式不支持", 400)
    AUDIO_INVALID = ("A0454", "音频为空、过长或格式不支持", 400)
    TOO_MANY_REQUESTS = ("A0212", "请求过于频繁，请稍后再试", 429)
    SYSTEM_ERROR = ("B0001", "系统执行出错", 500)
    INTERNAL_AUTH_FAILED = ("B0100", "内部服务鉴权失败", 401)
    AI_UNAVAILABLE = ("C0110", "AI 服务不可用", 503)
    LLM_CALL_FAILED = ("C0120", "LLM 调用失败", 502)
    LLM_AUTH_FAILED = ("C0121", "LLM 鉴权失败（API Key 无效）", 502)
    LLM_TIMEOUT = ("C0122", "LLM 调用超时", 504)
    LLM_RATE_LIMITED = ("C0123", "LLM 限流", 502)
    MODEL_CONFIG_UNAVAILABLE = ("C0130", "模型配置不存在或已停用", 400)
    AGENT_FAILED = ("C0140", "Agent 执行失败", 502)
    TRANSLATE_TIMEOUT = ("C0141", "翻译超时", 504)
    DOC_TASK_FAILED = ("C0150", "文档任务执行失败", 502)
    TM_UNAVAILABLE = ("C0160", "翻译记忆服务不可用", 503)
    VISION_UNSUPPORTED = ("C0170", "所选模型不支持图片输入", 400)
    OCR_PARSE_FAILED = ("C0171", "OCR 结果解析失败", 502)
    TTS_FAILED = ("C0172", "语音合成失败", 502)
    SPEECH_ENGINE_UNAVAILABLE = ("C0173", "语音引擎不可用", 503)
    REALTIME_UPSTREAM_FAILED = ("C0174", "实时同传上游连接失败或中断", 502)

    def __init__(self, code: str, message: str, http_status: int):
        self.code = code
        self.message = message
        self.http_status = http_status


class BizException(Exception):
    def __init__(self, error: ErrorCode, message: str | None = None, data: Any = None):
        super().__init__(message or error.message)
        self.error = error
        self.message = message or error.message
        self.data = data


def envelope(code: str, message: str, data: Any = None) -> dict[str, Any]:
    return {"code": code, "message": message, "data": data, "traceId": get_trace_id()}


def ok(data: Any = None) -> dict[str, Any]:
    return envelope(ErrorCode.SUCCESS.code, ErrorCode.SUCCESS.message, data)


def error_response(error: ErrorCode, message: str | None = None, data: Any = None) -> JSONResponse:
    return JSONResponse(
        status_code=error.http_status,
        content=envelope(error.code, message or error.message, data),
    )


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(BizException)
    async def _biz(_: Request, exc: BizException) -> JSONResponse:
        return error_response(exc.error, exc.message, exc.data)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        details = [
            {"field": ".".join(str(p) for p in e.get("loc", ())[1:]), "message": e.get("msg", "")} for e in exc.errors()
        ]
        return error_response(ErrorCode.PARAM_INVALID, data=details)

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        if exc.status_code == 404:
            return error_response(ErrorCode.NOT_FOUND)
        return JSONResponse(
            status_code=exc.status_code,
            content=envelope(ErrorCode.SYSTEM_ERROR.code, str(exc.detail)),
        )

    @app.exception_handler(Exception)
    async def _unexpected(_: Request, exc: Exception) -> JSONResponse:
        log.exception("未预期异常: %s", type(exc).__name__)
        return error_response(ErrorCode.SYSTEM_ERROR)
