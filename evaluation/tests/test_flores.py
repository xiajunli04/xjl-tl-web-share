"""FLORES：下载失败报错、sha256 校验、抽取的可复现性（用构造的小压缩包，不访问网络）。"""

import io
import json
import tarfile

import pytest

from eval.dataset import flores
from eval.dataset.common import DownloadError, sha256_file


def _make_tarball(path, n=120):
    with tarfile.open(path, "w:gz") as tar:
        for lang, fmt in (("eng_Latn", "Sentence {i}."), ("zho_Hans", "句子{i}。")):
            data = "\n".join(fmt.format(i=i) for i in range(n)).encode("utf-8") + b"\n"
            info = tarfile.TarInfo(f"./flores200_dataset/devtest/{lang}.devtest")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return path


def test_download_failure_raises_with_manual_hint(tmp_path, monkeypatch):
    """规格场景"下载失败"：不静默降级，提示手动放置路径。"""

    def boom(url, dest, **kw):
        raise DownloadError("network down")

    monkeypatch.setattr(flores, "download", boom)
    target = tmp_path / "missing.tar.gz"
    with pytest.raises(flores.FloresUnavailable) as ei:
        flores.ensure_tarball(target)
    assert str(target) in str(ei.value) and "手动" in str(ei.value)


def test_cli_exits_nonzero_on_failure(monkeypatch):
    def fail(*a, **kw):
        raise flores.FloresUnavailable("x")

    monkeypatch.setattr(flores, "build_sentence_pairs", fail)
    with pytest.raises(SystemExit) as ei:
        flores.main()
    assert ei.value.code != 0


def test_sha256_mismatch_rejected(tmp_path):
    tarball = _make_tarball(tmp_path / "f.tar.gz")
    with pytest.raises(flores.FloresUnavailable, match="sha256"):
        flores.ensure_tarball(tarball, expected_sha256="0" * 64)


def test_extract_and_build_is_reproducible(tmp_path, monkeypatch):
    tarball = _make_tarball(tmp_path / "f.tar.gz")
    monkeypatch.setattr(flores, "FLORES_SHA256", sha256_file(tarball))
    monkeypatch.setattr(flores, "ensure_tarball", lambda t=None: tarball)
    monkeypatch.setattr(flores, "update_manifest", lambda *a, **k: None)
    root = flores.ensure_flores(extract_dir=tmp_path / "x")
    assert flores.read_split("eng_Latn", root=root)[3] == "Sentence 3."
    out1, out2 = tmp_path / "a.jsonl", tmp_path / "b.jsonl"
    flores.build_sentence_pairs(root=root, out=out1)
    flores.build_sentence_pairs(root=root, out=out2)
    assert out1.read_bytes() == out2.read_bytes()
    rows = flores.load_sentence_pairs(out1)
    assert len(rows) == 100 and rows[0] == {"id": 0, "source": "Sentence 0.", "reference": "句子0。"}


def test_committed_sentence_file():
    rows = flores.load_sentence_pairs()
    assert len(rows) == 100
    assert [r["id"] for r in rows] == list(range(100))
    assert all(r["source"] and r["reference"] for r in rows)
    manifest = json.loads((flores.DATA_DIR / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["flores"]["tarballSha256"] == flores.FLORES_SHA256
