"""语音识别适配层（design D5）。

- LocalSenseVoiceASR：sherpa-onnx SenseVoice（本地离线，返回文本与语种；进程内单例，首次加载约 3 s）
- OpenAITranscribeASR：OpenAI 兼容 POST /audio/transcriptions（WAV 上传；未返回 language 时用 lingua 补判）

识别结果的语种统一为平台 ISO 639-1 代码；SenseVoice 的 yue（粤语）在路由时视为 zh，raw_lang 保留原值。
"""

import asyncio
import logging
import re
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

import httpx
import numpy as np

from app.core.config import get_settings
from app.core.errors import BizException, ErrorCode
from app.lang import languages
from app.repositories.model_config import ModelConfig
from app.speech.audio import duration_ms, encode_wav
from app.speech.errors import SpeechHttpError
from app.speech.models import import_sherpa, local_model_paths
from app.speech.vad import SAMPLE_RATE, split_segments

log = logging.getLogger("app.speech.asr")

LOCAL_SENSEVOICE = "local-sensevoice"
OPENAI_TRANSCRIBE = "openai-transcribe"

LOCAL_LANGS = ("zh", "en", "ja", "ko")
LOCAL_MAX_SEGMENT_SECONDS = 20.0  # 超过该时长的音频先按 VAD 分段再识别
REMOTE_TIMEOUT_SECONDS = 30.0

# whisper 系 verbose_json 的 language 可能是英文全名
_WHISPER_NAMES = {
    "chinese": "zh",
    "mandarin": "zh",
    "cantonese": "yue",
    "english": "en",
    "japanese": "ja",
    "korean": "ko",
    "french": "fr",
    "german": "de",
    "spanish": "es",
    "russian": "ru",
    "portuguese": "pt",
    "italian": "it",
    "arabic": "ar",
    "thai": "th",
    "vietnamese": "vi",
    "indonesian": "id",
    "turkish": "tr",
}
_SENSEVOICE_TAG = re.compile(r"<\|([a-z]+)\|>")
# 中日文字之间的空格（SenseVoice 对日语按词输出空格）；韩语本身以空格分词，不处理
_CJK = r"぀-ヿ㐀-䶿一-鿿＀-￯　-〿"
_CJK_SPACE = re.compile(rf"(?<=[{_CJK}])\s+(?=[{_CJK}])")

DetectFn = Callable[[str], str | None]


@dataclass
class AsrResult:
    text: str
    lang: str | None  # 平台语种代码（yue 已归为 zh）；无法判定时为 None
    duration_ms: int
    latency_ms: int
    engine: str
    raw_lang: str | None = None  # 引擎给出的原始语种（如 yue）


class ASREngine(Protocol):
    id: str

    async def transcribe(self, samples: np.ndarray, lang_hint: str | None = None) -> AsrResult: ...

    async def aclose(self) -> None: ...


def normalize_lang(code: str | None) -> str | None:
    """引擎语种 → 平台代码：yue 视为 zh；不在平台 15 语种内的返回 None。"""
    if not code:
        return None
    code = code.strip().lower()
    code = _WHISPER_NAMES.get(code, code)
    code = code.split("-")[0].split("_")[0]
    if code == "yue":
        return "zh"
    return code if languages.is_supported(code) else None


def clean_text(text: str) -> str:
    return _CJK_SPACE.sub("", (text or "").strip())


def _hint(lang_hint: str | None) -> str | None:
    return lang_hint if lang_hint and lang_hint != languages.AUTO and languages.is_supported(lang_hint) else None


def _resolve_lang(text: str, engine_lang: str | None, lang_hint: str | None, detect: DetectFn | None) -> str | None:
    lang = normalize_lang(engine_lang)
    if lang is None and text and detect is not None:
        try:
            lang = detect(text)
        except Exception:  # noqa: BLE001 - 语种补判失败不影响识别结果
            log.debug("语种补判失败", exc_info=True)
    return lang or _hint(lang_hint)


def lingua_detect_fn(detector: Any) -> DetectFn | None:
    """把平台 LanguageDetector 包装为同步补判函数（取 lingua 最高候选）。"""
    if detector is None:
        return None

    def _detect(text: str) -> str | None:
        candidates = detector.lingua_candidates(text)
        return candidates[0][0] if candidates else None

    return _detect


# ---------------- 本地 SenseVoice ----------------


class LocalSenseVoiceASR:
    id = LOCAL_SENSEVOICE
    languages = LOCAL_LANGS

    _recognizer: Any = None
    _load_lock = threading.Lock()

    def __init__(self, detect: DetectFn | None = None):
        self._detect = detect

    @staticmethod
    def availability() -> tuple[bool, str | None]:
        paths = local_model_paths()
        if paths.ready:
            return True, None
        return False, "本地识别模型未下载（运行 uv run python -m app.speech.download）"

    @classmethod
    def _get(cls) -> Any:
        if cls._recognizer is None:
            with cls._load_lock:
                if cls._recognizer is None:
                    paths = local_model_paths()
                    if not paths.ready:
                        raise BizException(ErrorCode.SPEECH_ENGINE_UNAVAILABLE, "本地识别模型未下载")
                    so = import_sherpa()
                    start = time.perf_counter()
                    cls._recognizer = so.OfflineRecognizer.from_sense_voice(
                        model=str(paths.sense_voice_model),
                        tokens=str(paths.sense_voice_tokens),
                        num_threads=get_settings().speech_asr_threads,
                        use_itn=True,
                        language="auto",
                    )
                    log.info("SenseVoice 模型已加载 %.1fs：%s", time.perf_counter() - start, paths.sense_voice_model)
        return cls._recognizer

    @classmethod
    async def warmup(cls) -> None:
        await asyncio.to_thread(cls._get)

    def _decode(self, samples: np.ndarray) -> tuple[str, str | None]:
        rec = self._get()
        stream = rec.create_stream()
        stream.accept_waveform(SAMPLE_RATE, samples)
        rec.decode_stream(stream)
        res = stream.result
        m = _SENSEVOICE_TAG.fullmatch((res.lang or "").strip())
        return clean_text(res.text), (m.group(1) if m else None)

    def transcribe_sync(self, samples: np.ndarray, lang_hint: str | None = None) -> AsrResult:
        start = time.perf_counter()
        if len(samples) > LOCAL_MAX_SEGMENT_SECONDS * SAMPLE_RATE:
            parts = [self._decode(seg.samples) for seg in split_segments(samples)]
            texts = [t for t, _ in parts if t]
            langs = [lang for t, lang in parts if t and lang]
            text = _join(texts)
            raw = max(set(langs), key=langs.count) if langs else None
        else:
            text, raw = self._decode(samples)
        lang = _resolve_lang(text, raw, lang_hint, self._detect) if text else None
        return AsrResult(
            text=text,
            lang=lang,
            duration_ms=duration_ms(samples),
            latency_ms=int((time.perf_counter() - start) * 1000),
            engine=self.id,
            raw_lang=raw,
        )

    async def transcribe(self, samples: np.ndarray, lang_hint: str | None = None) -> AsrResult:
        return await asyncio.to_thread(self.transcribe_sync, samples, lang_hint)

    async def aclose(self) -> None:
        return None  # 本地模型为进程级共享，不随会话释放


def _join(texts: list[str]) -> str:
    """分段识别结果拼接：中日韩直接相连，其他语言用空格。"""
    out = ""
    for t in texts:
        if out and not (re.match(rf"[{_CJK}]", t[0]) and re.search(rf"[{_CJK}]$", out)):
            out += " "
        out += t
    return out


# ---------------- OpenAI 兼容远程转写 ----------------


class OpenAITranscribeASR:
    id = OPENAI_TRANSCRIBE

    def __init__(
        self,
        cfg: ModelConfig,
        api_key: str,
        detect: DetectFn | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self._cfg = cfg
        self._key = api_key
        self._detect = detect
        self._transport = transport  # 测试注入
        self._client: httpx.AsyncClient | None = None  # 惰性创建，同一实例（同传会话）内复用连接

    @property
    def config_id(self) -> int:
        return self._cfg.id

    def _timeout(self) -> float:
        return float(self._cfg.params.get("timeoutSeconds") or REMOTE_TIMEOUT_SECONDS)

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self._timeout(), transport=self._transport)
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            client, self._client = self._client, None
            await client.aclose()

    async def transcribe(self, samples: np.ndarray, lang_hint: str | None = None) -> AsrResult:
        start = time.perf_counter()
        fmt = self._cfg.extra.get("responseFormat") or "verbose_json"
        data = {"model": self._cfg.model_name, "response_format": fmt}
        if _hint(lang_hint):
            data["language"] = lang_hint
        url = self._cfg.base_url.rstrip("/") + "/audio/transcriptions"
        try:
            resp = await self._http().post(
                url,
                headers={"Authorization": f"Bearer {self._key}"},
                data=data,
                files={"file": ("audio.wav", encode_wav(samples), "audio/wav")},
            )
        except httpx.TimeoutException as e:
            raise SpeechHttpError(ErrorCode.SPEECH_ENGINE_UNAVAILABLE, "语音识别服务超时") from e
        except httpx.HTTPError as e:
            raise SpeechHttpError(ErrorCode.SPEECH_ENGINE_UNAVAILABLE, "语音识别服务不可达") from e
        if resp.status_code != 200:
            log.info("远程转写失败 config=%s HTTP %s", self._cfg.id, resp.status_code)
            raise SpeechHttpError(
                ErrorCode.SPEECH_ENGINE_UNAVAILABLE, f"语音识别调用失败（HTTP {resp.status_code}）", resp.status_code
            )
        text, engine_lang = _parse_transcription(resp)
        text = clean_text(text)
        return AsrResult(
            text=text,
            lang=_resolve_lang(text, engine_lang, lang_hint, self._detect) if text else None,
            duration_ms=duration_ms(samples),
            latency_ms=int((time.perf_counter() - start) * 1000),
            engine=self.id,
            raw_lang=engine_lang,
        )


def _parse_transcription(resp: httpx.Response) -> tuple[str, str | None]:
    ctype = resp.headers.get("content-type", "")
    if "json" not in ctype:
        return resp.text, None
    try:
        body = resp.json()
    except ValueError:
        return resp.text, None
    if not isinstance(body, dict):
        return "", None
    lang = body.get("language")
    return str(body.get("text") or ""), str(lang) if lang else None
