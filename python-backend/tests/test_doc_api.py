"""4.3：POST /internal/doc/segment/retranslate（无状态单段重译，含保护与可选要求）。"""

import json

import pytest

from tests.doc_fakes import DocFakeLLM, payload_of
from tests.fakes import use_fake_llm

URL = "/internal/doc/segment/retranslate"

pytestmark = pytest.mark.usefixtures("db_admin")


def body(**kw) -> dict:
    base = {
        "taskId": 42,
        "seq": 7,
        "source": "Hello {name}, run `kubectl get pods` before %d minutes.",
        "sourceLang": "en",
        "prevSource": "First, configure kubectl.",
        "prevTarget": "首先，配置 kubectl。",
        "nextSource": "Then check the output.",
        "summary": "本文介绍 Kubernetes 部署。",
        "terms": [{"source": "Pod", "target": "容器组"}],
        "targetLang": "zh",
        "style": "faithful",
        "domain": "计算机",
        "instruction": "更正式",
    }
    base.update(kw)
    return base


def formal(req, payload, n):
    seg = payload["segments"][0]
    return json.dumps({"segments": [{"id": seg["id"], "text": "（正式）" + seg["text"]}]}, ensure_ascii=False)


async def test_retranslate_with_instruction_keeps_placeholders(app, client, monkeypatch):
    fake = DocFakeLLM(handlers={"translate": formal})
    use_fake_llm(app, monkeypatch, fake)
    resp = await client.post(URL, json=body())
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["target"] == "（正式）Hello {name}, run `kubectl get pods` before %d minutes."
    assert data["usage"] == {"promptTokens": 100, "completionTokens": 20}
    assert isinstance(data["latencyMs"], int)
    req = fake.requests("translate")[0]
    user = next(m.content for m in req.messages if m.role == "user")
    system = next(m.content for m in req.messages if m.role == "system")
    assert "## 用户补充要求\n更正式" in user
    assert "原文：First, configure kubectl.\n译文：首先，配置 kubectl。" in user
    assert "下一段原文（仅供参考，不要翻译）：Then check the output." in user
    assert "## 全文摘要\n本文介绍 Kubernetes 部署。" in user
    assert "| Pod | 容器组 |" in system
    sent = payload_of(req)["segments"][0]["text"]
    assert "{name}" not in sent and "`kubectl get pods`" not in sent and "⟦0⟧" in sent  # 发给模型前已替换为标记


async def test_retranslate_retries_once_when_markers_lost(app, client, monkeypatch):
    def lossy(req, payload, n):
        seg = payload["segments"][0]
        text = "丢失了标记" if n == 0 else "译:" + seg["text"]
        return json.dumps({"segments": [{"id": seg["id"], "text": text}]}, ensure_ascii=False)

    fake = DocFakeLLM(handlers={"translate": lossy})
    use_fake_llm(app, monkeypatch, fake)
    resp = await client.post(URL, json=body(instruction=None))
    assert resp.status_code == 200
    assert resp.json()["data"]["target"].startswith("译:Hello {name}")
    assert fake.count("translate") == 2
    assert resp.json()["data"]["usage"]["promptTokens"] == 200


async def test_retranslate_fails_with_c0150(app, client, monkeypatch):
    fake = DocFakeLLM(handlers={"translate": lambda req, p, n: '{"segments": [{"id": 7, "text": "没有标记"}]}'})
    use_fake_llm(app, monkeypatch, fake)
    resp = await client.post(URL, json=body())
    assert resp.status_code == 502
    assert resp.json()["code"] == "C0150"


async def test_retranslate_detects_language_and_protects_table_cells(app, client, monkeypatch):
    fake = DocFakeLLM(handlers={"translate": formal})
    use_fake_llm(app, monkeypatch, fake)
    resp = await client.post(
        URL,
        json=body(
            source="Pod | Runs one or more containers | Namespace",
            sourceLang="auto",
            blockType="table_row",
            instruction=None,
            nextSource=None,
        ),
    )
    assert resp.status_code == 200
    assert resp.json()["data"]["target"] == "（正式）Pod | Runs one or more containers | Namespace"
    sent = payload_of(fake.requests("translate")[0])["segments"][0]["text"]
    assert "|" not in sent
    system = next(m.content for m in fake.requests("translate")[0].messages if m.role == "system")
    assert "英语（en）" in system


async def test_retranslate_accepts_null_optional_fields(app, client, monkeypatch):
    """Spring 发送 D11 的全部字段，未提供的为 null（没有 sourceLang 时自动识别）。"""
    fake = DocFakeLLM(handlers={"translate": formal})
    use_fake_llm(app, monkeypatch, fake)
    payload = {
        "taskId": 42,
        "seq": 3,
        "source": "Scale the Deployment to five replicas.",
        "prevSource": None,
        "prevTarget": None,
        "nextSource": None,
        "summary": None,
        "terms": None,
        "targetLang": "zh",
        "style": None,
        "domain": None,
        "modelConfigId": None,
        "instruction": None,
    }
    resp = await client.post(URL, json=payload)
    assert resp.status_code == 200, resp.text
    assert set(resp.json()["data"]) == {"target", "usage", "latencyMs"}
    user = next(m.content for m in fake.requests("translate")[0].messages if m.role == "user")
    assert "## 上文" not in user and "## 全文摘要" not in user and "## 用户补充要求" not in user


async def test_retranslate_validation(app, client, monkeypatch):
    use_fake_llm(app, monkeypatch, DocFakeLLM())
    resp = await client.post(URL, json=body(source=""))
    assert resp.status_code == 400 and resp.json()["code"] == "A0410"
    resp = await client.post(URL, json=body(targetLang="xx"))
    assert resp.status_code == 400 and resp.json()["code"] == "A0420"
    resp = await client.post(URL, json=body(), headers={"X-Internal-Token": "wrong"})
    assert resp.status_code == 401
