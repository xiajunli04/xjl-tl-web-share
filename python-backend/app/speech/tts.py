"""语音合成适配层（design D5；improve-speech-playback-latency D2 / D4）。

- EdgeTTS：微软 Edge 在线语音，流式 MP3（24 kHz），按语种映射默认音色，支持男女声；进程级并发上限防限流
- OpenAISpeechTTS：OpenAI 兼容 POST /audio/speech（response_format=pcm，PCM16LE 24 kHz），实例内复用连接
- open_stream：流式合成（朗读接口），先拿到首包再边产出边返回，结束后写入缓存；命中缓存时整段返回
- synthesize：整段合成（连通性测试等），与 open_stream 共用缓存
- 缓存键为（引擎范围、音色、语速、文本），进程内 LRU

合成失败统一抛出 C0172（同传中由调用方降级为浏览器朗读）。
"""

import asyncio
import contextlib
import logging
import time
import weakref
from collections import OrderedDict
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Protocol

import httpx

from app.core.config import get_settings
from app.core.errors import ErrorCode
from app.repositories.model_config import ModelConfig
from app.speech.errors import SpeechHttpError
from app.speech.voices import edge_voice, openai_voice

log = logging.getLogger("app.speech.tts")

EDGE_TTS = "edge-tts"
OPENAI_SPEECH = "openai-speech"
BROWSER = "browser"

MP3 = "mp3"
PCM16 = "pcm16"
TTS_SAMPLE_RATE = 24000
REMOTE_TIMEOUT_SECONDS = 30.0
RATE_MIN, RATE_MAX = 0.5, 2.0


@dataclass
class TtsAudio:
    data: bytes
    mime: str
    voice: str
    engine: str
    format: str
    sample_rate: int
    latency_ms: int = 0
    cached: bool = False


class TtsEngine(Protocol):
    id: str
    format: str  # mp3 | pcm16
    mime: str
    sample_rate: int
    cache_scope: str  # 缓存键的一部分：同一引擎不同模型配置互不命中

    def resolve_voice(self, lang: str | None, voice: str | None, gender: str | None) -> str: ...

    def stream(self, text: str, voice: str, rate: float = 1.0) -> AsyncIterator[bytes]: ...

    async def aclose(self) -> None: ...


def tts_failed(message: str, status: int | None = None) -> SpeechHttpError:
    return SpeechHttpError(ErrorCode.TTS_FAILED, message, status)


def clamp_rate(rate: float | None) -> float:
    return min(RATE_MAX, max(RATE_MIN, rate if rate else 1.0))


# ---------------- Edge 在线语音 ----------------

# 每个事件循环一个信号量（测试会切换事件循环，信号量不能跨循环共用）
_edge_slots: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore]" = weakref.WeakKeyDictionary()


def _edge_slot() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    sem = _edge_slots.get(loop)
    if sem is None:
        sem = _edge_slots[loop] = asyncio.Semaphore(max(1, get_settings().edge_tts_max_concurrency))
    return sem


def edge_rate(rate: float) -> str:
    """语速倍率 → Edge 的百分比写法（取整到 5%），如 1.2 → "+20%"。"""
    pct = round((clamp_rate(rate) - 1.0) * 100 / 5) * 5
    return f"{pct:+d}%"


class EdgeTTS:
    id = EDGE_TTS
    format = MP3
    mime = "audio/mpeg"
    sample_rate = TTS_SAMPLE_RATE  # edge-tts 默认输出 audio-24khz-48kbitrate-mono-mp3
    cache_scope = EDGE_TTS

    def resolve_voice(self, lang: str | None, voice: str | None, gender: str | None) -> str:
        return voice or edge_voice(lang, gender)

    async def stream(self, text: str, voice: str, rate: float = 1.0) -> AsyncIterator[bytes]:
        import edge_tts

        timeout = get_settings().edge_tts_timeout_seconds
        async with _edge_slot():
            comm = edge_tts.Communicate(
                text, voice, rate=edge_rate(rate), connect_timeout=int(timeout), receive_timeout=int(timeout)
            )
            try:
                async for chunk in comm.stream():
                    if chunk.get("type") == "audio" and chunk.get("data"):
                        yield chunk["data"]
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - edge-tts / aiohttp 的各类异常统一归为合成失败
                log.info("edge-tts 合成失败 voice=%s: %s", voice, type(e).__name__)
                status = getattr(e, "status", None)
                detail = f"（HTTP {status}）" if isinstance(status, int) else f"（{type(e).__name__}）"
                raise tts_failed(f"Edge 语音合成失败{detail}", status if isinstance(status, int) else None) from None

    async def aclose(self) -> None:
        return None


async def probe_edge_tts() -> tuple[bool, str | None]:
    """探测 Edge 在线语音是否可达（拉取音色列表）。"""
    import edge_tts

    try:
        voices = await asyncio.wait_for(edge_tts.list_voices(), timeout=get_settings().edge_tts_timeout_seconds)
    except Exception as e:  # noqa: BLE001
        log.info("edge-tts 探测失败: %s", type(e).__name__)
        return False, "Edge 在线语音不可达"
    return (True, None) if voices else (False, "Edge 在线语音返回空音色列表")


# ---------------- OpenAI 兼容 /audio/speech ----------------


class OpenAISpeechTTS:
    id = OPENAI_SPEECH
    format = PCM16
    mime = f"audio/L16;rate={TTS_SAMPLE_RATE}"
    sample_rate = TTS_SAMPLE_RATE

    def __init__(self, cfg: ModelConfig, api_key: str, transport: httpx.AsyncBaseTransport | None = None):
        self._cfg = cfg
        self._key = api_key
        self._transport = transport  # 测试注入
        self._client: httpx.AsyncClient | None = None  # 惰性创建，同一实例的多次合成复用连接（keep-alive）
        self.cache_scope = f"{OPENAI_SPEECH}:{cfg.id}:{cfg.updated_at.isoformat()}"

    @property
    def config_id(self) -> int:
        return self._cfg.id

    def resolve_voice(self, lang: str | None, voice: str | None, gender: str | None) -> str:
        return voice or self._cfg.extra.get("voice") or openai_voice(gender)

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            timeout = float(self._cfg.params.get("timeoutSeconds") or REMOTE_TIMEOUT_SECONDS)
            self._client = httpx.AsyncClient(timeout=timeout, transport=self._transport)
        return self._client

    async def stream(self, text: str, voice: str, rate: float = 1.0) -> AsyncIterator[bytes]:
        url = self._cfg.base_url.rstrip("/") + "/audio/speech"
        body: dict = {"model": self._cfg.model_name, "input": text, "voice": voice, "response_format": "pcm"}
        if (r := clamp_rate(rate)) != 1.0:
            body["speed"] = r
        carry = b""
        try:
            async with self._http().stream(
                "POST", url, headers={"Authorization": f"Bearer {self._key}"}, json=body
            ) as resp:
                if resp.status_code != 200:
                    log.info("远程合成失败 config=%s HTTP %s", self._cfg.id, resp.status_code)
                    raise tts_failed(f"语音合成调用失败（HTTP {resp.status_code}）", resp.status_code)
                async for chunk in resp.aiter_bytes():
                    data = carry + chunk
                    cut = len(data) // 2 * 2  # PCM16 按完整采样切分
                    carry = data[cut:]
                    if cut:
                        yield data[:cut]
        except httpx.TimeoutException as e:
            raise tts_failed("语音合成服务超时") from e
        except httpx.HTTPError as e:
            raise tts_failed("语音合成服务不可达") from e

    async def aclose(self) -> None:
        if self._client is not None:
            client, self._client = self._client, None
            await client.aclose()


# ---------------- LRU 缓存 ----------------

CacheKey = tuple[str, str, str, str]  # (cache_scope, voice, rate, text)


class TtsCache:
    def __init__(self, max_size: int):
        self._max = max_size
        self._data: OrderedDict[CacheKey, TtsAudio] = OrderedDict()

    def get(self, key: CacheKey) -> TtsAudio | None:
        hit = self._data.get(key)
        if hit is not None:
            self._data.move_to_end(key)
        return hit

    def put(self, key: CacheKey, audio: TtsAudio) -> None:
        if self._max <= 0:
            return
        self._data[key] = audio
        self._data.move_to_end(key)
        while len(self._data) > self._max:
            self._data.popitem(last=False)

    def clear(self) -> None:
        self._data.clear()

    def __len__(self) -> int:
        return len(self._data)


tts_cache = TtsCache(get_settings().speech_tts_cache_size)


def cache_key(engine: TtsEngine, voice: str, rate: float, text: str) -> CacheKey:
    return (engine.cache_scope, voice, f"{clamp_rate(rate):.2f}", text)


# ---------------- 流式合成（朗读接口） ----------------


@dataclass
class TtsStream:
    """一次流式合成：元信息 + 音频分块迭代器。命中缓存时只有一块。"""

    mime: str
    voice: str
    engine: str
    format: str
    sample_rate: int
    cached: bool
    first_ms: int  # 首包耗时（命中缓存为 0）
    _chunks: AsyncIterator[bytes] = field(repr=False)

    def __aiter__(self) -> AsyncIterator[bytes]:
        return self._chunks

    async def aclose(self) -> None:
        with contextlib.suppress(Exception):
            await self._chunks.aclose()  # type: ignore[attr-defined]


async def open_stream(
    engine: TtsEngine,
    text: str,
    lang: str | None,
    voice: str | None = None,
    gender: str | None = None,
    rate: float = 1.0,
    cache: TtsCache | None = tts_cache,
) -> TtsStream:
    """开始流式合成：返回前已拿到首包，因此首包前的失败以 C0172 抛出（调用方仍能返回错误响应）。

    后续分块边产出边交给调用方，同时累积；完整结束后写入缓存，中途失败不写缓存。
    """
    resolved = engine.resolve_voice(lang, voice, gender)
    key = cache_key(engine, resolved, rate, text)
    meta = {
        "mime": engine.mime,
        "voice": resolved,
        "engine": engine.id,
        "format": engine.format,
        "sample_rate": engine.sample_rate,
    }
    if cache is not None and (hit := cache.get(key)) is not None:
        return TtsStream(**meta, cached=True, first_ms=0, _chunks=_once(hit.data))
    start = time.perf_counter()
    upstream = engine.stream(text, resolved, rate)
    try:
        first = await anext(upstream)
    except StopAsyncIteration:
        raise tts_failed("语音合成未返回音频") from None
    except BaseException:
        with contextlib.suppress(Exception):
            await upstream.aclose()  # type: ignore[attr-defined]
        raise
    first_ms = int((time.perf_counter() - start) * 1000)

    async def chunks() -> AsyncIterator[bytes]:
        parts = [first]
        try:
            yield first
            async for chunk in upstream:
                parts.append(chunk)
                yield chunk
        finally:
            await upstream.aclose()  # type: ignore[attr-defined]
        if cache is not None:  # 只有完整结束才会走到这里
            audio = TtsAudio(
                data=b"".join(parts),
                **meta,
                latency_ms=int((time.perf_counter() - start) * 1000),
            )
            cache.put(key, audio)

    return TtsStream(**meta, cached=False, first_ms=first_ms, _chunks=chunks())


async def _once(data: bytes) -> AsyncIterator[bytes]:
    yield data


async def synthesize(
    engine: TtsEngine,
    text: str,
    lang: str | None,
    voice: str | None = None,
    gender: str | None = None,
    cache: TtsCache | None = tts_cache,
    rate: float = 1.0,
) -> TtsAudio:
    """整段合成（与 open_stream 共用缓存）。"""
    start = time.perf_counter()
    stream = await open_stream(engine, text, lang, voice, gender, rate, cache)
    try:
        data = b"".join([chunk async for chunk in stream])
    finally:
        await stream.aclose()
    return TtsAudio(
        data=data,
        mime=stream.mime,
        voice=stream.voice,
        engine=stream.engine,
        format=stream.format,
        sample_rate=stream.sample_rate,
        latency_ms=0 if stream.cached else int((time.perf_counter() - start) * 1000),
        cached=stream.cached,
    )
