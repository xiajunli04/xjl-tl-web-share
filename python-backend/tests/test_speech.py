"""语音引擎层单测（tasks 3.2–3.4）：ASR、VAD 与重采样、TTS 与缓存、音频工具、默认音色。"""

import json

import httpx
import numpy as np
import pytest
import respx

from app.core.errors import BizException
from app.lang.languages import CODES
from app.speech import tts as tts_mod
from app.speech.asr import LocalSenseVoiceASR, OpenAITranscribeASR, clean_text, normalize_lang
from app.speech.audio import decode_wav, encode_wav
from app.speech.errors import SpeechHttpError
from app.speech.tts import EdgeTTS, OpenAISpeechTTS, TtsCache, synthesize
from app.speech.vad import resample, resample_pcm16
from app.speech.voices import EDGE_VOICES, edge_voice, openai_voice
from tests.speech_fakes import JA_HELLO, MODELS_READY, SAMPLE_ZH, VAD_READY, ZH_LLM, make_wav, model_config, read_wav

needs_models = pytest.mark.skipif(not MODELS_READY, reason="本地语音模型未下载（设置 SPEECH_MODEL_DIR）")
needs_vad = pytest.mark.skipif(not VAD_READY, reason="silero_vad.onnx 未下载（设置 SPEECH_MODEL_DIR）")


# ---------------- 语种与文本 ----------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("yue", "zh"), ("zh", "zh"), ("chinese", "zh"), ("Japanese", "ja"), ("en-US", "en"), ("xx", None), (None, None)],
)
def test_normalize_lang(raw, expected):
    assert normalize_lang(raw) == expected


def test_clean_text_removes_spaces_between_cjk_only():
    assert clean_text(" 今日は いい 天気 で、すね ") == "今日はいい天気で、すね"
    assert clean_text("Hello world") == "Hello world"
    assert clean_text("안녕 하세요") == "안녕 하세요"


# ---------------- 本地 SenseVoice ----------------


@needs_models
@pytest.mark.parametrize(
    ("path", "lang", "fragment"), [(JA_HELLO, "ja", "こんにちは"), (ZH_LLM, "zh", "大模型"), (SAMPLE_ZH, "zh", "你好")]
)
async def test_local_sensevoice_returns_text_and_lang(path, lang, fragment):
    res = await LocalSenseVoiceASR().transcribe(read_wav(path))
    assert fragment in res.text
    assert res.lang == lang
    assert res.engine == "local-sensevoice"
    assert res.duration_ms > 500


@needs_models
async def test_local_sensevoice_long_audio_is_segmented():
    """超过 20 s 的音频按 VAD 分段识别后拼接。"""
    clip = read_wav(ZH_LLM)
    silence = np.zeros(16000, dtype=np.float32)
    audio = np.concatenate([np.concatenate([clip, silence]) for _ in range(8)])  # 约 25 s
    res = await LocalSenseVoiceASR().transcribe(audio)
    assert res.text.count("大模型") >= 6
    assert res.lang == "zh"


def test_local_availability_reason(monkeypatch, tmp_path):
    monkeypatch.setenv("SPEECH_MODEL_DIR", str(tmp_path))
    from app.core.config import get_settings

    get_settings.cache_clear()
    try:
        ok, reason = LocalSenseVoiceASR.availability()
        assert ok is False and "本地识别模型未下载" in reason
    finally:
        get_settings.cache_clear()


# ---------------- 远程转写 ----------------

TRANSCRIBE_URL = "https://speech.test/v1/audio/transcriptions"


@respx.mock
async def test_openai_transcribe_uses_returned_language():
    route = respx.post(TRANSCRIBE_URL).mock(
        return_value=httpx.Response(200, json={"text": "大家好", "language": "chinese", "duration": "1.2"})
    )
    asr = OpenAITranscribeASR(model_config(model_name="whisper-large-v3-turbo"), "sk-asr", detect=lambda t: "en")
    res = await asr.transcribe(read_wav(SAMPLE_ZH), "zh")
    assert (res.text, res.lang, res.engine) == ("大家好", "zh", "openai-transcribe")
    req = route.calls.last.request
    assert req.headers["Authorization"] == "Bearer sk-asr"
    body = req.content
    assert b'name="model"' in body and b"whisper-large-v3-turbo" in body
    assert b'name="language"' in body and b"verbose_json" in body
    assert b"RIFF" in body  # WAV 文件
    client = asr._client
    await asr.transcribe(read_wav(SAMPLE_ZH), "zh")
    assert client is not None and asr._client is client  # 同一实例复用连接
    await asr.aclose()
    assert asr._client is None and client.is_closed


@respx.mock
async def test_openai_transcribe_detects_language_when_missing():
    respx.post(TRANSCRIBE_URL).mock(return_value=httpx.Response(200, json={"text": "Good morning everyone"}))
    detected = []

    def detect(text):
        detected.append(text)
        return "en"

    res = await OpenAITranscribeASR(model_config(), "k", detect=detect).transcribe(read_wav(SAMPLE_ZH))
    assert res.lang == "en"
    assert detected == ["Good morning everyone"]


@respx.mock
async def test_openai_transcribe_http_error():
    respx.post(TRANSCRIBE_URL).mock(return_value=httpx.Response(401, json={"error": "bad key"}))
    with pytest.raises(SpeechHttpError) as ei:
        await OpenAITranscribeASR(model_config(), "k").transcribe(read_wav(SAMPLE_ZH))
    assert ei.value.error.code == "C0173" and ei.value.status == 401


# ---------------- VAD 与重采样 ----------------


@needs_vad
def test_vad_splits_speech_silence_speech():
    from app.speech.vad import VadSegmenter

    clip = read_wav(ZH_LLM)
    silence = np.zeros(16000, dtype=np.float32)
    audio = np.concatenate([silence[:4000], clip, silence, clip, silence])
    vad = VadSegmenter()
    segs = []
    for i in range(0, len(audio), 640):
        segs += vad.accept(audio[i : i + 640])
    segs += vad.flush()
    assert len(segs) == 2
    first, second = segs
    assert first.start_ms < 400 and 1800 < first.duration_ms < 2600
    assert second.start_ms > first.end_ms + 500
    assert abs(second.start_ms - (250 + len(clip) / 16 + 1000)) < 400


@needs_vad
def test_vad_flush_returns_current_segment_and_keeps_offsets():
    from app.speech.vad import VadSegmenter

    clip = read_wav(ZH_LLM)
    vad = VadSegmenter()
    for i in range(0, len(clip), 640):
        vad.accept(clip[i : i + 640])
    assert vad.speaking
    cur = vad.current()
    assert cur is not None and len(cur.samples) > 16000
    first = vad.flush()
    assert len(first) == 1 and not vad.speaking
    # flush 之后继续送音频，偏移相对流开始连续累计
    gap = np.zeros(8000, dtype=np.float32)
    segs = []
    for chunk in (gap, clip, np.zeros(16000, dtype=np.float32)):
        for i in range(0, len(chunk), 640):
            segs += vad.accept(chunk[i : i + 640])
    assert len(segs) == 1
    assert segs[0].start_ms >= len(clip) / 16 + 300


def test_resample_16k_to_24k_length_and_frequency():
    rate_in, rate_out = 16000, 24000
    t = np.arange(rate_in) / rate_in
    x = np.sin(2 * np.pi * 440 * t).astype(np.float32)
    y = resample(x, rate_in, rate_out)
    assert len(y) == rate_out and y.dtype == np.float32
    spectrum = np.abs(np.fft.rfft(y))
    assert abs(np.argmax(spectrum) * rate_out / len(y) - 440) <= 2

    pcm = (x * 20000).astype("<i2").tobytes()
    out = resample_pcm16(pcm, 16000, 24000)
    assert len(out) == len(pcm) * 3 // 2


def test_resample_identity_and_empty():
    x = np.ones(10, dtype=np.float32)
    assert resample(x, 16000, 16000) is x
    assert len(resample(np.zeros(0, dtype=np.float32), 16000, 24000)) == 0


# ---------------- 音频工具 ----------------


def test_decode_wav_downmixes_and_resamples():
    x = decode_wav(make_wav(1.0, rate=8000, channels=2))
    assert len(x) == 16000
    assert 0.25 < float(np.max(np.abs(x))) < 0.35


@pytest.mark.parametrize(
    ("data", "fragment"), [(b"", "为空"), (b"not a wav file at all", "格式不支持"), (make_wav(0.0), "为空")]
)
def test_decode_wav_invalid(data, fragment):
    with pytest.raises(BizException) as ei:
        decode_wav(data)
    assert ei.value.error.code == "A0454" and fragment in ei.value.message


def test_decode_wav_too_long():
    with pytest.raises(BizException) as ei:
        decode_wav(make_wav(61, rate=8000), max_seconds=60)
    assert ei.value.error.code == "A0454" and "超过上限 60 秒" in ei.value.message


def test_encode_decode_roundtrip():
    x = read_wav(SAMPLE_ZH)
    y = decode_wav(encode_wav(x))
    assert len(y) == len(x) and float(np.max(np.abs(x - y))) < 1e-3


# ---------------- 音色 ----------------


def test_default_voice_table_covers_platform_languages():
    assert set(EDGE_VOICES) == set(CODES)
    assert edge_voice("zh") == "zh-CN-XiaoxiaoNeural"
    assert edge_voice("zh", "male") == "zh-CN-YunxiNeural"
    assert edge_voice("en") == "en-US-AvaMultilingualNeural"
    assert edge_voice("xx") == "en-US-AvaMultilingualNeural"
    assert openai_voice("male") == "onyx"


# ---------------- TTS ----------------


class _FakeCommunicate:
    instances: list["_FakeCommunicate"] = []
    error: Exception | None = None

    def __init__(self, text, voice, **kwargs):
        self.text, self.voice, self.kwargs = text, voice, kwargs
        _FakeCommunicate.instances.append(self)

    async def stream(self):
        if _FakeCommunicate.error is not None:
            raise _FakeCommunicate.error
        yield {"type": "WordBoundary", "offset": 0}
        for i in range(3):
            yield {"type": "audio", "data": bytes([i]) * 720}


@pytest.fixture
def fake_edge(monkeypatch):
    import edge_tts

    _FakeCommunicate.instances = []
    _FakeCommunicate.error = None
    monkeypatch.setattr(edge_tts, "Communicate", _FakeCommunicate)
    return _FakeCommunicate


async def test_edge_tts_stream_and_cache(fake_edge):
    cache = TtsCache(4)
    engine = EdgeTTS()
    first = await synthesize(engine, "你好", "zh", gender="male", cache=cache)
    assert first.voice == "zh-CN-YunxiNeural"
    assert first.mime == "audio/mpeg" and first.format == "mp3" and len(first.data) == 2160
    assert first.cached is False
    second = await synthesize(engine, "你好", "zh", gender="male", cache=cache)
    assert second.cached is True and second.data == first.data
    assert len(fake_edge.instances) == 1
    await synthesize(engine, "你好", "zh", voice="zh-CN-XiaoyiNeural", cache=cache)
    assert len(fake_edge.instances) == 2


async def test_edge_tts_failure_maps_to_c0172(fake_edge):
    class Forbidden(Exception):
        status = 403

    fake_edge.error = Forbidden("403")
    with pytest.raises(SpeechHttpError) as ei:
        await synthesize(EdgeTTS(), "hello", "en", cache=None)
    assert ei.value.error.code == "C0172" and "403" in ei.value.message


def test_tts_cache_lru_eviction():
    cache = TtsCache(2)
    audio = tts_mod.TtsAudio(b"x", "audio/mpeg", "v", "edge-tts", "mp3", 24000)
    cache.put(("e", "v", "a"), audio)
    cache.put(("e", "v", "b"), audio)
    assert cache.get(("e", "v", "a")) is not None  # a 变为最近使用
    cache.put(("e", "v", "c"), audio)
    assert cache.get(("e", "v", "b")) is None
    assert cache.get(("e", "v", "a")) is not None and len(cache) == 2


SPEECH_URL = "https://speech.test/v1/audio/speech"


@respx.mock
async def test_openai_speech_tts_pcm():
    pcm = bytes(range(256)) * 40 + b"\x01"  # 奇数长度：最后一个字节不足一个采样被丢弃
    route = respx.post(SPEECH_URL).mock(return_value=httpx.Response(200, content=pcm))
    cfg = model_config(capability="TTS", model_name="tts-1", params={"extra": {"voice": "alloy"}})
    audio = await synthesize(OpenAISpeechTTS(cfg, "sk-tts"), "你好", "zh", cache=None)
    assert audio.mime == "audio/L16;rate=24000" and audio.format == "pcm16" and audio.voice == "alloy"
    assert len(audio.data) == len(pcm) - 1
    body = json.loads(route.calls.last.request.content)
    assert body == {"model": "tts-1", "input": "你好", "voice": "alloy", "response_format": "pcm"}


@respx.mock
async def test_openai_speech_tts_rate_limited():
    respx.post(SPEECH_URL).mock(return_value=httpx.Response(429, json={"error": "busy"}))
    cfg = model_config(capability="TTS", model_name="tts-1")
    with pytest.raises(SpeechHttpError) as ei:
        await synthesize(OpenAISpeechTTS(cfg, "k"), "hi", "en", gender="male", cache=None)
    assert ei.value.error.code == "C0172" and ei.value.status == 429


# ---------------- 语速、连接复用与流式缓存（improve-speech-playback-latency 1.1 / 1.2） ----------------


@pytest.mark.parametrize(
    ("rate", "expected"), [(1.0, "+0%"), (1.2, "+20%"), (0.8, "-20%"), (1.13, "+15%"), (3, "+100%")]
)
def test_edge_rate_mapping(rate, expected):
    assert tts_mod.edge_rate(rate) == expected


async def test_edge_tts_passes_rate(fake_edge):
    await synthesize(EdgeTTS(), "hello", "en", cache=None, rate=1.2)
    assert fake_edge.instances[-1].kwargs["rate"] == "+20%"


@respx.mock
async def test_openai_speech_speed_and_client_reuse():
    route = respx.post(SPEECH_URL).mock(return_value=httpx.Response(200, content=b"\x01\x02" * 100))
    cfg = model_config(capability="TTS", model_name="tts-1")
    engine = OpenAISpeechTTS(cfg, "k")
    await synthesize(engine, "a", "en", cache=None, rate=1.2)
    client = engine._client
    await synthesize(engine, "b", "en", cache=None)
    assert client is not None and engine._client is client  # 同一实例复用连接
    bodies = [json.loads(c.request.content) for c in route.calls]
    assert bodies[0]["speed"] == 1.2 and "speed" not in bodies[1]
    await engine.aclose()
    assert engine._client is None and client.is_closed


class _ChunkTTS:
    """可控的假引擎：按 chunks 逐块产出，fail_at 处抛 C0172。"""

    id, format, mime, sample_rate, cache_scope = "fake", "mp3", "audio/mpeg", 24000, "fake"

    def __init__(self, chunks, fail_at=None):
        self.chunks, self.fail_at, self.calls = chunks, fail_at, 0

    def resolve_voice(self, lang, voice, gender):
        return voice or "v"

    async def stream(self, text, voice, rate=1.0):
        self.calls += 1
        for i, c in enumerate(self.chunks):
            if i == self.fail_at:
                raise tts_mod.tts_failed("boom")
            yield c

    async def aclose(self):
        return None


async def test_open_stream_miss_then_hit():
    cache, engine = TtsCache(4), _ChunkTTS([b"a", b"b", b"c"])
    stream = await tts_mod.open_stream(engine, "hi", "en", cache=cache)
    assert stream.cached is False and stream.format == "mp3"
    got = []
    async for chunk in stream:
        got.append(chunk)
        if len(got) == 1:
            assert len(cache) == 0  # 未结束前不写缓存
    assert got == [b"a", b"b", b"c"] and len(cache) == 1
    hit = await tts_mod.open_stream(engine, "hi", "en", cache=cache)
    assert hit.cached is True and [c async for c in hit] == [b"abc"] and engine.calls == 1
    other_rate = await tts_mod.open_stream(engine, "hi", "en", cache=cache, rate=1.2)
    assert other_rate.cached is False  # 语速属于缓存键
    await other_rate.aclose()


async def test_open_stream_fails_before_first_chunk():
    with pytest.raises(SpeechHttpError) as ei:
        await tts_mod.open_stream(_ChunkTTS([b"a"], fail_at=0), "hi", "en", cache=None)
    assert ei.value.error.code == "C0172"
    with pytest.raises(SpeechHttpError):
        await tts_mod.open_stream(_ChunkTTS([]), "hi", "en", cache=None)  # 空音频


async def test_open_stream_mid_failure_not_cached():
    cache = TtsCache(4)
    stream = await tts_mod.open_stream(_ChunkTTS([b"a", b"b", b"c"], fail_at=2), "hi", "en", cache=cache)
    got = []
    with pytest.raises(SpeechHttpError):
        async for chunk in stream:
            got.append(chunk)
    assert got == [b"a", b"b"] and len(cache) == 0


async def test_open_stream_abandoned_not_cached():
    cache = TtsCache(4)
    stream = await tts_mod.open_stream(_ChunkTTS([b"a", b"b"]), "hi", "en", cache=cache)
    async for _ in stream:
        break
    await stream.aclose()
    assert len(cache) == 0


async def test_edge_concurrency_limit(monkeypatch):
    import asyncio

    import edge_tts

    from app.core.config import get_settings

    monkeypatch.setattr(get_settings(), "edge_tts_max_concurrency", 2)
    active = {"now": 0, "peak": 0}

    class _SlowComm:
        def __init__(self, *a, **kw):
            pass

        async def stream(self):
            active["now"] += 1
            active["peak"] = max(active["peak"], active["now"])
            await asyncio.sleep(0.02)
            yield {"type": "audio", "data": b"x"}
            active["now"] -= 1

    monkeypatch.setattr(edge_tts, "Communicate", _SlowComm)
    tts_mod._edge_slots.clear()
    await asyncio.gather(*(synthesize(EdgeTTS(), f"t{i}", "en", cache=None) for i in range(5)))
    assert active["peak"] == 2
    tts_mod._edge_slots.clear()
