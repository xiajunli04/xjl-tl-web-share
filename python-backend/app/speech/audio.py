"""音频格式工具：WAV 解析与编码、PCM16 与 float32 互转。"""

import io
import wave

import numpy as np

from app.core.errors import BizException, ErrorCode
from app.speech.vad import SAMPLE_RATE, resample


def pcm16_to_float(pcm: bytes) -> np.ndarray:
    """PCM16LE 字节 → float32（-1..1）；奇数字节丢弃最后一个字节。"""
    return np.frombuffer(pcm[: len(pcm) // 2 * 2], dtype="<i2").astype(np.float32) / 32768


def float_to_pcm16(samples: np.ndarray) -> bytes:
    return (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()


def encode_wav(samples: np.ndarray, rate: int = SAMPLE_RATE) -> bytes:
    """float32 单声道 → WAV（PCM16）。"""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(float_to_pcm16(samples))
    return buf.getvalue()


def decode_wav(data: bytes, max_seconds: float | None = None) -> np.ndarray:
    """WAV（PCM16，任意声道与采样率）→ 16 kHz 单声道 float32。

    空音频、非 PCM16 WAV、超过 max_seconds 时抛出 A0454。
    """
    if not data:
        raise BizException(ErrorCode.AUDIO_INVALID, "音频为空")
    try:
        with wave.open(io.BytesIO(data)) as w:
            channels, width, rate, frames = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
            raw = w.readframes(frames)
    except (wave.Error, EOFError) as e:
        raise BizException(ErrorCode.AUDIO_INVALID, "音频格式不支持，请上传 PCM16 WAV") from e
    if width != 2 or channels < 1 or rate <= 0:
        raise BizException(ErrorCode.AUDIO_INVALID, "音频格式不支持，请上传 16 位 PCM WAV")
    if frames == 0 or not raw:
        raise BizException(ErrorCode.AUDIO_INVALID, "音频为空")
    seconds = frames / rate
    if max_seconds is not None and seconds > max_seconds:
        raise BizException(ErrorCode.AUDIO_INVALID, f"音频时长 {seconds:.1f} 秒，超过上限 {max_seconds:g} 秒")
    x = pcm16_to_float(raw)
    if channels > 1:
        x = x[: len(x) // channels * channels].reshape(-1, channels).mean(axis=1)
    return resample(x, rate, SAMPLE_RATE)


def duration_ms(samples: np.ndarray, rate: int = SAMPLE_RATE) -> int:
    return len(samples) * 1000 // rate
