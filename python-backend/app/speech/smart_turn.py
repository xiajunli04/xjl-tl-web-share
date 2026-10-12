"""声学句末判定：Pipecat Smart Turn v3（improve-speech-endpointing-and-live-ux D2）。

- 模型：HuggingFace pipecat-ai/smart-turn-v3 的 smart-turn-v3.2-cpu.onnx（int8，约 8.7 MB，BSD-2，支持中文）
- 输入：最后 8 s 的 16 kHz 单声道音频 → Whisper log-mel（80 mel，800 帧）；按官方 inference.py / audio_utils.py：
  不足 8 s 时在**开头**补零，再对整段 8 s 做零均值单位方差归一化；送入的语音段末尾带上 TRAILING_MS 的静音
  （官方配合 Silero stop_secs=0.2 使用，训练数据的句末带短静音）
- 输出：完成概率（sigmoid 之后），≥ 阈值视为说完
- 特征提取为 transformers WhisperFeatureExtractor 的 numpy 移植（避免引入 transformers），一致性见单测
- 推理在线程中执行，独立 onnxruntime 会话（1 线程），与 SenseVoice 互不阻塞；模型缺失或加载失败时 available=False
"""

import asyncio
import logging
import threading
from pathlib import Path
from typing import Any

import numpy as np

from app.speech.vad import SAMPLE_RATE

log = logging.getLogger("app.speech.smart_turn")

N_FFT = 400
HOP = 160
N_MELS = 80
MAX_SECONDS = 8
MAX_SAMPLES = MAX_SECONDS * SAMPLE_RATE
N_FRAMES = MAX_SAMPLES // HOP  # 800
TRAILING_MS = 200


def _hz_to_mel(f: np.ndarray) -> np.ndarray:
    """Slaney 刻度（与 librosa / transformers 一致）。"""
    f = np.asarray(f, dtype=np.float64)
    f_sp, min_log_hz, min_log_mel, logstep = 200.0 / 3, 1000.0, 15.0, np.log(6.4) / 27.0
    mel = f / f_sp
    return np.where(f >= min_log_hz, min_log_mel + np.log(np.maximum(f, 1e-10) / min_log_hz) / logstep, mel)


def _mel_to_hz(m: np.ndarray) -> np.ndarray:
    m = np.asarray(m, dtype=np.float64)
    f_sp, min_log_hz, min_log_mel, logstep = 200.0 / 3, 1000.0, 15.0, np.log(6.4) / 27.0
    return np.where(m >= min_log_mel, min_log_hz * np.exp(logstep * (m - min_log_mel)), f_sp * m)


def mel_filters() -> np.ndarray:
    """(n_freq=201, n_mels=80) 三角滤波器组，slaney 归一化。"""
    fft_freqs = np.linspace(0, SAMPLE_RATE // 2, 1 + N_FFT // 2)
    mel_pts = np.linspace(_hz_to_mel(0.0), _hz_to_mel(SAMPLE_RATE / 2), N_MELS + 2)
    hz_pts = _mel_to_hz(mel_pts)
    diff = np.diff(hz_pts)
    slopes = hz_pts[None, :] - fft_freqs[:, None]
    down = -slopes[:, :-2] / diff[:-1]
    up = slopes[:, 2:] / diff[1:]
    fb = np.maximum(0.0, np.minimum(down, up))
    enorm = 2.0 / (hz_pts[2 : N_MELS + 2] - hz_pts[:N_MELS])
    return fb * enorm[None, :]


_MEL = mel_filters()
_WINDOW = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(N_FFT) / N_FFT)  # 周期 hann


def prepare(audio: np.ndarray) -> np.ndarray:
    """取最后 8 s，不足时在开头补零，再对整段归一化（与官方 truncate_audio_to_last_n_seconds + 特征提取一致）。"""
    x = np.asarray(audio, dtype=np.float32)[-MAX_SAMPLES:]
    out = np.zeros(MAX_SAMPLES, dtype=np.float32)
    out[MAX_SAMPLES - len(x) :] = x
    return (out - out.mean()) / np.sqrt(out.var() + 1e-7)


def log_mel(x: np.ndarray) -> np.ndarray:
    """Whisper log-mel：中心化反射填充 STFT → 功率谱 → mel → log10 → 动态范围 8 → (x+4)/4。返回 (80, 800)。"""
    padded = np.pad(x, N_FFT // 2, mode="reflect")
    n_frames = 1 + (len(padded) - N_FFT) // HOP
    idx = np.arange(N_FFT)[None, :] + HOP * np.arange(n_frames)[:, None]
    frames = padded[idx] * _WINDOW[None, :]
    power = np.abs(np.fft.rfft(frames, n=N_FFT, axis=1)) ** 2  # (frames, 201)
    mel = np.maximum(1e-10, power @ _MEL).T  # (80, frames)
    spec = np.log10(mel)[:, :-1]
    spec = np.maximum(spec, spec.max() - 8.0)
    return ((spec + 4.0) / 4.0).astype(np.float32)


def features(audio: np.ndarray) -> np.ndarray:
    return log_mel(prepare(audio))[None, :, :]


class SmartTurnModel:
    """进程级共享的推理会话；predict 返回完成概率。"""

    _session: Any = None
    _failed = False
    _lock = threading.Lock()

    def __init__(self, path: Path):
        self._path = path

    @property
    def available(self) -> bool:
        return self._path.is_file() and not SmartTurnModel._failed

    def _get(self) -> Any:
        cls = SmartTurnModel
        if cls._session is None:
            with cls._lock:
                if cls._session is None:
                    try:
                        import onnxruntime as ort

                        opts = ort.SessionOptions()
                        opts.intra_op_num_threads = 1
                        opts.inter_op_num_threads = 1
                        opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
                        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
                        cls._session = ort.InferenceSession(
                            str(self._path), sess_options=opts, providers=["CPUExecutionProvider"]
                        )
                        log.info("Smart Turn 模型已加载：%s", self._path)
                    except Exception:
                        cls._failed = True
                        log.warning("Smart Turn 模型加载失败，断句退化为文本规则", exc_info=True)
                        raise
        return cls._session

    def predict_sync(self, audio: np.ndarray) -> float:
        """audio 为只含语音的段（VAD 段已去掉句末静音），这里补上 TRAILING_MS 静音再推理。"""
        session = self._get()
        tail = np.zeros(TRAILING_MS * SAMPLE_RATE // 1000, dtype=np.float32)
        out = session.run(None, {"input_features": features(np.concatenate([audio.astype(np.float32), tail]))})
        return float(np.asarray(out[0]).reshape(-1)[0])

    async def predict(self, audio: np.ndarray) -> float:
        return await asyncio.to_thread(self.predict_sync, audio)

    async def warmup(self) -> None:
        if self.available:
            await self.predict(np.zeros(SAMPLE_RATE, dtype=np.float32))


def load_turn_model(setting: str) -> SmartTurnModel | None:
    """按配置返回模型：off → None；auto / on → 模型（文件缺失时 auto 返回 None，on 记录告警后同样退化）。"""
    from app.speech.models import local_model_paths

    if setting == "off":
        return None
    path = local_model_paths().smart_turn
    if not path.is_file():
        if setting == "on":
            log.warning("已要求启用 Smart Turn，但模型文件不存在：%s（先运行 app.speech.download）", path)
        else:
            log.info("Smart Turn 模型未下载，断句使用文本规则")
        return None
    return SmartTurnModel(path)
