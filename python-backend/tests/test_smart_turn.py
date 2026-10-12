"""Smart Turn 声学句末判定（improve-speech-endpointing-and-live-ux 1.2）。

- 特征提取与官方推理一致：参考值 tests/fixtures/whisper_mel_ref.npy 由
  `uv run --no-project --with transformers --with numpy` 一次性生成（输入为下方固定种子的随机音频，
  先按官方 truncate_audio_to_last_n_seconds 在开头补零到 8 s，再经 WhisperFeatureExtractor）
- 模型已下载时：真实推理返回概率、耗时可接受；整句与半句的判定方向正确（数据集音频）
"""

import time
from pathlib import Path

import numpy as np
import pytest

from app.speech.models import local_model_paths
from app.speech.smart_turn import MAX_SAMPLES, SmartTurnModel, features, load_turn_model, prepare
from tests.speech_fakes import read_wav

REF = Path(__file__).parent / "fixtures" / "whisper_mel_ref.npy"
DATASET = Path(__file__).resolve().parents[2] / "evaluation" / "data" / "speech" / "audio"
MODEL = local_model_paths().smart_turn
needs_model = pytest.mark.skipif(not MODEL.is_file(), reason="Smart Turn 模型未下载")


def reference_input() -> np.ndarray:
    rng = np.random.default_rng(20261006)
    x = (rng.standard_normal(16000 * 3 + 1234) * 0.05).astype(np.float32)
    x[:8000] *= np.sin(np.linspace(0, 40, 8000)).astype(np.float32)
    return x


def test_features_match_whisper_feature_extractor():
    ref = np.load(REF)
    got = features(reference_input())[0]
    assert got.shape == (80, 800)
    assert np.max(np.abs(got - ref)) < 1e-4


def test_prepare_keeps_last_eight_seconds():
    x = np.arange(MAX_SAMPLES + 16000, dtype=np.float32)
    out = prepare(x)
    assert len(out) == MAX_SAMPLES
    short = prepare(np.ones(16000, dtype=np.float32) * 0.5 + np.linspace(0, 1, 16000, dtype=np.float32))
    assert np.allclose(short[: MAX_SAMPLES - 16000], short[0])  # 不足 8 s 在开头补零（归一化后为常数）
    assert abs(short.mean()) < 1e-5


def test_load_turn_model_respects_setting():
    assert load_turn_model("off") is None


def test_default_is_text_rules_only():
    """E6 未达缺省开启标准：缺省不加载声学模型（improve-speech-endpointing-and-live-ux 7.3）。"""
    from app.core.config import Settings

    assert Settings.model_fields["endpoint_smart_turn"].default == "off"


@needs_model
async def test_real_inference_latency_and_direction():
    model = SmartTurnModel(MODEL)
    await model.warmup()
    audio = read_wav(DATASET / "en-01.wav")  # "Thanks for calling. How can I help you today?"
    start = time.perf_counter()
    full = await model.predict(audio)
    elapsed = time.perf_counter() - start
    assert 0.0 <= full <= 1.0
    assert elapsed < 1.0  # 单独运行约 0.1 s；全量测试时 CPU 争用，只防退化
    half = await model.predict(audio[: int(len(audio) * 0.45)])
    print(f"smart-turn full={full:.3f} half={half:.3f} {elapsed * 1000:.0f} ms")
    assert full > half
