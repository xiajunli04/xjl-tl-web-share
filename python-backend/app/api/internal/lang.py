from fastapi import APIRouter, Depends, Request

from app.core.errors import ok
from app.core.schema import CamelModel
from app.core.security import verify_internal_token
from app.lang.detector import LanguageDetector
from app.llm.base import LLMClient
from app.llm.registry import LLMRegistry

router = APIRouter(prefix="/internal/lang", tags=["internal"], dependencies=[Depends(verify_internal_token)])


class DetectRequest(CamelModel):
    text: str


@router.post("/detect")
async def detect(body: DetectRequest, request: Request) -> dict:
    """返回 {lang, confidence, method, candidates}；低置信度或短文本时用默认模型兜底。"""
    detector: LanguageDetector = request.app.state.detector
    registry: LLMRegistry = request.app.state.registry

    async def default_llm() -> LLMClient:
        return (await registry.get(None)).client

    result = await detector.detect(body.text, default_llm)
    return ok(result.to_vo())
