"""金标术语表 `data/k8s/terms.json` 的加载与校验（tasks 2.2）。

校验规则：
  - 每篇 10–20 条；字段齐全，kind 只能是 term / proper_noun
  - 每条源词在英文原文（去掉围栏代码块与行内代码）中按词边界、大小写规则至少出现 2 次
  - 金标译法在中文参考译文中出现（同样去掉代码）

用法：`uv run --no-sync python -m eval.dataset.terms`（校验失败时以非零状态退出并列出问题）
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from eval.config import DATA_DIR
from eval.dataset.common import sha256_bytes, update_manifest
from eval.dataset.k8s import COMMIT, DOCS, K8S_DIR
from eval.metrics.terminology import TermEntry, TermMatcher

TERMS_PATH = K8S_DIR / "terms.json"
MIN_TERMS, MAX_TERMS = 10, 20
MIN_SOURCE_OCCURRENCES = 2

_FENCE = re.compile(r"^[ \t]*```.*?^[ \t]*```[ \t]*$", re.S | re.M)


def strip_fences(text: str) -> str:
    return _FENCE.sub("", text)


def load_terms(path: Path = TERMS_PATH) -> dict[str, list[TermEntry]]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    return {doc: [TermEntry.from_dict(d) for d in items] for doc, items in raw.items()}


def validate(path: Path = TERMS_PATH, k8s_dir: Path = K8S_DIR) -> list[str]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    problems: list[str] = []
    for spec in DOCS:
        items = raw.get(spec.doc_id)
        if not items:
            problems.append(f"{spec.doc_id}: 缺少术语条目")
            continue
        if not MIN_TERMS <= len(items) <= MAX_TERMS:
            problems.append(f"{spec.doc_id}: 条目数 {len(items)} 不在 [{MIN_TERMS}, {MAX_TERMS}] 内")
        for d in items:
            missing = {"source", "target", "variants", "caseSensitive", "kind"} - d.keys()
            if missing:
                problems.append(f"{spec.doc_id}/{d.get('source')}: 缺少字段 {sorted(missing)}")
            if d.get("kind") not in ("term", "proper_noun"):
                problems.append(f"{spec.doc_id}/{d.get('source')}: kind 非法")
        entries = [TermEntry.from_dict(d) for d in items]
        en = strip_fences((k8s_dir / f"{spec.doc_id}.en.md").read_text(encoding="utf-8"))
        zh = strip_fences((k8s_dir / f"{spec.doc_id}.zh.md").read_text(encoding="utf-8"))
        matcher = TermMatcher(entries)
        for e in entries:
            n_en = matcher.count_source(e, en)
            n_zh = matcher.count_rendering(e.target, zh)
            if n_en < MIN_SOURCE_OCCURRENCES:
                problems.append(f"{spec.doc_id}/{e.source}: 英文中只出现 {n_en} 次")
            if n_zh < 1:
                problems.append(f"{spec.doc_id}/{e.source}: 金标译法「{e.target}」未在中文参考中出现")
    return problems


def report(path: Path = TERMS_PATH, k8s_dir: Path = K8S_DIR) -> None:
    """打印每条术语在中英文中的出现次数，便于人工核对。"""
    for doc, entries in load_terms(path).items():
        en = strip_fences((k8s_dir / f"{doc}.en.md").read_text(encoding="utf-8"))
        zh = strip_fences((k8s_dir / f"{doc}.zh.md").read_text(encoding="utf-8"))
        m = TermMatcher(entries)
        print(f"== {doc}（{len(entries)} 条）")
        for e in entries:
            variants = {v: m.count_rendering(v, zh) for v in e.variants}
            n_en, n_zh = m.count_source(e, en), m.count_rendering(e.target, zh)
            print(f"  {e.source!r:<28} en={n_en:<3} {e.target!r} zh={n_zh:<3} {variants}")


def record_manifest(path: Path = TERMS_PATH) -> None:
    """人工整理的金标表同样记录 sha256（依据的文档 commit 与 k8s 小节一致）。"""
    data = path.read_bytes()
    counts = {doc: len(items) for doc, items in json.loads(data).items()}
    update_manifest(
        "k8sTerms",
        {
            "file": path.relative_to(DATA_DIR).as_posix(),
            "origin": "人工整理：依据清洗后的中英文参考译文与 Kubernetes 中文本地化惯例",
            "basedOnCommit": COMMIT,
            "entries": counts,
            "sha256": sha256_bytes(data),
        },
    )


def main() -> None:
    report()
    problems = validate()
    if problems:
        print("\n".join(["校验失败："] + problems))
        sys.exit(1)
    record_manifest()
    print("terms.json 校验通过，已写入 manifest")


if __name__ == "__main__":
    main()
