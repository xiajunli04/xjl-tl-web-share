"""文档翻译的测试替身：脚本化的 JSON LLM、内存事件发射器、内存分块缓存。"""

import asyncio
import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.core.config import get_settings
from app.doc import prompts
from app.doc.events import BaseEmitter
from app.doc.state import DocDeps
from app.lang.detector import LanguageDetector
from app.llm.base import ChatRequest, ChatResult, Usage

FIXTURES = Path(__file__).resolve().parents[2] / "docs" / "contracts" / "fixtures"
SAMPLE_MD = Path(__file__).resolve().parents[2] / "docs" / "contracts" / "doc-stream-sample.md"


def fixture_text(name: str) -> str:
    """按二进制读取并解码，保留 CRLF。"""
    return (FIXTURES / name).read_bytes().decode("utf-8")


def kind_of(req: ChatRequest) -> str:
    system = next((m.content for m in req.messages if m.role == "system"), "")
    if system.startswith(prompts.REFINE_ROLE):
        return "refine"
    for role, kind in (
        (prompts.ANALYZE_ROLE, "analyze"),
        (prompts.REDUCE_ROLE, "reduce"),
        (prompts.TRANSLATE_ROLE, "translate"),
        (prompts.REVIEW_ROLE, "review"),
        (prompts.FIX_ROLE, "fix"),
    ):
        if system.startswith(role):
            return kind
    if "语种识别器" in system:
        return "detect"
    return "unknown"


def payload_of(req: ChatRequest) -> dict[str, Any]:
    """取 user 消息中的 JSON（分块翻译取「待译段落」之后的部分）。"""
    user = next((m.content for m in req.messages if m.role == "user"), "")
    marker = "## 待译段落\n"
    if marker in user:
        user = user.split(marker, 1)[1]
    try:
        return json.loads(user)
    except ValueError:
        return {}


def zh(seq: int, text: str) -> str:
    return f"译:{text}"


@dataclass
class DocFakeLLM:
    """按提示词类型生成结果；可通过 handlers 覆盖某类调用，或通过 gate 阻塞某次调用。

    handlers[kind](req, payload, n) -> str，n 为该类调用的序号（从 0 开始）。
    """

    terms: list[dict[str, Any]] = field(default_factory=list)
    summary: str = "本文介绍 Kubernetes 的部署方法。"
    domain: str = "计算机"
    genre: str = "技术文档"
    review_scores: list[int] = field(default_factory=list)  # 依次使用，用完后为 95
    translate_fn: Callable[[int, str], str] = zh
    names: list[dict[str, str]] = field(default_factory=list)
    handlers: dict[str, Callable[[ChatRequest, dict, int], str]] = field(default_factory=dict)
    gate: Callable[[str, int, dict], bool] | None = None  # 返回 True 时阻塞，直到 release 被设置
    release: asyncio.Event = field(default_factory=asyncio.Event)
    blocked: asyncio.Event = field(default_factory=asyncio.Event)
    cancelled: asyncio.Event = field(default_factory=asyncio.Event)
    model: str = "fake-doc-model"
    calls: list[tuple[str, ChatRequest]] = field(default_factory=list)

    def kinds(self) -> list[str]:
        return [k for k, _ in self.calls]

    def count(self, kind: str) -> int:
        return sum(1 for k, _ in self.calls if k == kind)

    def requests(self, kind: str) -> list[ChatRequest]:
        return [r for k, r in self.calls if k == kind]

    async def chat(self, req: ChatRequest) -> ChatResult:
        kind = kind_of(req)
        n = self.count(kind)
        self.calls.append((kind, req))
        payload = payload_of(req)
        if self.gate is not None and self.gate(kind, n, payload):
            self.blocked.set()
            try:
                await self.release.wait()
            except asyncio.CancelledError:
                self.cancelled.set()
                raise
        await asyncio.sleep(0)
        if kind in self.handlers:
            content = self.handlers[kind](req, payload, n)
        else:
            content = self._default(kind, payload, n)
        return ChatResult(content=content, model=self.model, usage=Usage(100, 20), latency_ms=1)

    def _default(self, kind: str, payload: dict, n: int) -> str:
        if kind == "analyze":
            return json.dumps(
                {"summary": self.summary, "domain": self.domain, "genre": self.genre, "terms": self.terms},
                ensure_ascii=False,
            )
        if kind == "reduce":
            return json.dumps(
                {"summary": "汇总：" + self.summary, "domain": self.domain, "genre": self.genre}, ensure_ascii=False
            )
        if kind == "translate":
            segs = [{"id": s["id"], "text": self.translate_fn(s["id"], s["text"])} for s in payload.get("segments", [])]
            return json.dumps({"segments": segs, "names": self.names}, ensure_ascii=False)
        if kind == "review":
            score = self.review_scores.pop(0) if self.review_scores else 95
            return json.dumps({"score": score, "issues": []})
        if kind in ("refine", "fix"):
            segs = [{"id": s["id"], "text": s["translation"] + "（修）"} for s in payload.get("segments", [])]
            return json.dumps({"segments": segs}, ensure_ascii=False)
        if kind == "detect":
            return '{"lang": "en", "confidence": 0.9}'
        return "{}"

    async def stream(self, req):  # pragma: no cover - 文档翻译只用 chat
        raise NotImplementedError

    async def close(self) -> None:
        pass


class ListEmitter(BaseEmitter):
    """把事件按 Stream 字段格式记录在内存中（字段值均为字符串）。"""

    def __init__(
        self, task_id: int | str = 42, trace_id: str = "t-1", events: list | None = None, counters: dict | None = None
    ):
        super().__init__()
        self.task_id = str(task_id)
        self.trace_id = trace_id
        self.events: list[dict[str, str]] = events if events is not None else []
        self.counters = counters if counters is not None else {"seq": 0, "trace": 0}

    async def _publish(self, type_: str, data: dict[str, Any]) -> int:
        self.counters["seq"] += 1
        self.events.append(
            {
                "taskId": self.task_id,
                "eventSeq": str(self.counters["seq"]),
                "type": type_,
                "traceId": self.trace_id,
                "data": json.dumps(data, ensure_ascii=False, separators=(",", ":")),
            }
        )
        return self.counters["seq"]

    async def _next_trace_seq(self) -> int:
        self.counters["trace"] += 1
        return self.counters["trace"]

    def child(self, trace_id: str) -> "ListEmitter":
        """同一任务的下一次执行（resume / retry）：共享事件列表与计数器。"""
        return ListEmitter(self.task_id, trace_id, self.events, self.counters)

    def types(self) -> list[str]:
        return [e["type"] for e in self.events]

    def of(self, type_: str) -> list[dict[str, Any]]:
        return [json.loads(e["data"]) for e in self.events if e["type"] == type_]


class MemoryStore:
    def __init__(self) -> None:
        self.rows: dict[tuple[int, int], tuple[dict, dict]] = {}
        self.gets: list[tuple[int, int]] = []

    async def get(self, task_id: int, chunk_index: int):
        self.gets.append((task_id, chunk_index))
        row = self.rows.get((task_id, chunk_index))
        if row is None:
            return None
        result = json.loads(json.dumps(row[0]))
        result["usage"] = dict(row[1])
        return result

    async def put(self, task_id: int, chunk_index: int, result: dict, usage: dict) -> None:
        self.rows[(task_id, chunk_index)] = (json.loads(json.dumps(result)), dict(usage))

    async def purge(self, task_id: int) -> None:
        for k in [k for k in self.rows if k[0] == task_id]:
            del self.rows[k]


class FakeGlossaryRepo:
    def __init__(self, glossaries=()):
        self._g = {g.id: g for g in glossaries}

    async def load(self, ids):
        return {i: self._g[i] for i in ids if i in self._g}


def make_doc_deps(fake: DocFakeLLM, *, emitter=None, store=None, repo=None, reviewer=None, **overrides) -> DocDeps:
    settings = get_settings().model_copy(update=overrides)
    return DocDeps(
        llm=fake,
        settings=settings,
        detector=LanguageDetector(settings),
        glossary_repo=repo or FakeGlossaryRepo(),
        emitter=emitter or ListEmitter(),
        store=store or MemoryStore(),
        reviewer=reviewer,
    )


def doc_payload(text: str, **kw) -> dict[str, Any]:
    base = {
        "userId": 1,
        "title": "测试文档",
        "format": "md",
        "text": text,
        "sourceLang": "auto",
        "targetLang": "zh",
        "style": "faithful",
        "domain": None,
        "glossaryIds": [],
        "modelConfigId": None,
        "strategy": "serial",
        "confirmTerms": False,
        "options": {"contextWindow": True, "globalSummary": True, "termExtraction": True, "review": True},
    }
    options = kw.pop("options", None)
    base.update(kw)
    if options:
        base["options"] = {**base["options"], **options}
    return base


_JSONL_BLOCK = re.compile(r"```jsonl\n(.*?)```", re.DOTALL)


def load_sample_events() -> list[list[dict[str, Any]]]:
    """doc-stream-sample.md 中的各个 jsonl 代码块（第 0 块为任务流命令）。"""
    blocks = _JSONL_BLOCK.findall(SAMPLE_MD.read_text(encoding="utf-8"))
    return [[json.loads(line) for line in b.splitlines() if line.strip()] for b in blocks]
