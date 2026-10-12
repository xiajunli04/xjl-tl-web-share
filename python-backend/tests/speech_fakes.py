"""语音与同传测试替身：脚本化 ASR / TTS、引擎依赖桩、样本音频读取。"""

import asyncio
import re
import wave
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np

from app.core.config import get_settings
from app.core.errors import BizException, ErrorCode
from app.interpret.engine import EngineDeps
from app.lang.languages import LANGUAGES
from app.repositories.model_config import ModelConfig
from app.speech.asr import AsrResult
from app.speech.models import local_model_paths
from app.speech.tts import tts_failed

ROOT = Path(__file__).resolve().parents[1]
SPEECH_FIXTURES = Path(__file__).parent / "fixtures" / "speech"
SAMPLE_ZH = ROOT / "app" / "speech" / "assets" / "sample_zh.wav"
JA_HELLO = SPEECH_FIXTURES / "ja_hello.wav"
ZH_LLM = SPEECH_FIXTURES / "zh_llm.wav"

MODELS_READY = local_model_paths().ready
VAD_READY = local_model_paths().vad.is_file()


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path)) as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768


def read_pcm(path: Path) -> bytes:
    with wave.open(str(path)) as w:
        return w.readframes(w.getnframes())


def make_wav(seconds: float, rate: int = 16000, channels: int = 1, freq: float = 440.0) -> bytes:
    import io

    n = int(seconds * rate)
    t = np.arange(n) / rate
    x = (0.3 * np.sin(2 * np.pi * freq * t) * 32767).astype("<i2")
    if channels > 1:
        x = np.repeat(x[:, None], channels, axis=1).reshape(-1)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(x.tobytes())
    return buf.getvalue()


def model_config(**kw: Any) -> ModelConfig:
    base = dict(
        id=7,
        name="cfg",
        provider="OPENAI_COMPATIBLE",
        base_url="https://speech.test/v1",
        model_name="whisper-1",
        api_key_cipher="",
        is_default=True,
        enabled=True,
        updated_at=datetime(2026, 10, 1, tzinfo=UTC),
        params={},
        capability="ASR",
    )
    base.update(kw)
    return ModelConfig(**base)


@dataclass
class FakeASR:
    """按顺序返回脚本化识别结果 (text, lang)。"""

    results: list[tuple[str, str | None]] = field(default_factory=list)
    id: str = "fake-asr"
    calls: list[tuple[int, str | None]] = field(default_factory=list)

    async def transcribe(self, samples: np.ndarray, lang_hint: str | None = None) -> AsrResult:
        self.calls.append((len(samples), lang_hint))
        text, lang = self.results.pop(0) if self.results else ("", None)
        return AsrResult(text=text, lang=lang, duration_ms=len(samples) // 16, latency_ms=5, engine=self.id)


@dataclass
class FakeTTS:
    """流式返回若干段假 MP3；fail_langs 中的语种（按音色前缀判断）合成失败。"""

    chunks: int = 3
    chunk_bytes: int = 5000
    fail: bool = False
    delay: float = 0.0
    id: str = "edge-tts"
    format: str = "mp3"
    mime: str = "audio/mpeg"
    sample_rate: int = 24000
    cache_scope: str = "fake"
    calls: list[tuple[str, str]] = field(default_factory=list)

    def resolve_voice(self, lang: str | None, voice: str | None, gender: str | None) -> str:
        return voice or f"{lang}-{gender or 'female'}"

    async def stream(self, text: str, voice: str, rate: float = 1.0) -> AsyncIterator[bytes]:
        self.calls.append((text, voice))
        if self.fail:
            raise tts_failed("Edge 语音合成失败（HTTP 403）", 403)
        for i in range(self.chunks):
            if self.delay:
                await asyncio.sleep(self.delay)
            yield bytes([i % 256]) * self.chunk_bytes


@dataclass
class StubRegistry:
    """config_with_key / get 的桩；llm 为 FakeLLM 时 get 返回它。"""

    configs: dict[str, tuple[ModelConfig, str]] = field(default_factory=dict)
    llm: Any = None

    async def config_with_key(self, capability: str, model_config_id: int | None = None):
        if capability not in self.configs:
            raise BizException(ErrorCode.MODEL_CONFIG_UNAVAILABLE)
        return self.configs[capability]

    async def get(self, model_config_id: int | None = None):
        from tests.fakes import resolved

        if self.llm is None:
            raise BizException(ErrorCode.MODEL_CONFIG_UNAVAILABLE)
        return resolved(self.llm)


_NAME_TO_CODE = {lang.name: lang.code for lang in LANGUAGES}
_REMINDER_RE = re.compile(r"最后提醒：只输出.*?的(\S+?)(?:译文|字幕)。")


def target_of(system: str) -> str:
    """从同传或字幕提示词的末尾提醒中取目标语言代码（假模型据此返回 "[目标]原文"）。"""
    return _NAME_TO_CODE[_REMINDER_RE.search(system).group(1)]


@dataclass
class StubGlossaryRepo:
    glossaries: dict = field(default_factory=dict)

    async def load(self, ids: list[int]) -> dict:
        return {i: self.glossaries[i] for i in ids if i in self.glossaries}


class StubDetector:
    def __init__(self, lang: str = "zh"):
        self.lang = lang

    def lingua_candidates(self, text: str) -> list[tuple[str, float]]:
        return [(self.lang, 0.9)]


def engine_deps(registry: Any = None, glossaries: dict | None = None, detect_lang: str = "zh") -> EngineDeps:
    return EngineDeps(
        settings=get_settings(),
        registry=registry or StubRegistry(),
        glossary_repo=StubGlossaryRepo(glossaries or {}),
        detector=StubDetector(detect_lang),
    )


class Collector:
    """收集引擎事件。"""

    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    def __call__(self, ev: dict[str, Any]) -> None:
        self.events.append(ev)

    def of(self, *types: str) -> list[dict[str, Any]]:
        return [e for e in self.events if e["type"] in types]

    def types(self) -> list[str]:
        return [e["type"] for e in self.events]
