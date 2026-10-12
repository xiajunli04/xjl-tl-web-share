"""4.2 / 4.3：POST /internal/image/translate（事件序列、术语命中、空图、OCR 重试与 C0171、C0170、qwen-mt-image）。"""

import base64
import io
import json

import httpx
import pytest
import respx
from PIL import Image

from app.image.qwen_mt_image import DEFAULT_HOST, SYNTHESIS_PATH
from tests.fakes import parse_sse
from tests.image_fakes import FakeVisionLLM, b64, make_image, use_vision_llm

URL = "/internal/image/translate"
QWEN_URL = DEFAULT_HOST + SYNTHESIS_PATH
RESULT_URL = "http://dashscope-result.oss.test/out.jpg"

pytestmark = pytest.mark.usefixtures("db_admin")

MENU = ["宫保鸡丁", "麻婆豆腐", "鱼香肉丝", "回锅肉", "水煮鱼", "酸辣汤"]
MENU_EN = [
    "Kung Pao Chicken",
    "Mapo Tofu",
    "Yu Xiang Shredded Pork",
    "Twice-cooked Pork",
    "Boiled Fish",
    "Hot Sour Soup",
]


def body(image: bytes | None = None, **kw) -> dict:
    base = {
        "requestId": "img-1",
        "userId": 5,
        "imageBase64": b64(image or make_image(800, 600)),
        "mime": "image/png",
        "sourceLang": "auto",
        "targetLang": "en",
        "engine": "vision",
        "modelConfigId": None,
        "glossaryIds": [],
    }
    base.update(kw)
    return base


def ocr_json(texts=MENU, lang="zh", step=80) -> str:
    # 模型图像 800×600：每行 x 100–300，y 从 50 开始
    blocks = [{"text": t, "bbox": [100, 50 + i * step, 300, 90 + i * step]} for i, t in enumerate(texts)]
    return json.dumps({"lang": lang, "blocks": blocks}, ensure_ascii=False)


def translate_json(texts=MENU_EN) -> str:
    return json.dumps({"translations": [{"id": i + 1, "text": t} for i, t in enumerate(texts)]}, ensure_ascii=False)


def named(events):
    return [e for e in events if e.event]


async def test_full_event_sequence_with_term_hit(app, client, monkeypatch, insert_glossary):
    gid = insert_glossary(source_lang="zh", target_lang="en", terms=[("宫保鸡丁", "Kung Pao Chicken")])
    fake = FakeVisionLLM(ocr=[ocr_json()], translate=[translate_json()])
    use_vision_llm(app, monkeypatch, fake)
    resp = await client.post(URL, json=body(glossaryIds=[gid]))
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    events = named(parse_sse(resp.text))
    seq = [(e.event, e.data.get("node"), e.data.get("status")) for e in events]
    assert seq == [
        ("start", None, None),
        ("node", "ocr", "started"),
        ("node", "ocr", "completed"),
        ("blocks", None, None),
        ("node", "terms", "completed"),
        ("node", "translate", "started"),
        ("node", "translate", "completed"),
        ("translation", None, None),
        ("node", "render", "completed"),
        ("done", None, None),
    ]
    nodes = [e.data for e in events if e.event == "node"]
    assert [n["seq"] for n in nodes] == [1, 2, 3, 4, 5, 6]
    assert nodes[1]["summary"] == "识别到 6 个文本块（中文）"
    assert isinstance(nodes[1]["latencyMs"], int)
    assert nodes[2]["summary"] == "命中 1 条术语"
    assert nodes[4]["summary"] == "已翻译 6 块"
    assert nodes[5]["summary"] == "坐标已归一化"

    blocks_ev = events[3].data
    assert (blocks_ev["width"], blocks_ev["height"], blocks_ev["detectedLang"]) == (800, 600, "zh")
    assert len(blocks_ev["blocks"]) == 6
    assert blocks_ev["blocks"][0] == {"id": 1, "text": "宫保鸡丁", "bbox": [0.125, 0.0833, 0.375, 0.15]}

    translation = events[7].data["blocks"]
    assert [b["translation"] for b in translation] == MENU_EN
    assert set(translation[0]) == {"id", "text", "translation", "bbox"}

    done = events[-1].data
    assert set(done) == {
        "detectedLang",
        "blocks",
        "termHits",
        "trace",
        "usage",
        "latencyMs",
        "modelConfigId",
        "resultImageBase64",
    }
    assert done["detectedLang"] == "zh"
    assert done["termHits"] == [{"source": "宫保鸡丁", "target": "Kung Pao Chicken", "followed": True, "blockIds": [1]}]
    assert [t["node"] for t in done["trace"]] == ["ocr", "terms", "translate", "render"]
    assert done["usage"] == {"promptTokens": 200, "completionTokens": 20}
    assert done["modelConfigId"] == 2
    assert done["resultImageBase64"] is None
    for b in done["blocks"]:
        x0, y0, x1, y1 = b["bbox"]
        assert 0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1

    # OCR 为多模态消息：告知宽高 + data URL；翻译提示词带术语表与整图上下文
    assert fake.kinds() == ["ocr", "translate"]
    ocr_user = fake.calls[0][1].messages[1].content
    assert "宽 800 像素、高 600 像素" in ocr_user[0]["text"]
    assert ocr_user[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")
    assert fake.calls[0][1].extra == {}  # FakeVisionLLM 不是 OpenAI 客户端，不加 response_format
    tr = fake.calls[1][1].messages
    assert "| 宫保鸡丁 | Kung Pao Chicken |" in tr[0].content
    assert json.loads(tr[1].content)["blocks"][5] == {"id": 6, "text": "酸辣汤"}


async def test_term_not_followed_is_reported(app, client, monkeypatch, insert_glossary):
    gid = insert_glossary(source_lang="zh", target_lang="en", terms=[("宫保鸡丁", "Kung Pao Chicken")])
    texts = ["Gongbao Chicken", *MENU_EN[1:]]
    fake = FakeVisionLLM(ocr=[ocr_json()], translate=[translate_json(texts)])
    use_vision_llm(app, monkeypatch, fake)
    events = named(parse_sse((await client.post(URL, json=body(glossaryIds=[gid]))).text))
    assert events[-1].data["termHits"][0]["followed"] is False


async def test_downscaled_image_bbox_restored(app, client, monkeypatch):
    # 原图 4096×2048 → 模型图 2048×1024；模型坐标 (512,256)-(1024,512) → 归一化 (0.25,0.25)-(0.5,0.5)
    ocr = json.dumps({"lang": "en", "blocks": [{"text": "OPEN", "bbox": [512, 256, 1024, 512]}]})
    fake = FakeVisionLLM(ocr=[ocr], translate=['{"translations":[{"id":1,"text":"营业中"}]}'])
    use_vision_llm(app, monkeypatch, fake)
    events = named(parse_sse((await client.post(URL, json=body(make_image(4096, 2048), targetLang="zh"))).text))
    blocks_ev = next(e.data for e in events if e.event == "blocks")
    assert (blocks_ev["width"], blocks_ev["height"]) == (4096, 2048)
    assert blocks_ev["blocks"][0]["bbox"] == [0.25, 0.25, 0.5, 0.5]
    assert "宽 2048 像素、高 1024 像素" in fake.calls[0][1].messages[1].content[0]["text"]


async def test_image_without_text_finishes_with_empty_blocks(app, client, monkeypatch):
    fake = FakeVisionLLM(ocr=['{"lang": null, "blocks": []}'])
    use_vision_llm(app, monkeypatch, fake)
    resp = await client.post(URL, json=body())
    events = named(parse_sse(resp.text))
    assert [e.event for e in events] == ["start", "node", "node", "blocks", "node", "node", "node", "done"]
    ocr_done = events[2].data
    assert ocr_done["summary"] == "未识别到文字"
    assert events[3].data["blocks"] == [] and events[3].data["detectedLang"] is None
    assert [(e.data["node"], e.data["status"]) for e in events[4:7]] == [
        ("terms", "skipped"),
        ("translate", "skipped"),
        ("render", "skipped"),
    ]
    done = events[-1].data
    assert done["blocks"] == [] and done["termHits"] == []
    assert fake.kinds() == ["ocr"]  # 不调用翻译


async def test_ocr_invalid_json_retried_once(app, client, monkeypatch):
    fake = FakeVisionLLM(ocr=["抱歉，我无法输出 JSON", ocr_json(MENU[:2])], translate=[translate_json(MENU_EN[:2])])
    use_vision_llm(app, monkeypatch, fake)
    events = named(parse_sse((await client.post(URL, json=body())).text))
    assert events[-1].event == "done"
    assert fake.kinds() == ["ocr", "ocr", "translate"]
    assert events[-1].data["usage"] == {"promptTokens": 300, "completionTokens": 30}


async def test_ocr_invalid_json_twice_returns_c0171(app, client, monkeypatch):
    fake = FakeVisionLLM(ocr=["not json", '{"blocks": "oops"}'])
    use_vision_llm(app, monkeypatch, fake)
    events = named(parse_sse((await client.post(URL, json=body())).text))
    assert [e.event for e in events] == ["start", "node", "error"]
    assert events[-1].data == {"code": "C0171", "message": "OCR 结果解析失败"}
    assert fake.kinds() == ["ocr", "ocr"]


async def test_invalid_blocks_dropped_and_missing_translation_falls_back(app, client, monkeypatch):
    ocr = json.dumps(
        {
            "lang": "zh",
            "blocks": [
                {"text": "宫保鸡丁", "bbox": [100, 50, 300, 90]},
                {"text": "", "bbox": [100, 150, 300, 190]},
                {"text": "坏框", "bbox": [1, 2]},
                {"text": "麻婆豆腐", "bbox": [100, 250, 900, 290]},  # 越界裁剪
            ],
        },
        ensure_ascii=False,
    )
    fake = FakeVisionLLM(ocr=[ocr], translate=['{"translations":[{"id":1,"text":"Kung Pao Chicken"}]}'])
    use_vision_llm(app, monkeypatch, fake)
    events = named(parse_sse((await client.post(URL, json=body())).text))
    done = events[-1].data
    assert [b["id"] for b in done["blocks"]] == [1, 2]
    assert done["blocks"][1]["bbox"][2] == 1.0
    assert done["blocks"][1]["translation"] == "麻婆豆腐"
    tr_node = next(
        e.data for e in events if e.event == "node" and e.data["node"] == "translate" and "summary" in e.data
    )
    assert tr_node["summary"] == "已翻译 1 块，1 块未返回译文（保留原文）"


async def test_non_vision_model_returns_c0170(client, insert_config):
    insert_config(is_default=True, supports_vision=False)
    resp = await client.post(URL, json=body())
    assert resp.status_code == 400
    assert resp.json()["code"] == "C0170"


async def test_default_vision_model_used_when_unspecified(app, client, insert_config, monkeypatch):
    cid = insert_config(is_default=True, supports_vision=True)
    seen = {}

    async def fake_run_vision(req, image, resolved, deps):
        seen["id"] = resolved.config.id
        yield "done", {"modelConfigId": resolved.config.id}

    monkeypatch.setattr("app.api.internal.image.run_vision", fake_run_vision)
    events = named(parse_sse((await client.post(URL, json=body())).text))
    assert seen["id"] == cid and events[-1].data["modelConfigId"] == cid


@pytest.mark.parametrize(
    "patch,code",
    [
        ({"imageBase64": ""}, "A0450"),
        ({"imageBase64": b64(b"garbage")}, "A0450"),
        ({"targetLang": "xx"}, "A0420"),
        ({"sourceLang": "en", "targetLang": "en"}, "A0410"),
        ({"engine": "ocr-only"}, "A0410"),
    ],
)
async def test_request_validation(client, insert_config, patch, code):
    insert_config(is_default=True, supports_vision=True)
    resp = await client.post(URL, json=body(**patch))
    assert resp.status_code == 400
    assert resp.json()["code"] == code


async def test_requires_internal_token(client):
    resp = await client.post(URL, json=body(), headers={"X-Internal-Token": "wrong"})
    assert resp.status_code == 401


# ---------------- qwen-mt-image 引擎 ----------------


def _jpeg(w: int, h: int) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (10, 20, 30)).save(buf, "JPEG")
    return buf.getvalue()


@respx.mock
async def test_qwen_engine_event_sequence(client, insert_config):
    cid = insert_config(
        provider="DASHSCOPE",
        capability="IMAGE_TRANSLATE",
        base_url="https://dashscope.aliyuncs.com",
        model_name="qwen-mt-image-2.0",
        is_default=True,
    )
    route = respx.post(QWEN_URL).mock(
        return_value=httpx.Response(200, json={"output": {"image_url": RESULT_URL}, "usage": {"image_count": 1}})
    )
    respx.get(RESULT_URL).mock(return_value=httpx.Response(200, content=_jpeg(800, 600)))
    resp = await client.post(URL, json=body(engine="qwen-mt-image", sourceLang="zh"))
    events = named(parse_sse(resp.text))
    assert [(e.event, e.data.get("node"), e.data.get("status")) for e in events] == [
        ("start", None, None),
        ("node", "translate", "started"),
        ("node", "translate", "completed"),
        ("node", "render", "completed"),
        ("done", None, None),
    ]
    assert events[3].data["summary"] == "译图 800×600"
    done = events[-1].data
    assert done["blocks"] == [] and done["termHits"] == [] and done["modelConfigId"] == cid
    assert Image.open(io.BytesIO(base64.b64decode(done["resultImageBase64"]))).size == (800, 600)
    sent = json.loads(route.calls[0].request.content)
    assert sent["model"] == "qwen-mt-image-2.0"
    assert sent["input"]["source_lang"] == "zh" and sent["input"]["target_lang"] == "en"
    assert sent["input"]["image_url"].startswith("data:image/jpeg;base64,")
    assert route.calls[0].request.headers["authorization"] == "Bearer sk-test-1234567890abcdef"
    assert "x-dashscope-async" not in route.calls[0].request.headers


@respx.mock
async def test_qwen_engine_upstream_error_event(client, insert_config):
    insert_config(
        provider="DASHSCOPE",
        capability="IMAGE_TRANSLATE",
        base_url="https://dashscope.aliyuncs.com/api/v1",
        is_default=True,
    )
    respx.post(QWEN_URL).mock(return_value=httpx.Response(401, json={"code": "InvalidApiKey", "message": "bad key"}))
    events = named(parse_sse((await client.post(URL, json=body(engine="qwen-mt-image"))).text))
    assert events[-1].event == "error"
    assert events[-1].data["code"] == "C0121"


async def test_qwen_engine_without_config_returns_c0130(client, insert_config):
    insert_config(is_default=True, supports_vision=True)  # 只有 CHAT 配置
    resp = await client.post(URL, json=body(engine="qwen-mt-image"))
    assert resp.status_code == 400
    assert resp.json()["code"] == "C0130"
