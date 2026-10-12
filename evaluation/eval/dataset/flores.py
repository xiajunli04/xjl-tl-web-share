"""FLORES-200（design D3）：下载、校验、解压，以及句子级 en-zh 100 句的抽取。

可复用接口（语种识别样本生成也用它）：
  - `ensure_flores() -> Path`：返回解压后的 `flores200_dataset` 目录；压缩包缺失时下载，sha256 不符或下载失败时
    抛出 FloresUnavailable（含手动放置路径提示），不静默降级
  - `read_split(lang, split="devtest") -> list[str]`：读取某语种某划分的全部句子

命令行：`uv run --no-sync python -m eval.dataset.flores`（失败时以非零状态退出）
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tarfile
from pathlib import Path

from eval.config import DATA_DIR
from eval.dataset.common import CACHE_DIR, DownloadError, download, sha256_bytes, sha256_file, update_manifest

FLORES_URL = "https://dl.fbaipublicfiles.com/nllb/flores200_dataset.tar.gz"
FLORES_SHA256 = "b8b0b76783024b85797e5cc75064eb83fc5288b41e9654dabc7be6ae944011f6"
TARBALL = CACHE_DIR / "flores200_dataset.tar.gz"
EXTRACT_DIR = CACHE_DIR / "flores200"
FLORES_OUT = DATA_DIR / "flores"
SENTENCE_FILE = FLORES_OUT / "en-zh.100.jsonl"
SENTENCE_COUNT = 100


class FloresUnavailable(RuntimeError):
    pass


def _manual_hint(tarball: Path) -> str:
    return (
        f"请手动下载 {FLORES_URL}，放到 {tarball}（或设置环境变量 FLORES_TARBALL 指向该文件），"
        f"sha256 应为 {FLORES_SHA256}"
    )


def ensure_tarball(tarball: Path | None = None, url: str = FLORES_URL, expected_sha256: str = FLORES_SHA256) -> Path:
    tarball = tarball or Path(os.environ.get("FLORES_TARBALL") or TARBALL)
    if not tarball.exists():
        try:
            download(url, tarball, attempts=3, timeout=300)
        except DownloadError as e:
            raise FloresUnavailable(f"FLORES-200 下载失败：{e}。{_manual_hint(tarball)}") from e
    actual = sha256_file(tarball)
    if actual != expected_sha256:
        raise FloresUnavailable(f"FLORES-200 压缩包 sha256 不符（{actual}）。{_manual_hint(tarball)}")
    return tarball


def ensure_flores(tarball: Path | None = None, extract_dir: Path = EXTRACT_DIR) -> Path:
    """返回解压后的 flores200_dataset 目录（缓存在 evaluation/.cache，不入库）。"""
    root = extract_dir / "flores200_dataset"
    marker = extract_dir / ".complete"
    if marker.exists() and root.is_dir():
        return root
    path = ensure_tarball(tarball)
    if extract_dir.exists():
        shutil.rmtree(extract_dir)
    extract_dir.mkdir(parents=True)
    with tarfile.open(path) as tar:
        tar.extractall(extract_dir, filter="data")
    if not root.is_dir():
        raise FloresUnavailable(f"压缩包中没有 flores200_dataset 目录：{path}")
    marker.write_text(FLORES_SHA256, encoding="utf-8")
    return root


def read_split(lang: str, split: str = "devtest", root: Path | None = None) -> list[str]:
    root = root or ensure_flores()
    path = root / split / f"{lang}.{split}"
    if not path.exists():
        raise FloresUnavailable(f"FLORES-200 中没有 {path.name}")
    return path.read_text(encoding="utf-8").splitlines()


def build_sentence_pairs(
    root: Path | None = None, out: Path = SENTENCE_FILE, n: int = SENTENCE_COUNT
) -> list[dict]:
    en = read_split("eng_Latn", root=root)
    zh = read_split("zho_Hans", root=root)
    if len(en) != len(zh):
        raise FloresUnavailable(f"eng_Latn 与 zho_Hans 句数不一致：{len(en)} / {len(zh)}")
    rows = [{"id": i, "source": en[i], "reference": zh[i]} for i in range(n)]
    out.parent.mkdir(parents=True, exist_ok=True)
    data = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows).encode("utf-8")
    out.write_bytes(data)
    update_manifest(
        "flores",
        {
            "url": FLORES_URL,
            "tarballSha256": FLORES_SHA256,
            "files": [
                {
                    "file": out.relative_to(DATA_DIR).as_posix() if out.is_relative_to(DATA_DIR) else str(out),
                    "split": "devtest",
                    "source": "eng_Latn",
                    "target": "zho_Hans",
                    "lines": f"0-{n - 1}",
                    "sha256": sha256_bytes(data),
                }
            ],
        },
    )
    return rows


def load_sentence_pairs(path: Path = SENTENCE_FILE) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def main() -> None:
    try:
        rows = build_sentence_pairs()
    except FloresUnavailable as e:
        print(str(e), file=sys.stderr)
        sys.exit(2)
    print(f"已写入 {SENTENCE_FILE}（{len(rows)} 句）")


if __name__ == "__main__":
    main()
