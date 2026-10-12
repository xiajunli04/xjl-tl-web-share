"""OpenAI 兼容的 mock LLM 服务（design D7），供性能测试替代真实模型。

- ``POST /v1/chat/completions``：流式（SSE ``data: {...}`` + ``data: [DONE]``，最后一个 chunk 携带 usage）与非流式
- ``GET /v1/models``
- 按系统提示词的角色句判断调用用途，返回平台能解析的内容（对照 python-backend 的提示词与解析代码）：

  ===========================  =====================================================================
  用途                          返回
  ===========================  =====================================================================
  语种识别兜底                  ``{"lang": 代码, "confidence": 0.9}``（app/lang/detector.py）
  领域判定                      纯文本“通用”（app/agent/nodes/prep.py 取第一行）
  短文本翻译 / 修正（流式）     “【译】原文” / <translation> 中的当前译文
  短文本评审                    ``{"score": 95, "issues": []}``（app/agent/nodes/llm.py parse_review）
  文档全文分析                  ``{"summary", "domain", "genre", "terms": []}``，只返回提示词要求的字段
  文档摘要汇总                  ``{"summary", "domain", "genre"}``
  文档分块翻译                  ``{"segments": [{"id", "text": "【译】原文"}], "names": []}``
  文档分块评审                  ``{"score": 95, "issues": []}``
  文档修正 / 术语统一           ``{"segments": [{"id", "text": 当前译文}]}``
  ===========================  =====================================================================

延迟（环境变量，毫秒）：``MOCK_LLM_FIRST_TOKEN_MS``（默认 200）、``MOCK_LLM_TOKEN_MS``（默认 20）；
``MOCK_LLM_CHARS_PER_TOKEN``（默认 4）决定输出被切成多少个 token。非流式响应同样按 首 token + token 数 × 间隔 计时。

启动：``uv run --no-sync python -m mock_llm.server``
（固定监听 127.0.0.1:9100，可用 MOCK_LLM_HOST / MOCK_LLM_PORT 覆盖）。
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
import uuid
from dataclasses import dataclass
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

MOCK_MODEL = "mock-llm"
TRANSLATION_PREFIX = "【译】"

# 系统提示词中的角色句（与 python-backend 的提示词保持一致；顺序有意义：更具体的放前面）
DETECT_ROLE = "你是语种识别器"
DOMAIN_ROLE = "判断用户消息中文本所属的专业领域"
SHORT_REVIEW_ROLE = "你是一名严格的翻译质量评审员"
SHORT_REFINE_ROLE = "负责根据评审意见修改"  # 短文本修正：“你是一名专业译者，负责根据评审意见修改…的译文”
DOC_ANALYZE_ROLE = "你是一名文档分析助手"
DOC_REDUCE_ROLE = "你是一名文档摘要汇总助手"
DOC_REFINE_ROLE = "你是一名专业的篇章译者，负责根据评审意见修改文档译文"
DOC_TRANSLATE_ROLE = "你是一名专业的篇章译者"
DOC_REVIEW_ROLE = "你是一名严格的文档翻译评审员"
DOC_FIX_ROLE = "你是一名译文术语统一助手"

MOCK_SUMMARY = "（mock 摘要）本文档用于性能测试，内容摘要由 mock LLM 生成。"
MOCK_DOMAIN = "计算机"
MOCK_GENRE = "技术文档"

_TRANSLATION_TAG = re.compile(r"<translation>\n?(.*?)\n?</translation>", re.DOTALL)


@dataclass(frozen=True)
class Latency:
    first_token_ms: float = 200.0
    token_ms: float = 20.0
    chars_per_token: int = 4

    @classmethod
    def from_env(cls) -> Latency:
        return cls(
            first_token_ms=float(os.environ.get("MOCK_LLM_FIRST_TOKEN_MS", 200)),
            token_ms=float(os.environ.get("MOCK_LLM_TOKEN_MS", 20)),
            chars_per_token=max(1, int(os.environ.get("MOCK_LLM_CHARS_PER_TOKEN", 4))),
        )


# ---------------------------------------------------------------- 内容生成


def _text_of(content: Any) -> str:
    """消息 content 可能是字符串或 [{type:text,text:...}] 列表。"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(p.get("text", "") for p in content if isinstance(p, dict))
    return ""


def _messages(body: dict[str, Any]) -> tuple[str, str]:
    """返回 (system, 最后一条 user)。"""
    system, user = "", ""
    for m in body.get("messages") or []:
        role, text = m.get("role"), _text_of(m.get("content"))
        if role in ("system", "developer"):
            system += text
        elif role == "user":
            user = text
    return system, user


def _dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False)


def _load_json_tail(text: str, marker: str | None = None) -> dict[str, Any]:
    """解析用户消息中的 JSON：有 marker 时取最后一个 marker 之后的部分，否则从第一个 { 开始。"""
    if marker and marker in text:
        text = text.rsplit(marker, 1)[1]
    start = text.find("{")
    if start < 0:
        return {}
    try:
        obj, _ = json.JSONDecoder().raw_decode(text[start:])
    except ValueError:
        return {}
    return obj if isinstance(obj, dict) else {}


def _segments(obj: dict[str, Any]) -> list[dict[str, Any]]:
    items = obj.get("segments")
    return [s for s in items if isinstance(s, dict) and "id" in s] if isinstance(items, list) else []


def guess_lang(text: str) -> str:
    """语种识别兜底用的粗略判断（按文字系统），只需返回 15 种代码之一。"""
    counts = {"ja": 0, "zh": 0, "ko": 0, "ru": 0, "ar": 0, "th": 0}
    for ch in text:
        o = ord(ch)
        if 0x3040 <= o <= 0x30FF:
            counts["ja"] += 1
        elif 0x4E00 <= o <= 0x9FFF:
            counts["zh"] += 1
        elif 0xAC00 <= o <= 0xD7AF:
            counts["ko"] += 1
        elif 0x0400 <= o <= 0x04FF:
            counts["ru"] += 1
        elif 0x0600 <= o <= 0x06FF:
            counts["ar"] += 1
        elif 0x0E00 <= o <= 0x0E7F:
            counts["th"] += 1
    if counts["ja"]:
        return "ja"
    best = max(counts, key=lambda k: counts[k])
    return best if counts[best] else "en"


def _analysis(system: str, user: str) -> str:
    """文档全文分析：只返回提示词输出格式中要求的字段（摘要、术语均可被实验选项关闭）。"""
    out: dict[str, Any] = {}
    if '"summary"' in system:
        out["summary"] = MOCK_SUMMARY
    out["domain"] = MOCK_DOMAIN
    out["genre"] = MOCK_GENRE
    if '"terms"' in system:
        out["terms"] = []
    return _dumps(out)


def generate(body: dict[str, Any]) -> tuple[str, str]:
    """返回 (用途, 回复内容)。"""
    system, user = _messages(body)
    if DETECT_ROLE in system:
        return "detect", _dumps({"lang": guess_lang(user), "confidence": 0.9})
    if DOMAIN_ROLE in system:
        return "domain", "通用"
    if DOC_ANALYZE_ROLE in system:
        return "doc_analyze", _analysis(system, user)
    if DOC_REDUCE_ROLE in system:
        return "doc_reduce", _dumps({"summary": MOCK_SUMMARY, "domain": MOCK_DOMAIN, "genre": MOCK_GENRE})
    if DOC_REVIEW_ROLE in system:
        return "doc_review", _dumps({"score": 95, "issues": []})
    if DOC_REFINE_ROLE in system or DOC_FIX_ROLE in system:
        segs = _segments(_load_json_tail(user))
        out = [{"id": s["id"], "text": s.get("translation") or s.get("text") or ""} for s in segs]
        return ("doc_refine" if DOC_REFINE_ROLE in system else "doc_fix"), _dumps({"segments": out})
    if DOC_TRANSLATE_ROLE in system:
        segs = _segments(_load_json_tail(user, "## 待译段落"))
        out = [{"id": s["id"], "text": TRANSLATION_PREFIX + str(s.get("text") or "")} for s in segs]
        return "doc_translate", _dumps({"segments": out, "names": []})
    if SHORT_REVIEW_ROLE in system:
        return "review", _dumps({"score": 95, "issues": []})
    if SHORT_REFINE_ROLE in system:
        m = _TRANSLATION_TAG.search(user)
        return "refine", (m.group(1) if m else TRANSLATION_PREFIX + user)
    if _wants_json(body, system):
        return "json", _dumps({"result": TRANSLATION_PREFIX + user})
    return "translate", TRANSLATION_PREFIX + user


def _wants_json(body: dict[str, Any], system: str) -> bool:
    fmt = body.get("response_format") or {}
    return (isinstance(fmt, dict) and fmt.get("type") in ("json_object", "json_schema")) or "JSON" in system


def split_tokens(text: str, chars_per_token: int) -> list[str]:
    return [text[i : i + chars_per_token] for i in range(0, len(text), chars_per_token)] or [""]


def estimate_prompt_tokens(body: dict[str, Any], chars_per_token: int) -> int:
    chars = sum(len(_text_of(m.get("content"))) for m in body.get("messages") or [])
    return max(1, -(-chars // chars_per_token))


# ---------------------------------------------------------------- 应用


def create_app(latency: Latency | None = None) -> FastAPI:
    lat = latency or Latency.from_env()
    app = FastAPI(title="mock-llm", docs_url=None, redoc_url=None)
    app.state.latency = lat
    app.state.calls = {}

    @app.get("/v1/models")
    async def models() -> dict[str, Any]:
        return {"object": "list", "data": [{"id": MOCK_MODEL, "object": "model", "created": 0, "owned_by": "mock"}]}

    @app.get("/stats")
    async def stats() -> dict[str, Any]:
        """各用途的调用次数（调试用）。"""
        return {"calls": app.state.calls}

    @app.post("/v1/chat/completions")
    async def chat_completions(request: Request):
        body = await request.json()
        kind, content = generate(body)
        app.state.calls[kind] = app.state.calls.get(kind, 0) + 1
        model = body.get("model") or MOCK_MODEL
        tokens = split_tokens(content, lat.chars_per_token)
        usage = {
            "prompt_tokens": estimate_prompt_tokens(body, lat.chars_per_token),
            "completion_tokens": len(tokens),
        }
        usage["total_tokens"] = usage["prompt_tokens"] + usage["completion_tokens"]
        cid = f"chatcmpl-mock-{uuid.uuid4().hex[:12]}"
        created = int(time.time())
        if body.get("stream"):
            return StreamingResponse(
                _stream(cid, created, model, tokens, usage, lat),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache"},
            )
        await asyncio.sleep((lat.first_token_ms + lat.token_ms * max(0, len(tokens) - 1)) / 1000)
        return JSONResponse(
            {
                "id": cid,
                "object": "chat.completion",
                "created": created,
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": content},
                        "finish_reason": "stop",
                        "logprobs": None,
                    }
                ],
                "usage": usage,
            }
        )

    return app


async def _stream(cid: str, created: int, model: str, tokens: list[str], usage: dict[str, int], lat: Latency):
    def chunk(delta: dict[str, Any], finish: str | None = None, **extra: Any) -> str:
        obj = {
            "id": cid,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish, "logprobs": None}],
            **extra,
        }
        return f"data: {_dumps(obj)}\n\n"

    # 按绝对时间点调度：Windows 上事件循环的时钟分辨率约 15.6 ms，逐次 sleep(20 ms) 会累积误差
    t0 = time.perf_counter()
    for i, tok in enumerate(tokens):
        delay = t0 + (lat.first_token_ms + lat.token_ms * i) / 1000 - time.perf_counter()
        if delay > 0:
            await asyncio.sleep(delay)
        yield chunk({"role": "assistant", "content": tok} if i == 0 else {"content": tok})
    yield chunk({}, "stop")
    # 最后一个 chunk 携带 usage（与 OpenAI stream_options.include_usage 的格式一致：choices 为空）
    final = {"id": cid, "object": "chat.completion.chunk", "created": created, "model": model, "choices": []}
    yield f"data: {_dumps({**final, 'usage': usage})}\n\n"
    yield "data: [DONE]\n\n"


app = create_app()


def main() -> None:
    import uvicorn

    host = os.environ.get("MOCK_LLM_HOST", "127.0.0.1")
    port = int(os.environ.get("MOCK_LLM_PORT", 9100))
    uvicorn.run(app, host=host, port=port, log_level=os.environ.get("MOCK_LLM_LOG_LEVEL", "warning"), access_log=False)


if __name__ == "__main__":
    main()
