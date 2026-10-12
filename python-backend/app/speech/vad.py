"""Silero VAD 流式切句与重采样工具（design D4）。

- VadSegmenter：按帧送入 16 kHz float32 音频，返回已结束的语音段；进行中的语音段可随时取出做 partial 识别
- split_segments：离线切句（听写接口的长音频分段识别）
- resample：线性插值重采样（16k → 24k 等），numpy 实现，无额外依赖
"""

from dataclasses import dataclass

import numpy as np

from app.core.config import get_settings
from app.speech.models import import_sherpa, local_model_paths

SAMPLE_RATE = 16000
VAD_THRESHOLD = 0.5
VAD_BUFFER_SECONDS = 60


@dataclass
class SpeechSegment:
    start: int  # 相对流开始的采样点偏移
    samples: np.ndarray  # float32，16 kHz

    @property
    def start_ms(self) -> int:
        return self.start * 1000 // SAMPLE_RATE

    @property
    def end_ms(self) -> int:
        return (self.start + len(self.samples)) * 1000 // SAMPLE_RATE

    @property
    def duration_ms(self) -> int:
        return len(self.samples) * 1000 // SAMPLE_RATE


class VadSegmenter:
    """封装 sherpa-onnx VoiceActivityDetector（silero）。非线程安全，每条发言流一个实例。"""

    def __init__(self, min_silence_ms: int | None = None, max_speech_s: float | None = None):
        settings = get_settings()
        paths = local_model_paths()
        if not paths.vad.is_file():
            raise FileNotFoundError(paths.vad)
        so = import_sherpa()
        cfg = so.VadModelConfig()
        cfg.silero_vad.model = str(paths.vad)
        cfg.silero_vad.threshold = VAD_THRESHOLD
        cfg.silero_vad.min_silence_duration = (min_silence_ms or settings.speech_vad_min_silence_ms) / 1000
        cfg.silero_vad.max_speech_duration = max_speech_s or settings.speech_vad_max_speech_s
        cfg.sample_rate = SAMPLE_RATE
        self._cfg = cfg
        self._vad = so.VoiceActivityDetector(cfg, buffer_size_in_seconds=VAD_BUFFER_SECONDS)
        # sherpa 内部的采样计数在 reset 后归零，这里记录 reset 之前已送入的采样数，换算为流内绝对偏移
        self._base = 0
        self._fed = 0

    @property
    def speaking(self) -> bool:
        return self._vad.is_speech_detected()

    def accept(self, samples: np.ndarray) -> list[SpeechSegment]:
        if len(samples):
            self._vad.accept_waveform(samples)
            self._fed += len(samples)
        return self._drain()

    def current(self) -> SpeechSegment | None:
        """进行中的语音段（尚未判定句末）；没有在说话时返回 None。"""
        if not self._vad.is_speech_detected():
            return None
        seg = self._vad.current_segment
        if seg.start < 0 or not len(seg.samples):
            return None
        return SpeechSegment(self._base + seg.start, np.asarray(seg.samples, dtype=np.float32))

    def flush(self) -> list[SpeechSegment]:
        """强制断句：返回缓冲中剩余的语音段，随后重置检测器状态。"""
        self._vad.flush()
        segs = self._drain()
        self._vad.reset()
        self._base += self._fed
        self._fed = 0
        return segs

    def _drain(self) -> list[SpeechSegment]:
        segs = []
        while not self._vad.empty():
            seg = self._vad.front
            segs.append(SpeechSegment(self._base + seg.start, np.asarray(seg.samples, dtype=np.float32)))
            self._vad.pop()
        return segs


def split_segments(samples: np.ndarray, frame: int = 1600) -> list[SpeechSegment]:
    """离线切句：把整段音频按 VAD 切成语音段。"""
    seg = VadSegmenter()
    out: list[SpeechSegment] = []
    for i in range(0, len(samples), frame):
        out += seg.accept(samples[i : i + frame])
    return out + seg.flush()


def resample(samples: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    """线性插值重采样（float32 进出）。语音场景下 16k→24k 的质量足够。"""
    if src_rate == dst_rate or not len(samples):
        return samples.astype(np.float32, copy=False)
    n = round(len(samples) * dst_rate / src_rate)
    x_old = np.arange(len(samples), dtype=np.float64) / src_rate
    x_new = np.arange(n, dtype=np.float64) / dst_rate
    return np.interp(x_new, x_old, samples).astype(np.float32)


def resample_pcm16(pcm: bytes, src_rate: int = 16000, dst_rate: int = 24000) -> bytes:
    """PCM16LE 字节流重采样（默认 16k → 24k，供上行要求 24 kHz 的引擎使用）。"""
    x = np.frombuffer(pcm[: len(pcm) // 2 * 2], dtype="<i2").astype(np.float32) / 32768
    y = resample(x, src_rate, dst_rate)
    return (np.clip(y, -1, 1) * 32767).astype("<i2").tobytes()
