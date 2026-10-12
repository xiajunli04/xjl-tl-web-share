"""测试集公共工具：带重试的下载、sha256、manifest 读写。"""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

import httpx

from eval.config import DATA_DIR, EVAL_ROOT

CACHE_DIR = EVAL_ROOT / ".cache"
MANIFEST_PATH = DATA_DIR / "manifest.json"


class DownloadError(RuntimeError):
    pass


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def download(url: str, dest: Path, *, attempts: int = 4, timeout: float = 120.0) -> Path:
    """下载到 dest（先写临时文件再改名）；网络抖动时重试，最终失败抛出 DownloadError。"""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    last: Exception | None = None
    for i in range(attempts):
        try:
            with httpx.stream("GET", url, timeout=timeout, follow_redirects=True) as resp:
                resp.raise_for_status()
                with tmp.open("wb") as f:
                    for chunk in resp.iter_bytes(1 << 16):
                        f.write(chunk)
            tmp.replace(dest)
            return dest
        except (httpx.HTTPError, OSError) as e:
            last = e
            time.sleep(2 * (i + 1))
    tmp.unlink(missing_ok=True)
    raise DownloadError(f"下载失败：{url}（{last}）")


def fetch_cached(url: str, dest: Path) -> bytes:
    """有缓存直接读，否则下载。"""
    if not dest.exists():
        download(url, dest)
    return dest.read_bytes()


def load_manifest() -> dict:
    if MANIFEST_PATH.exists():
        return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    return {}


def update_manifest(section: str, value: dict) -> None:
    """按小节更新 manifest（k8s / flores / lid 各自维护自己的小节，互不覆盖）。"""
    manifest = load_manifest()
    manifest[section] = value
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
