"""add-session-context-and-memory 2.1–2.3：embedding 提供方、翻译记忆仓储（PG 测试库）与 /internal/tm/* 接口。

单元测试不下载模型：LocalEmbedding 用假工厂，仓储与接口用 tests.fakes.FakeEmbedding（确定性向量）。
"""

import asyncio

import pytest

from app.core.config import get_settings
from app.core.db import Database
from app.core.errors import BizException
from app.memory import embedding as embedding_mod
from app.memory.embedding import EMBEDDING_DIM, EmbeddingUnavailable, LocalEmbedding, normalize
from app.memory.tm import (
    MAX_BATCH,
    TmEntryIn,
    TranslationMemory,
    fuzzy_ratio,
    normalize_text,
    plain_text,
    source_hash,
)
from tests.conftest import INTERNAL_TOKEN
from tests.fakes import FakeEmbedding

# ---------------------------------------------------------------- 规范化与匹配度


def test_normalize_and_hash():
    assert normalize_text("  Restart   the\tPod. ") == "restart the pod."
    assert normalize_text("Ärger ÜBER Straße") == "ärger über straße"  # 拉丁扩展字母也小写化
    assert normalize_text("Ωμέγα 重启") == "Ωμέγα 重启"  # 非拉丁字母保持原样
    # 文档段落原文带行内 Markdown 时，与工作台纯文本规范化为同一结果（hash 相同）
    assert normalize_text("Restart the `Pod` after **updating** the [ConfigMap](cm.md).") == normalize_text(
        "Restart the Pod after updating the ConfigMap."
    )
    assert source_hash("abc") == "900150983cd24fb0d6963f7d28e17f72" and len(source_hash("x")) == 32
    assert fuzzy_ratio("same", "same") == 1.0
    a = normalize_text("Restart the Pod after updating the ConfigMap.")
    b = normalize_text("Restart the Pod after updating the Secret.")
    assert 0.75 < fuzzy_ratio(a, b) < 0.9


def test_plain_text_strips_inline_markdown():
    assert plain_text("Use **kubectl** and `apply` see [docs](https://x.io) ~~old~~ *now*") == (
        "Use kubectl and apply see docs old now"
    )
    assert plain_text("snake_case_name stays") == "snake_case_name stays"
    assert plain_text("_emph_ word") == "emph word"


# ---------------------------------------------------------------- LocalEmbedding（假工厂）


class FakeModel:
    def __init__(self, dim: int = EMBEDDING_DIM, fail_embed: bool = False):
        self.dim = dim
        self.fail_embed = fail_embed
        self.calls = 0

    def embed(self, texts):
        self.calls += 1
        if self.fail_embed and self.calls > 1:
            raise RuntimeError("onnx boom")
        for i, _ in enumerate(texts):
            yield [float(i + 1)] * self.dim


def _settings(**kw):
    return get_settings().model_copy(update=kw)


async def test_local_embedding_lazy_load_dim_and_normalize():
    built = []

    def factory(settings):
        built.append(settings.tm_embedding_model)
        return FakeModel()

    emb = LocalEmbedding(_settings(), factory)
    assert emb.status == "idle" and not emb.available
    vecs = await emb.embed(["a", "b"])  # 懒加载：首次调用时加载
    assert len(built) == 1 and emb.status == "ready" and emb.available
    assert len(vecs) == 2 and all(len(v) == EMBEDDING_DIM for v in vecs)
    assert abs(sum(x * x for x in vecs[1]) - 1.0) < 1e-6  # L2 归一化
    assert await emb.embed([]) == []
    assert await emb.warmup() is True and len(built) == 1  # 已就绪不重复加载
    assert emb.start_warmup() is None


async def test_local_embedding_failure_degrades_and_retries_after_interval():
    attempts = []

    def factory(settings):
        attempts.append(1)
        raise OSError("download failed")

    emb = LocalEmbedding(_settings(tm_retry_seconds=3600), factory)
    assert await emb.warmup() is False
    assert emb.status == "failed" and "download failed" in emb.error
    with pytest.raises(EmbeddingUnavailable):
        await emb.embed(["x"])
    with pytest.raises(EmbeddingUnavailable):
        await emb.embed(["x"], wait=False)
    assert len(attempts) == 1  # 重试间隔内不再加载
    emb._settings = _settings(tm_retry_seconds=0)
    assert await emb.warmup() is False and len(attempts) == 2


async def test_local_embedding_wrong_dim_and_encode_failure():
    emb = LocalEmbedding(_settings(), lambda s: FakeModel(dim=8))
    assert await emb.warmup() is False and "维度" in emb.error
    emb2 = LocalEmbedding(_settings(), lambda s: FakeModel(fail_embed=True))
    assert await emb2.warmup() is True
    with pytest.raises(EmbeddingUnavailable, match="编码失败"):
        await emb2.embed(["x"])


async def test_local_embedding_not_ready_without_wait_triggers_background_load():
    gate = asyncio.Event()

    def factory(settings):
        return FakeModel()

    emb = LocalEmbedding(_settings(), factory)
    with pytest.raises(EmbeddingUnavailable, match="尚未就绪"):
        await emb.embed(["x"], wait=False)
    task = emb._warmup_task
    assert task is not None
    await task
    assert emb.available
    gate.set()


async def test_local_embedding_wait_timeout_and_close():
    import threading

    release = threading.Event()

    def factory(settings):
        release.wait(5)
        return FakeModel()

    emb = LocalEmbedding(_settings(tm_write_wait_seconds=0.05), factory)
    emb.start_warmup()
    await asyncio.sleep(0.01)
    assert emb.status == "loading"
    with pytest.raises(EmbeddingUnavailable):
        await emb.embed(["x"])
    await emb.close()
    release.set()


async def test_local_embedding_disabled():
    emb = LocalEmbedding(_settings(tm_enabled=False), lambda s: FakeModel())
    assert emb.status == "disabled" and not emb.available
    assert await emb.warmup() is False and emb.start_warmup() is None
    with pytest.raises(EmbeddingUnavailable, match="已关闭"):
        await emb.embed(["x"])


def test_default_factory_sets_hf_endpoint(monkeypatch, tmp_path):
    """默认工厂：设置 HF_ENDPOINT 后构建 fastembed 模型（以假类替换，不下载）。"""
    import sys
    import types

    created = {}

    class FakeTextEmbedding:
        def __init__(self, name, cache_dir=None, threads=None):
            created.update(name=name, cache_dir=cache_dir, threads=threads)

    monkeypatch.setitem(sys.modules, "fastembed", types.SimpleNamespace(TextEmbedding=FakeTextEmbedding))
    monkeypatch.delenv("HF_ENDPOINT", raising=False)
    s = _settings(hf_endpoint="https://hf-mirror.com", tm_model_cache_dir=str(tmp_path / "m"))
    embedding_mod._default_factory(s)
    import os

    assert os.environ["HF_ENDPOINT"] == "https://hf-mirror.com"
    assert created == {"name": s.tm_embedding_model, "cache_dir": str(tmp_path / "m"), "threads": 2}
    assert (tmp_path / "m").is_dir()


def test_normalize_zero_vector():
    assert normalize([0.0, 0.0]) == [0.0, 0.0]


# ---------------------------------------------------------------- 仓储（PG 测试库）


@pytest.fixture
async def tm_repo(tm_admin):
    settings = get_settings()
    db = Database(settings)
    await db.open()
    emb = FakeEmbedding()
    try:
        yield TranslationMemory(db, emb, settings), emb, tm_admin
    finally:
        await db.close()


def entry(src: str, tgt: str, **kw) -> TmEntryIn:
    return TmEntryIn(kw.pop("source_lang", "en"), kw.pop("target_lang", "zh"), src, tgt, **kw)


async def test_upsert_overwrites_same_normalized_source(tm_repo):
    tm, _, admin = tm_repo
    assert await tm.upsert(1, [entry("Restart the Pod.", "重启 Pod。")]) == 1
    assert (
        await tm.upsert(1, [entry("  restart   the POD. ", "重启该 Pod。", origin="document", origin_ref="9:5")]) == 1
    )
    rows = admin.execute("select source_text, target_text, origin, origin_ref from ai.translation_memory").fetchall()
    assert rows == [("restart   the POD.", "重启该 Pod。", "document", "9:5")]
    # 同一批内重复：以最后一条为准；空原文跳过
    assert await tm.upsert(1, [entry("A b", "甲"), entry("a  B", "乙"), entry("   ", "空")]) == 1
    assert admin.execute("select target_text from ai.translation_memory where source_norm='a b'").fetchone() == ("乙",)
    assert await tm.upsert(1, [entry(" ", "x")]) == 0


async def test_upsert_limits_and_unavailable(tm_repo):
    tm, emb, _ = tm_repo
    with pytest.raises(BizException) as e:
        await tm.upsert(1, [entry(f"s{i}", "t") for i in range(MAX_BATCH + 1)])
    assert e.value.error.code == "A0410"
    emb.available = False
    with pytest.raises(BizException) as e:
        await tm.upsert(1, [entry("Hello", "你好")])
    assert e.value.error.code == "C0160" and e.value.error.http_status == 503


async def test_search_fuzzy_hit_ranks_first_and_counts_hits(tm_repo):
    tm, _, admin = tm_repo
    await tm.upsert(
        1,
        [
            entry("Restart the Pod after updating the ConfigMap.", "更新 ConfigMap 后重启 Pod。"),
            entry("Delete the namespace.", "删除命名空间。"),
        ],
    )
    result = await tm.search(1, "Restart the Pod after updating the Secret.", "en", "zh")
    assert result.available and len(result.hits) == 1
    hit = result.hits[0]
    assert hit.source.startswith("Restart the Pod") and 0.75 < hit.fuzzy < 0.9 and not hit.exact
    vo = hit.to_vo()
    assert set(vo) == {"id", "source", "target", "fuzzy", "semantic", "origin", "originRef"}
    assert vo["fuzzy"] == round(hit.fuzzy, 4)
    row = admin.execute("select hit_count, last_hit_at from ai.translation_memory where id=%s", (hit.id,)).fetchone()
    assert row[0] == 1 and row[1] is not None
    exact = await tm.search(1, "restart the pod after updating the configmap.", "en", "zh", touch=False)
    assert exact.hits[0].exact and exact.hits[0].fuzzy == 1.0
    assert admin.execute("select hit_count from ai.translation_memory where id=%s", (hit.id,)).fetchone()[0] == 1


async def test_search_semantic_rewrite_hit(tm_repo):
    """语义改写：用确定性假向量构造 semantic≈0.93、fuzzy<0.6 的候选。"""
    tm, emb, _ = tm_repo
    base, query = "How do I get a refund?", "What is the process for getting my money back?"
    emb.set_similar(base, query, 0.93)
    await tm.upsert(1, [entry(base, "我怎样才能退款？"), entry("Unrelated sentence here.", "无关")])
    hits = (await tm.search(1, query, "en", "zh")).hits
    assert len(hits) == 1 and hits[0].source == base
    assert hits[0].semantic >= 0.9 and hits[0].fuzzy < 0.6
    # 语义 0.55：低于缺省阈值 0.65，fuzzy 也不达标，不入选
    emb.set_similar(base, "Could I have a reimbursement please", 0.55)
    assert (await tm.search(1, "Could I have a reimbursement please", "en", "zh")).hits == []


async def test_search_user_and_pair_isolation_and_limit(tm_repo):
    tm, _, _ = tm_repo
    await tm.upsert(2, [entry("Open the door.", "开门。")])
    await tm.upsert(1, [entry("Open the door.", "把门打开。", target_lang="ja")])
    assert (await tm.search(1, "Open the door.", "en", "zh")).hits == []
    await tm.upsert(1, [entry(f"Open the door number {i}.", f"打开 {i} 号门。") for i in range(5)])
    hits = (await tm.search(1, "Open the door number 1.", "en", "zh")).hits
    assert len(hits) == 3 and hits[0].exact  # 默认取前 3 条，完全匹配排第一
    assert len((await tm.search(1, "Open the door number 1.", "en", "zh", limit=5)).hits) == 5


async def test_search_unavailable_returns_empty(tm_repo):
    tm, emb, _ = tm_repo
    await tm.upsert(1, [entry("Hello world", "你好世界")])
    emb.available = False
    result = await tm.search(1, "Hello world", "en", "zh")
    assert result.available is False and result.hits == []
    assert (await tm.search(1, "   ", "en", "zh")).hits == []
    ok, hits = await tm.search_segments(1, [(1, "Hello world")], "en", "zh")
    assert ok is False and hits == {}


async def test_search_segments_best_per_segment_thresholds_and_cap(tm_repo):
    tm, _, admin = tm_repo
    await tm.upsert(1, [entry(f"Configure the cluster node {i} now.", f"立即配置集群节点 {i}。") for i in range(12)])
    segs = [(i + 10, f"Configure the cluster node {i} now.") for i in range(10)] + [(99, "Totally different text.")]
    ok, hits = await tm.search_segments(1, segs, "en", "zh")
    assert ok and len(hits) == 8 and 99 not in hits  # 全块最多 8 条
    assert all(h.exact for h in hits.values())
    assert list(hits) == sorted(hits)
    assert admin.execute("select sum(hit_count) from ai.translation_memory").fetchone()[0] == 8
    # 文档阈值更严格：fuzzy≈0.66 的候选短文本可入选（≥0.6），文档不入选（<0.7）
    await tm.upsert(1, [entry("abcdefghij", "甲")])
    q = "abcdefxyzw"
    assert 0.6 <= fuzzy_ratio(q, "abcdefghij") < 0.7
    assert any(h.source == "abcdefghij" for h in (await tm.search(1, q, "en", "zh")).hits)
    ok, hits = await tm.search_segments(1, [(1, q), (2, "  ")], "en", "zh")
    assert ok and hits == {}
    assert await tm.search_segments(1, [(1, " ")], "en", "zh") == (True, {})


async def test_list_and_delete(tm_repo):
    tm, _, _ = tm_repo
    await tm.upsert(
        1, [entry("Alpha 100%", "阿尔法"), entry("Beta_x", "贝塔"), entry("Gamma", "伽马", target_lang="ja")]
    )
    await tm.upsert(2, [entry("Alpha", "别人的")])
    page = await tm.list_entries(1, page_size=2)
    assert page["total"] == 3 and len(page["records"]) == 2 and page["pageNum"] == 1 and page["pageSize"] == 2
    rec = page["records"][0]
    assert set(rec) == {
        "id",
        "sourceLang",
        "targetLang",
        "sourceText",
        "targetText",
        "origin",
        "originRef",
        "hitCount",
        "lastHitAt",
        "createdAt",
        "updatedAt",
    }
    assert isinstance(rec["createdAt"], str) and rec["lastHitAt"] is None
    assert (await tm.list_entries(1, page_num=2, page_size=2))["records"][0]["sourceText"] == "Alpha 100%"
    assert [r["sourceText"] for r in (await tm.list_entries(1, keyword="100%"))["records"]] == ["Alpha 100%"]
    assert [r["targetText"] for r in (await tm.list_entries(1, keyword="贝"))["records"]] == ["贝塔"]
    assert (await tm.list_entries(1, keyword="Bet_"))["total"] == 0  # 下划线按字面匹配，不是通配符
    assert (await tm.list_entries(1, keyword="a_x"))["total"] == 1
    assert (await tm.list_entries(1, source_lang="en", target_lang="ja"))["total"] == 1
    gid = (await tm.list_entries(1, target_lang="ja"))["records"][0]["id"]
    assert await tm.delete(2, gid) is False  # 不属于该用户
    assert await tm.delete(1, gid) is True and await tm.delete(1, gid) is False


# ---------------------------------------------------------------- /internal/tm/*


@pytest.mark.usefixtures("tm_admin")
async def test_tm_api_write_list_search_delete(client, fake_embedding):
    body = {
        "userId": 1,
        "entries": [
            {
                "sourceLang": "en",
                "targetLang": "zh",
                "sourceText": "Restart the Pod.",
                "targetText": "重启 Pod。",
                "origin": "workbench",
                "originRef": "123",
            },
            {"sourceLang": "en", "targetLang": "zh", "sourceText": "Scale the Deployment.", "targetText": "扩容。"},
        ],
    }
    resp = await client.post("/internal/tm/entries", json=body)
    assert resp.status_code == 200 and resp.json()["data"] == {"written": 2}

    resp = await client.get("/internal/tm/entries", params={"userId": 1, "pageSize": 1, "keyword": "Pod"})
    page = resp.json()["data"]
    assert page["total"] == 1 and page["records"][0]["originRef"] == "123"

    resp = await client.post(
        "/internal/tm/search", json={"userId": 1, "text": "Restart the Pod", "sourceLang": "en", "targetLang": "zh"}
    )
    data = resp.json()["data"]
    assert data["available"] is True and data["hits"][0]["originRef"] == "123"

    entry_id = page["records"][0]["id"]
    assert (await client.delete(f"/internal/tm/entries/{entry_id}", params={"userId": 2})).json()["code"] == "A0404"
    resp = await client.delete(f"/internal/tm/entries/{entry_id}", params={"userId": 1})
    assert resp.json() == {"code": "00000", "message": "成功", "data": None, "traceId": resp.json()["traceId"]}

    fake_embedding.available = False
    resp = await client.post("/internal/tm/entries", json=body)
    assert resp.status_code == 503 and resp.json()["code"] == "C0160"
    resp = await client.post(
        "/internal/tm/search", json={"userId": 1, "text": "Restart", "sourceLang": "en", "targetLang": "zh"}
    )
    assert resp.json()["data"] == {"available": False, "hits": []}


@pytest.mark.usefixtures("tm_admin")
async def test_tm_api_auth_and_validation(app, client):
    import httpx

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as anon:
        assert (await anon.get("/internal/tm/entries", params={"userId": 1})).json()["code"] == "B0100"
        bad = await anon.post("/internal/tm/search", headers={"X-Internal-Token": "wrong"}, json={})
        assert bad.status_code == 401
    assert INTERNAL_TOKEN

    def one(**kw):
        e = {"sourceLang": "en", "targetLang": "zh", "sourceText": "a", "targetText": "b"}
        e.update(kw)
        return {"userId": 1, "entries": [e]}

    cases = [
        ({"userId": 1, "entries": []}, "A0410"),
        ({"userId": 1, "entries": [one()["entries"][0]] * 201}, "A0410"),
        (one(sourceText="x" * 5001), "A0410"),
        (one(sourceText=""), "A0410"),
        (one(origin="other"), "A0410"),
        (one(sourceLang="xx"), "A0420"),
        (one(targetLang="en"), "A0410"),
        (one(sourceText="  "), "A0410"),
    ]
    for payload, code in cases:
        resp = await client.post("/internal/tm/entries", json=payload)
        assert resp.json()["code"] == code, payload
    resp = await client.post(
        "/internal/tm/search", json={"userId": 1, "text": "x", "sourceLang": "en", "targetLang": "zh", "limit": 11}
    )
    assert resp.json()["code"] == "A0410"
    resp = await client.get("/internal/tm/entries", params={"userId": 1, "pageSize": 101})
    assert resp.json()["code"] == "A0410"
