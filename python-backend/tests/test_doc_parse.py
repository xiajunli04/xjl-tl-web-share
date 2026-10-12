"""2.2–2.4：结构化解析（可逆）、行内内容保护、分块与策略分组。"""

import pytest

from app.doc.chunker import chunk_segments, estimate_tokens, plan_groups
from app.doc.parser import BOM, join_segments, parse_document, split_lines
from app.doc.protect import protect, protect_segment, restore
from tests.doc_fakes import fixture_text

# ---------------------------------------------------------------- 2.2 解析


def kinds(segs):
    return [(s.block_type, s.translatable) for s in segs]


@pytest.mark.parametrize("name,fmt", [("k8s-guide.md", "md"), ("short-note.txt", "txt")])
def test_fixtures_roundtrip_byte_exact(name, fmt):
    text = fixture_text(name)
    segs = parse_document(text, fmt)
    assert join_segments(segs).encode("utf-8") == text.encode("utf-8")
    assert [s.seq for s in segs] == list(range(len(segs)))


def test_k8s_guide_block_types():
    text = fixture_text("k8s-guide.md")
    assert "\r\n" in text  # 夹具含 CRLF 段落，必须按二进制读取
    segs = parse_document(text, "md")
    by_type = {}
    for s in segs:
        by_type.setdefault(s.block_type, []).append(s)
    # 标题层级
    assert [(s.level, s.source) for s in by_type["heading"]] == [
        (1, "Kubernetes Deployment Guide"),
        (2, "Core Concepts"),
        (2, "Deploying the Application"),
        (2, "Scaling and Updates"),
    ]
    assert by_type["heading"][1].prefix == "## "
    # 嵌套列表：容器标记在 prefix 中，level 为嵌套深度
    items = by_type["list_item"]
    assert (items[0].prefix, items[0].level) == ("- ", 1)
    assert (items[1].prefix, items[1].level) == ("  - ", 2)
    assert items[1].source.startswith("Every Node runs the `kubelet`")
    assert [i.prefix for i in items[5:8]] == ["1. ", "2. ", "3. "]
    # 引用
    assert by_type["blockquote"][0].prefix == "> "
    # 代码块、HTML 块、分隔线不可翻译
    for t in ("code", "html", "hr"):
        assert by_type[t] and all(not s.translatable for s in by_type[t])
    assert by_type["code"][0].source.startswith("```yaml") and by_type["code"][0].source.endswith("```")
    # 表格：每行一段，分隔符在 prefix/suffix，表头分隔行不可翻译
    rows = by_type["table_row"]
    assert [r.translatable for r in rows] == [True, False, True, True, True]
    assert (rows[2].prefix, rows[2].source, rows[2].suffix) == (
        "| ",
        "Pod | Runs one or more containers | Namespace",
        " |\n",
    )
    assert rows[1].source == "| --- | --- | --- |"
    # CRLF 段落：段内换行留在 source，块间 CRLF 在 suffix
    crlf = next(s for s in segs if s.source.startswith("This paragraph uses Windows"))
    assert crlf.source == "This paragraph uses Windows line endings.\r\nIt spans two lines inside the same paragraph."
    assert crlf.suffix == "\r\n\r\n"
    assert segs[-1].suffix == "\n"  # 文件末尾换行


def test_three_column_table():
    text = "| A | B | C |\n| :-- | :-: | --: |\n| x | y | z |\n| 1 | 2 | 3 |\n"
    segs = parse_document(text, "md")
    assert join_segments(segs) == text
    assert kinds(segs) == [("table_row", True), ("table_row", False), ("table_row", True), ("table_row", True)]
    assert [(s.prefix, s.source, s.suffix) for s in segs if s.translatable][1] == ("| ", "x | y | z", " |\n")


@pytest.mark.parametrize(
    "text",
    [
        "",
        "\n\n",
        "abc",
        "# T\n",
        "## Title ##\n",
        "##\n",
        "Title\n=====\n\ntext",
        "> a\n> b\n",
        "- a\n  - b\n    - c\n\n1. x\n2) y",
        "| a | b |\n|---|---|\n| c \\| d | e |\n",
        "a\r\nb\r\n\r\nc\rd\r",
        "line one\r\nline two\r\n",
        "[ref]: https://example.com\n\nSee [x][ref].\n",
        BOM + "# BOM 标题\n\n正文\n",
        "  indented para  \n",
        "```\nunclosed fence\n",
        "    indented code\n\npara",
        "<div>\nx\n</div>\n\nafter",
        "- \n- a",
        "text\n\n\n",
        "\n\n# 前导空行\n",
        "> - quoted item\n>   continued\n",
        "1. first\n\n   second paragraph\n2. next\n",
        "Term\n---\n\n***\n",
        "中文段落，没有换行",
    ],
)
def test_edge_cases_roundtrip(text):
    for fmt in ("md", "txt"):
        segs = parse_document(text, fmt)
        assert join_segments(segs) == text, (fmt, [s.to_dict() for s in segs])


def test_empty_and_blank_documents():
    assert parse_document("", "md") == []
    segs = parse_document("\n \n", "md")
    assert kinds(segs) == [("blank", False)]


def test_leading_blank_lines_and_bom():
    segs = parse_document(BOM + "\n\n# T\n", "md")
    assert segs[0].block_type == "blank" and segs[0].prefix == BOM
    assert segs[1].source == "T"


def test_atx_closing_and_empty_heading():
    segs = parse_document("## Title ##\n##\n", "md")
    assert (segs[0].prefix, segs[0].source, segs[0].suffix) == ("## ", "Title", " ##\n")
    assert not segs[1].translatable


def test_setext_heading_underline_in_suffix():
    segs = parse_document("Title\n=====\n", "md")
    assert (segs[0].block_type, segs[0].level, segs[0].source, segs[0].suffix) == ("heading", 1, "Title", "\n=====\n")


def test_link_reference_definition_not_translatable():
    segs = parse_document("[ref]: https://example.com\n\ntext\n", "md")
    assert kinds(segs) == [("paragraph", False), ("paragraph", True)]


def test_txt_paragraphs_keep_inner_newlines():
    segs = parse_document("a\nb\n\n\nc\n", "txt")
    assert [(s.source, s.suffix) for s in segs] == [("a\nb", "\n\n\n"), ("c", "\n")]


def test_split_lines_matches_markdown_it_newlines():
    assert split_lines("a\r\nb\rc\nd") == ["a\r\n", "b\r", "c\n", "d"]
    assert split_lines("a b") == ["a b"]


# ---------------------------------------------------------------- 2.3 保护


def test_link_and_inline_code_are_protected():
    src = "Run `npm install` and see [the docs](https://example.com/docs)."
    p = protect(src)
    assert p.spans == ["`npm install`", "](https://example.com/docs)"]
    assert p.text == "Run ⟦0⟧ and see [the docs⟦1⟧."
    translated = "运行 ⟦0⟧，并参阅[文档⟦1⟧。"
    r = restore(translated, p.spans)
    assert r.ok
    assert r.text == "运行 `npm install`，并参阅[文档](https://example.com/docs)。"


def test_protect_url_placeholder_html_image():
    src = (
        "Hello {name}, %d nodes; {{count}} ${var} {0} at https://dashboard.example.com. "
        "<b>bold</b> ![logo](img.png) <https://x.io> mail me@example.com 50% discount"
    )
    p = protect(src)
    assert "https://dashboard.example.com" in p.spans  # 结尾句号不属于 URL
    for span in (
        "{name}",
        "%d",
        "{{count}}",
        "${var}",
        "{0}",
        "<b>",
        "</b>",
        "![logo](img.png)",
        "<https://x.io>",
        "me@example.com",
    ):
        assert span in p.spans, span
    assert "50% discount" in p.text  # 百分号不是占位符
    assert restore(p.text, p.spans).text == src


def test_protect_table_pipes_and_quote_markers():
    seg = protect_segment("Pod | Runs one | Namespace", "table_row")
    assert seg.text.count("⟦") == 2
    assert restore(seg.text, seg.spans).text == "Pod | Runs one | Namespace"
    q = protect_segment("first line\n> second line", "blockquote", "> ")
    assert q.spans == ["> "]
    assert restore(q.text, q.spans).text == "first line\n> second line"


def test_existing_mark_characters_are_escaped():
    p = protect("literal ⟦0⟧ text")
    assert restore(p.text, p.spans).text == "literal ⟦0⟧ text"


def test_restore_detects_missing_duplicate_unknown():
    spans = ["`a`", "`b`"]
    missing = restore("只有 ⟦0⟧", spans)
    assert not missing.ok and missing.missing == [1]
    dup = restore("⟦0⟧ ⟦0⟧ ⟦1⟧", spans)
    assert not dup.ok and dup.duplicated == [0]
    unknown = restore("⟦0⟧ ⟦1⟧ ⟦7⟧", spans)
    assert not unknown.ok and unknown.unknown == [7]
    assert "缺失标记" in missing.problem
    tolerant = restore("⟦ 0 ⟧ 和 ⟦1⟧", spans)  # 模型在标记内加空格也能识别
    assert tolerant.ok and tolerant.text == "`a` 和 `b`"


# ---------------------------------------------------------------- 2.4 分块


def test_estimate_tokens():
    assert estimate_tokens("") == 0
    assert estimate_tokens("abcd") == 1
    assert estimate_tokens("中文字") == 3
    assert estimate_tokens("中文ab") == 3


def _section(title: str, paragraphs: int, words: int) -> str:
    para = " ".join(["word"] * words)
    return f"## {title}\n\n" + "\n\n".join(para for _ in range(paragraphs)) + "\n\n"


def test_chunks_do_not_cross_h2_sections():
    # 两章，每章约 1000 token（每段 200 词 × 5 字符 / 4 ≈ 250 token，4 段）
    text = _section("One", 4, 200) + _section("Two", 4, 200)
    segs = parse_document(text, "md")
    chunks = chunk_segments(segs)
    assert len(chunks) >= 2
    seg_section = {}
    section = -1
    for s in segs:
        if s.block_type == "heading":
            section += 1
        seg_section[s.seq] = section
    for c in chunks:
        assert len({seg_section[q] for q in c.seg_seqs}) == 1
    assert [c.group for c in chunks] == [0, 1]


def test_target_and_max_tokens_and_oversized_paragraph():
    long_para = " ".join(["word"] * 3000)  # ≈ 3750 token，超过上限，单独成块
    text = "## A\n\n" + "\n\n".join(" ".join(["w"] * 400) for _ in range(6)) + "\n\n" + long_para + "\n\nshort\n"
    segs = parse_document(text, "md")
    chunks = chunk_segments(segs, target_tokens=500, max_tokens=900)
    big = next(c for c in chunks if any(segs[q].source == long_para for q in c.seg_seqs))
    assert [segs[q].source for q in big.seg_seqs if segs[q].translatable] == [long_para]
    for c in chunks:
        if c is not big:
            assert c.tokens <= 900
    assert join_segments([segs[q] for c in chunks for q in c.seg_seqs]) == text  # 块覆盖全部段落且有序


def test_untranslatable_only_chunk():
    segs = parse_document("## A\n\ntext\n\n## B\n\n```\ncode\n```\n", "md")
    chunks = chunk_segments(segs)
    assert [c.translatable for c in chunks] == [True, True]  # 标题本身可翻译
    segs2 = parse_document("```\ncode\n```\n\n---\n", "md")
    assert [c.translatable for c in chunk_segments(segs2)] == [False]


def test_k8s_fixture_chunks():
    segs = parse_document(fixture_text("k8s-guide.md"), "md")
    chunks = chunk_segments(segs)
    assert len(chunks) == 4  # 按二级标题切成 4 块
    assert [c.group for c in chunks] == [0, 1, 2, 3]
    heads = [segs[c.seg_seqs[0]].source for c in chunks]
    assert heads == ["Kubernetes Deployment Guide", "Core Concepts", "Deploying the Application", "Scaling and Updates"]
    assert sorted(q for c in chunks for q in c.seg_seqs) == list(range(len(segs)))


def test_sample_document_groups():
    text = "# GPU Basics\n\nA GPU accelerates training.\n\n## Usage\n\nUse the GPU for each epoch.\n"
    chunks = chunk_segments(parse_document(text, "md"))
    assert [c.to_event() for c in chunks] == [
        {"index": 0, "segSeqs": [0, 1], "group": 0},
        {"index": 1, "segSeqs": [2, 3], "group": 1},
    ]


def test_plan_groups_three_strategies():
    text = "".join(f"## S{i}\n\n" + "\n\n".join(" ".join(["w"] * 300) for _ in range(3)) + "\n\n" for i in range(3))
    chunks = chunk_segments(parse_document(text, "md"), target_tokens=150, max_tokens=300)
    assert len(chunks) == 9 and [c.group for c in chunks] == [0, 0, 0, 1, 1, 1, 2, 2, 2]
    assert plan_groups(chunks, "serial") == [list(range(9))]
    assert plan_groups(chunks, "parallel") == [[i] for i in range(9)]
    assert plan_groups(chunks, "hybrid") == [[0, 1, 2], [3, 4, 5], [6, 7, 8]]
    assert plan_groups([], "serial") == []
