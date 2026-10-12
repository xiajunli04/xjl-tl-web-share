"""篇章级测试集：清洗规则逐条单测，以及入库数据的完整性检查。"""

import json
import re

import pytest

from eval.config import DATA_DIR
from eval.dataset import k8s
from eval.dataset.common import sha256_bytes
from eval.dataset.terms import load_terms, validate


def test_front_matter_removed_and_title_kept():
    raw = '---\ntitle: Pods\ncontent_type: concept\nweight: 10\n---\n\nBody text.\n'
    assert k8s.clean_markdown(raw, "en") == "# Pods\n\nBody text.\n"


def test_glossary_tooltip_scenario():
    """规格场景"清洗短代码"。"""
    raw = 'a group of {{< glossary_tooltip text="containers" term_id="container" >}}, with storage'
    assert k8s.replace_tooltips(raw, "en") == "a group of containers, with storage"


def test_glossary_tooltip_variants():
    assert k8s.replace_tooltips('{{<glossary_tooltip term_id="node" text="nodes">}}', "en") == "nodes"
    assert k8s.replace_tooltips('{{< glossary_tooltip term_id="namespace" >}}', "zh") == "名字空间"
    assert k8s.replace_tooltips('{{< glossary_tooltip term_id="unknown-x" >}}', "en") == "unknown-x"


def test_chinese_comments_removed():
    """规格场景"去除英文注释"。"""
    raw = (
        "<!--\n_Pods_ are the smallest deployable units of computing ...\n-->\n"
        "**Pod** 是可以在 Kubernetes 中创建和管理的、最小的可部署的计算单元。\n"
    )
    out = k8s.clean_markdown(raw, "zh")
    assert "smallest" not in out and "<!--" not in out
    assert out.startswith("**Pod** 是")


def test_container_shortcodes_keep_content():
    raw = "{{< note >}}\nKeep me.\n{{< /note >}}\n{{% tab name=\"AWS\" %}}\nTab body\n{{% /tab %}}\n"
    assert k8s.remove_container_shortcodes(raw) == "Keep me.\nTab body\n"


def test_line_shortcodes_drop_whole_line():
    raw = (
        "Before\n{{< feature-state for_k8s_version=\"v1.30\" state=\"beta\" >}}\n"
        '{{% code_sample file="pods/simple-pod.yaml" %}}\nRead the {{< api-reference page="core/pod-v1" >}} now.\nAfter'
    )
    assert k8s.remove_line_shortcodes(raw) == "Before\nRead the  now.\nAfter"


def test_value_shortcodes_removed():
    assert k8s.remove_value_shortcodes('api/{{< param "version" >}}/x') == "api//x"


def test_heading_anchor_and_blank_lines():
    raw = "## 什么是 Pod？   {#what-is-a-pod}\n\n\n\nText  \n"
    assert k8s.normalize_whitespace(raw) == "## 什么是 Pod？\n\nText\n"


def test_unknown_shortcode_raises():
    with pytest.raises(ValueError):
        k8s.clean_markdown("{{< mystery thing >}}\n", "en")


def test_cut_at_same_heading_boundary():
    en = "# T\n\n## Intro\n\nA\n\n## Second {#second}\n\nB\n"
    zh = "<!--\n## Intro\n-->\n## 简介\n\n甲\n\n<!--\n## Second {#second}\n\nB\n-->\n## 第二节\n\n乙\n"
    assert "Second" not in k8s.cut_en(en, "Second") and "A" in k8s.cut_en(en, "Second")
    cut = k8s.cut_zh(zh, "second")
    assert "第二节" not in cut and "甲" in cut
    assert k8s.clean_markdown(cut, "zh") == "## 简介\n\n甲\n"


def test_cut_missing_heading_raises():
    with pytest.raises(ValueError):
        k8s.cut_en("## A\n", "B")
    with pytest.raises(ValueError):
        k8s.cut_zh("## B\n", "B")  # 不在注释里的英文标题不算


# ---------------------------------------------------------------- 入库数据


@pytest.mark.parametrize("spec", k8s.DOCS, ids=lambda s: s.doc_id)
def test_committed_documents_are_clean(spec):
    en = (k8s.K8S_DIR / f"{spec.doc_id}.en.md").read_text(encoding="utf-8")
    zh = (k8s.K8S_DIR / f"{spec.doc_id}.zh.md").read_text(encoding="utf-8")
    assert k8s.MIN_EN_CHARS <= len(en) <= k8s.MAX_EN_CHARS
    for text in (en, zh):
        assert "{{" not in text and "<!--" not in text and "-->" not in text
        assert not text.startswith("---")
        assert not re.search(r"\{#[\w.-]+\}", text)
    # 中文页可能缺少英文后来新增的二级标题，但不会多出
    assert 1 <= k8s.h2_count(zh) <= k8s.h2_count(en)


def test_manifest_records_source_commit_and_sha256():
    manifest = json.loads((DATA_DIR / "manifest.json").read_text(encoding="utf-8"))
    files = manifest["k8s"]["files"]
    assert len(files) == 2 * len(k8s.DOCS)
    for f in files:
        assert f["commit"] == k8s.COMMIT and k8s.COMMIT in f["url"]
        data = (DATA_DIR / f["file"]).read_bytes()
        assert sha256_bytes(data) == f["sha256"]


def test_terms_file_valid():
    assert validate() == []
    pod = next(e for e in load_terms()["pods"] if e.source == "Pod")
    assert pod.target == "Pod" and pod.case_sensitive and pod.kind == "term" and pod.variants
