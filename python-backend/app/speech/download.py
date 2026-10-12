"""下载本地语音模型：uv run python -m app.speech.download

- silero_vad.onnx（约 2 MB）
- SenseVoice-small int8（约 230 MB 压缩包，解压后保留 model.int8.onnx 与 tokens.txt）
- 可选：断句判定模型 Smart Turn v3（约 8.7 MB，HuggingFace；失败只告警，不影响退出码）

已存在的文件直接跳过；GitHub 资源支持 SPEECH_MODEL_MIRROR 镜像，HuggingFace 资源支持 SPEECH_HF_MIRROR 镜像。
"""

import hashlib
import sys
import tarfile
import tempfile
from pathlib import Path

import httpx

from app.speech.models import (
    RELEASE,
    SENSE_VOICE_ARCHIVES,
    SILERO_VAD_FILE,
    SMART_TURN_SHA256,
    SMART_TURN_URL,
    local_model_paths,
    mirrored,
    model_dir,
)

KEEP = ("model.int8.onnx", "tokens.txt")


def _fetch(url: str, dest: Path) -> None:
    url = mirrored(url)
    print(f"下载 {url}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    with httpx.stream("GET", url, follow_redirects=True, timeout=httpx.Timeout(30.0, read=120.0)) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length") or 0)
        done = 0
        with open(tmp, "wb") as f:
            for chunk in r.iter_bytes(1 << 20):
                f.write(chunk)
                done += len(chunk)
                if total:
                    print(f"\r  {done / 1e6:6.1f} / {total / 1e6:.1f} MB", end="", flush=True)
    print()
    tmp.replace(dest)


def _extract(archive: Path, base: Path) -> None:
    with tarfile.open(archive, "r:bz2") as tar:
        for m in tar.getmembers():
            if m.isfile() and Path(m.name).name in KEEP:
                m.name = str(Path(Path(m.name).parts[0]) / Path(m.name).name)
                tar.extract(m, base, filter="data")


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download_smart_turn(base: Path) -> bool:
    """下载并校验 Smart Turn 模型；失败只告警（断句退化为文本规则）。"""
    dest = local_model_paths(base).smart_turn
    if dest.is_file() and _sha256(dest) == SMART_TURN_SHA256:
        print(f"断句模型已存在：{dest.name}")
        return True
    try:
        _fetch(SMART_TURN_URL, dest)
        if _sha256(dest) != SMART_TURN_SHA256:
            dest.unlink(missing_ok=True)
            raise ValueError("校验和不一致")
    except (httpx.HTTPError, OSError, ValueError) as e:
        print(
            f"警告：断句模型 Smart Turn 下载失败（{e}）。断句将只使用文本规则；"
            "可设置 SPEECH_HF_MIRROR=https://hf-mirror.com 后重试。",
            file=sys.stderr,
        )
        return False
    print(f"完成：{dest}")
    return True


def download(base: Path | None = None) -> int:
    base = base or model_dir()
    base.mkdir(parents=True, exist_ok=True)
    download_smart_turn(base)
    paths = local_model_paths(base)
    if paths.ready:
        print(f"本地语音模型已存在：{base}")
        return 0

    if not paths.vad.is_file():
        _fetch(f"{RELEASE}/{SILERO_VAD_FILE}", base / SILERO_VAD_FILE)

    if not (paths.sense_voice_model.is_file() and paths.sense_voice_tokens.is_file()):
        last: Exception | None = None
        for name in SENSE_VOICE_ARCHIVES:
            with tempfile.TemporaryDirectory() as tmp:
                archive = Path(tmp) / f"{name}.tar.bz2"
                try:
                    _fetch(f"{RELEASE}/{name}.tar.bz2", archive)
                except httpx.HTTPError as e:
                    print(f"  失败：{e}")
                    last = e
                    continue
                _extract(archive, base)
                break
        else:
            print(f"SenseVoice 模型下载失败：{last}", file=sys.stderr)
            return 1

    paths = local_model_paths(base)
    if not paths.ready:
        print(f"模型文件不完整，缺少：{', '.join(paths.missing)}", file=sys.stderr)
        return 1
    print(f"完成：{paths.sense_voice_model.parent}")
    return 0


if __name__ == "__main__":
    sys.exit(download())
