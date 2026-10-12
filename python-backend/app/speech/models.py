"""本地语音模型的文件布局（下载命令与识别器共用）。"""

from dataclasses import dataclass
from pathlib import Path

from app.core.config import get_settings

GITHUB = "https://github.com"
RELEASE = f"{GITHUB}/k2-fsa/sherpa-onnx/releases/download/asr-models"

# SenseVoice-small int8（zh/en/ja/ko/yue，自带语种识别）；按顺序尝试，第一个可下载（或已存在）的为准。
# 2024-07-17 为原版多语种模型：实测语种识别与中/英/日/韩识别均正确且带标点；
# 2025-09-09 版偏粤语，对任意语种都输出 <|yue|>，日/韩识别错误，只作为后备。
SENSE_VOICE_ARCHIVES = (
    "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17",
    "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09",
)
SILERO_VAD_FILE = "silero_vad.onnx"
# 声学句末判定模型（improve-speech-endpointing-and-live-ux D2）：pipecat-ai/smart-turn-v3，可选
HUGGINGFACE = "https://huggingface.co"
SMART_TURN_FILE = "smart-turn-v3.2-cpu.onnx"
SMART_TURN_URL = f"{HUGGINGFACE}/pipecat-ai/smart-turn-v3/resolve/main/{SMART_TURN_FILE}"
SMART_TURN_SHA256 = "2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f"
SENSE_VOICE_LANGS = ("zh", "en", "ja", "ko", "yue")


@dataclass(frozen=True)
class LocalModelPaths:
    vad: Path
    sense_voice_model: Path
    sense_voice_tokens: Path
    smart_turn: Path  # 可选，不计入 ready

    @property
    def ready(self) -> bool:
        return self.vad.is_file() and self.sense_voice_model.is_file() and self.sense_voice_tokens.is_file()

    @property
    def missing(self) -> list[str]:
        return [p.name for p in (self.vad, self.sense_voice_model, self.sense_voice_tokens) if not p.is_file()]


def model_dir() -> Path:
    return Path(get_settings().speech_model_dir)


def local_model_paths(base: Path | None = None) -> LocalModelPaths:
    """返回已下载（或应下载到）的模型路径；SenseVoice 取第一个已解压的版本目录。"""
    base = base or model_dir()
    sv_dir = next(
        (base / n for n in SENSE_VOICE_ARCHIVES if (base / n / "model.int8.onnx").is_file()),
        base / SENSE_VOICE_ARCHIVES[0],
    )
    return LocalModelPaths(
        vad=base / SILERO_VAD_FILE,
        sense_voice_model=sv_dir / "model.int8.onnx",
        sense_voice_tokens=sv_dir / "tokens.txt",
        smart_turn=base / SMART_TURN_FILE,
    )


def import_sherpa():
    """导入 sherpa_onnx 并返回模块。

    Windows 11 的 System32 自带 onnxruntime.dll 1.17.1（Windows ML），sherpa-onnx 按名称加载时会绑定到它，
    因 ORT API 版本不足而段错误。导入前先按完整路径加载 onnxruntime 包内的 DLL，使同名模块指向新版。
    """
    import sys

    if sys.platform == "win32" and "sherpa_onnx" not in sys.modules:
        import ctypes
        import os

        import onnxruntime

        ctypes.WinDLL(os.path.join(os.path.dirname(onnxruntime.__file__), "capi", "onnxruntime.dll"))
    import sherpa_onnx

    return sherpa_onnx


def mirrored(url: str) -> str:
    """按镜像改写下载地址：GitHub 用 SPEECH_MODEL_MIRROR（形如 https://ghfast.top/https://github.com），
    HuggingFace 用 SPEECH_HF_MIRROR（形如 https://hf-mirror.com）。"""
    settings = get_settings()
    gh = settings.speech_model_mirror.rstrip("/")
    if gh and url.startswith(GITHUB):
        return url.replace(GITHUB, gh, 1)
    hf = settings.speech_hf_mirror.rstrip("/")
    if hf and url.startswith(HUGGINGFACE):
        return url.replace(HUGGINGFACE, hf, 1)
    return url
