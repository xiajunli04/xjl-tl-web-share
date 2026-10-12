"""2.4：术语库只读加载与缓存、术语匹配、遵循校验。"""

import pytest

from app.glossary.matcher import (
    GlossaryMatcher,
    TermHit,
    check_compliance,
    select_glossaries,
    term_present,
)
from app.glossary.repository import Glossary, GlossaryRepository, Term


def glossary(gid: int, terms: list[tuple], source_lang="en", target_lang="zh") -> Glossary:
    return Glossary(
        id=gid,
        name=f"g{gid}",
        source_lang=source_lang,
        target_lang=target_lang,
        terms=tuple(
            Term(id=i, glossary_id=gid, source_term=t[0], target_term=t[1], case_sensitive=len(t) > 2 and t[2])
            for i, t in enumerate(terms, 1)
        ),
    )


matcher = GlossaryMatcher()


# ---------------- 术语匹配（glossary 规格 4 个场景） ----------------


def test_longest_match_first():
    g = glossary(1, [("learning", "学习"), ("machine learning", "机器学习")])
    hits = matcher.match("Machine learning is fun", [g])
    assert [h.source for h in hits] == ["machine learning"]
    assert hits[0].spans == [(0, 16)]


def test_word_boundary():
    g = glossary(1, [("GPU", "图形处理器")])
    assert matcher.match("GPUs and eGPU", [g]) == []
    hits = matcher.match("A gpu, a GPU and an eGPU.", [g])
    assert len(hits) == 1 and len(hits[0].spans) == 2  # 默认不区分大小写，eGPU 不命中


def test_cjk_substring():
    g = glossary(1, [("神经网络", "neural network")], source_lang="zh", target_lang="en")
    hits = matcher.match("卷积神经网络很强大", [g])
    assert [h.source for h in hits] == ["神经网络"]
    assert hits[0].spans == [(2, 6)]


def test_language_pair_mismatch_skipped():
    en_zh = glossary(7, [("GPU", "图形处理器")])
    en_ja = glossary(9, [("GPU", "GPU")], target_lang="ja")
    sel = select_glossaries([7, 9, 404], {7: en_zh, 9: en_ja}, "en", "ja")
    assert [g.id for g in sel.usable] == [9]
    assert sel.mismatched == [7]
    assert sel.unavailable == [404]
    assert sel.skipped == [7, 404]


# ---------------- 匹配细节 ----------------


def test_case_sensitive_term():
    g = glossary(1, [("Apple", "苹果公司", True)])
    assert matcher.match("I ate an apple", [g]) == []
    assert len(matcher.match("Apple released a phone", [g])) == 1


def test_covered_span_not_rematched_and_order_by_position():
    g = glossary(1, [("network", "网络"), ("neural network", "神经网络"), ("GPU", "图形处理器")])
    text = "GPU trains a neural network; the network is big"
    hits = matcher.match(text, [g])
    assert [h.source for h in hits] == ["GPU", "neural network", "network"]
    start = text.index("the network") + len("the ")
    assert hits[2].spans == [(start, start + len("network"))]  # 只有独立出现的 network


def test_multiword_term_tolerates_whitespace_and_special_chars():
    g = glossary(1, [("machine learning", "机器学习"), ("C++", "C++"), ("Node.js", "Node.js")])
    hits = matcher.match("machine\n learning with C++ and Node.js", [g])
    assert {h.source for h in hits} == {"machine learning", "C++", "Node.js"}


def test_first_glossary_wins_for_duplicate_terms():
    g1 = glossary(1, [("GPU", "图形处理器")])
    g2 = glossary(2, [("GPU", "显卡")])
    hits = matcher.match("GPU", [g1, g2])
    assert [(h.target, h.glossary_id) for h in hits] == [("图形处理器", 1)]
    assert hits[0].to_event() == {"source": "GPU", "target": "图形处理器", "glossaryId": 1}


# ---------------- 遵循校验 ----------------


def test_compliance_cjk_target():
    hits = [TermHit("GPU", "图形处理器", 1)]
    assert check_compliance(hits, "模型在图形处理器上训练")[0].compliant is True
    result = check_compliance(hits, "模型在显卡上训练")
    assert result[0].to_event() == {"source": "GPU", "target": "图形处理器", "compliant": False}


def test_compliance_latin_target_case_and_boundary():
    hits = [TermHit("机器学习", "machine learning", 1)]
    assert check_compliance(hits, "Machine Learning is everywhere")[0].compliant is True  # 不区分大小写
    assert check_compliance(hits, "machine learnings")[0].compliant is False  # 词边界
    cs = [TermHit("苹果", "Apple", 1, case_sensitive=True)]
    assert check_compliance(cs, "an apple")[0].compliant is False
    assert check_compliance(cs, "Apple Inc.")[0].compliant is True


def test_term_present_blank():
    assert term_present("  ", "anything") is False


# ---------------- 仓库：只读加载与缓存 ----------------


@pytest.fixture
def repo(app) -> GlossaryRepository:
    return app.state.glossary_repo


async def test_repository_load_and_skip_deleted(repo, insert_glossary):
    gid = insert_glossary(terms=[("GPU", "图形处理器"), ("Apple", "苹果公司", True)])
    deleted = insert_glossary(terms=[("x", "y")], deleted=True)
    loaded = await repo.load([gid, deleted, 9999])
    assert list(loaded) == [gid]
    g = loaded[gid]
    assert (g.source_lang, g.target_lang) == ("en", "zh")
    assert [(t.source_term, t.target_term, t.case_sensitive) for t in g.terms] == [
        ("GPU", "图形处理器", False),
        ("Apple", "苹果公司", True),
    ]


async def test_repository_cache_hit_and_invalidation(repo, insert_glossary, db_admin):
    gid = insert_glossary(terms=[("GPU", "图形处理器")])
    first = (await repo.load([gid]))[gid]
    assert (await repo.load([gid]))[gid] is first  # 版本未变，命中缓存

    # 修改术语（未刷新 glossary.updated_at）也能失效
    db_admin.execute(
        "update biz.glossary_term set target_term = '显卡', updated_at = now() + interval '1 second' "
        "where glossary_id = %s",
        (gid,),
    )
    second = (await repo.load([gid]))[gid]
    assert second is not first and second.terms[0].target_term == "显卡"

    # 物理删除术语也能失效
    db_admin.execute("delete from biz.glossary_term where glossary_id = %s", (gid,))
    assert (await repo.load([gid]))[gid].terms == ()


async def test_repository_tl_ai_cannot_write(app, insert_glossary):
    import psycopg

    gid = insert_glossary(terms=[("GPU", "图形处理器")])
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        await app.state.db.fetch_one("update biz.glossary set name = 'x' where id = %s returning id", (gid,))
