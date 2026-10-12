"""图片翻译测试工具：即时生成图片、脚本化的视觉 LLM。"""

import base64
import io
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime

from PIL import Image

from app.image.prompts import OCR_ROLE, TRANSLATE_ROLE
from app.llm.base import ChatChunk, ChatRequest, ChatResult, Usage, content_text
from app.llm.registry import ResolvedModel
from app.repositories.model_config import ModelConfig


def make_image(width: int = 400, height: int = 300, fmt: str = "PNG", orientation: int | None = None, **kw) -> bytes:
    img = Image.new("RGB", (width, height), (240, 240, 240))
    buf = io.BytesIO()
    if orientation is not None:
        exif = Image.Exif()
        exif[0x0112] = orientation
        img.save(buf, fmt, exif=exif, **kw)
    else:
        img.save(buf, fmt, **kw)
    return buf.getvalue()


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _kind(req: ChatRequest) -> str:
    system = next((content_text(m.content) for m in req.messages if m.role == "system"), "")
    if system.startswith(OCR_ROLE):
        return "ocr"
    if system.startswith(TRANSLATE_ROLE):
        return "translate"
    return "other"


@dataclass
class FakeVisionLLM:
    """ocr / translate 依次返回脚本化内容。"""

    ocr: list[str] = field(default_factory=list)
    translate: list[str] = field(default_factory=list)
    model: str = "fake-vision"
    calls: list[tuple[str, ChatRequest]] = field(default_factory=list)

    def kinds(self) -> list[str]:
        return [k for k, _ in self.calls]

    async def chat(self, req: ChatRequest) -> ChatResult:
        kind = _kind(req)
        self.calls.append((kind, req))
        content = (self.ocr if kind == "ocr" else self.translate).pop(0)
        return ChatResult(content=content, model=self.model, usage=Usage(100, 10), latency_ms=1)

    async def stream(self, req: ChatRequest) -> AsyncIterator[ChatChunk]:  # pragma: no cover - 管线不使用流式
        raise NotImplementedError
        yield

    async def close(self) -> None:
        pass


def vision_resolved(fake, *, supports_vision: bool = True, config_id: int = 2) -> ResolvedModel:
    cfg = ModelConfig(
        id=config_id,
        name="fake-vision",
        provider="OPENAI_COMPATIBLE",
        base_url="https://llm.test/v1",
        model_name=fake.model,
        api_key_cipher="",
        is_default=True,
        enabled=True,
        updated_at=datetime.now(UTC),
        params={},
        supports_vision=supports_vision,
    )
    return ResolvedModel(cfg, fake)


def use_vision_llm(app, monkeypatch, fake, **kw) -> None:
    async def _get(_model_config_id=None):
        return vision_resolved(fake, **kw)

    monkeypatch.setattr(app.state.registry, "get", _get)
