"""测试替身：脚本化的 LLM 客户端与 SSE 解析工具。"""

import asyncio
import hashlib
import json
import math
import random
import threading
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from app.agent.prompts import DOMAIN_SYSTEM_PROMPT
from app.agent.session import CLARIFY_ROLE, MEMORIZE_ROLE
from app.llm.base import ChatChunk, ChatRequest, ChatResult, LLMError, Usage
from app.llm.registry import ResolvedModel
from app.memory.embedding import EMBEDDING_DIM, EmbeddingUnavailable, normalize
from app.memory.tm import normalize_text
from app.repositories.model_config import ModelConfig

SAMPLE_FILE = Path(__file__).resolve().parents[2] / "docs" / "contracts" / "translate-stream-sample.txt"


def _kind(req: ChatRequest) -> str:
    system = next((m.content for m in req.messages if m.role == "system"), "")
    if system == DOMAIN_SYSTEM_PROMPT:
        return "domain"
    if system.startswith(CLARIFY_ROLE):
        return "clarify"
    if system.startswith(MEMORIZE_ROLE):
        return "memorize"
    if "按用户的修订要求修改" in system:
        return "revise"
    if "语种识别器" in system:
        return "detect"
    if "翻译质量评审员" in system:
        return "review"
    if "根据评审意见修改" in system:
        return "refine"
    return "translate"


@dataclass
class FakeLLM:
    """按提示词类型返回脚本化结果。translations 依次用于首译和各轮修正；reviews 依次用于各轮评审。"""

    translations: list[str] = field(default_factory=lambda: ["早上好"])
    reviews: list[str] = field(default_factory=list)
    domain: str = "计算机"
    detect: str = '{"lang": "en", "confidence": 0.9}'
    clarify: str = '{"domain": "通用", "ambiguity": {"ambiguous": false}}'  # 领域与歧义的合并判定
    memorize: str = (
        '{"summary": "客户购买了 X200 耳机", "entities": [{"source": "X200", "target": "X200", "note": "耳机型号"}]}'
    )
    memorize_error: Exception | None = None
    chunk_size: int = 2
    delay: float = 0.0  # 每个流式增量之前的等待（秒）
    error: LLMError | None = None  # 流式调用时抛出
    model: str = "fake-model"
    calls: list[tuple[str, ChatRequest]] = field(default_factory=list)
    cancelled: threading.Event = field(default_factory=threading.Event)
    stream_started: threading.Event = field(default_factory=threading.Event)

    def kinds(self) -> list[str]:
        return [k for k, _ in self.calls]

    async def chat(self, req: ChatRequest) -> ChatResult:
        kind = _kind(req)
        self.calls.append((kind, req))
        if kind == "domain":
            content = self.domain
        elif kind == "detect":
            content = self.detect
        elif kind == "clarify":
            content = self.clarify
        elif kind == "memorize":
            if self.memorize_error is not None:
                raise self.memorize_error
            content = self.memorize
        else:
            content = self.reviews.pop(0)
        return ChatResult(content=content, model=self.model, usage=Usage(100, 10), latency_ms=1)

    async def stream(self, req: ChatRequest) -> AsyncIterator[ChatChunk]:
        kind = _kind(req)
        self.calls.append((kind, req))
        self.stream_started.set()
        try:
            if self.error is not None:
                raise self.error
            text = self.translations.pop(0)
            for i in range(0, len(text), self.chunk_size):
                if self.delay:
                    await asyncio.sleep(self.delay)
                yield ChatChunk(delta=text[i : i + self.chunk_size], model=self.model)
        except asyncio.CancelledError:
            self.cancelled.set()
            raise
        yield ChatChunk(model=self.model, usage=Usage(200, 20), latency_ms=1, done=True)

    async def close(self) -> None:
        pass


def unit_vector(seed: str, dim: int = EMBEDDING_DIM) -> list[float]:
    """由字符串确定性生成的单位向量；不同字符串的向量在高维下近似正交（余弦接近 0）。"""
    rnd = random.Random(hashlib.md5(seed.encode("utf-8")).hexdigest())
    return normalize([rnd.gauss(0, 1) for _ in range(dim)])


def blend(a: list[float], b: list[float], cos: float) -> list[float]:
    """构造与 a 的余弦相似度约为 cos 的向量（b 为与 a 近似正交的方向）。"""
    sin = math.sqrt(max(0.0, 1 - cos * cos))
    return normalize([cos * x + sin * y for x, y in zip(a, b, strict=True)])


@dataclass
class FakeEmbedding:
    """确定性的假 embedding：默认按规范化文本生成伪随机单位向量，vectors 可为指定文本给出固定向量（构造语义近邻）。"""

    vectors: dict[str, list[float]] = field(default_factory=dict)
    available: bool = True
    fail: bool = False  # 编码时抛出不可用
    dim: int = EMBEDDING_DIM
    calls: list[list[str]] = field(default_factory=list)

    def vector(self, text: str) -> list[float]:
        key = normalize_text(text)
        return list(self.vectors.get(key) or unit_vector(key, self.dim))

    def set_similar(self, base: str, other: str, cos: float) -> None:
        """令 other 与 base 的余弦相似度约为 cos。"""
        self.vectors[normalize_text(other)] = blend(self.vector(base), unit_vector("orth:" + other, self.dim), cos)

    async def embed(self, texts, *, wait: bool = True) -> list[list[float]]:
        self.calls.append(list(texts))
        if not self.available or self.fail:
            raise EmbeddingUnavailable("fake unavailable")
        return [self.vector(t) for t in texts]

    async def warmup(self) -> bool:
        return self.available


def resolved(fake: FakeLLM, params: dict | None = None) -> ResolvedModel:
    cfg = ModelConfig(
        id=1,
        name="fake",
        provider="OPENAI_COMPATIBLE",
        base_url="https://llm.test/v1",
        model_name=fake.model,
        api_key_cipher="",
        is_default=True,
        enabled=True,
        updated_at=datetime.now(UTC),
        params=params or {},
    )
    return ResolvedModel(cfg, fake)


def use_fake_llm(app, monkeypatch, fake: FakeLLM) -> None:
    async def _get(_model_config_id=None):
        return resolved(fake)

    monkeypatch.setattr(app.state.registry, "get", _get)


def review_json(score: int, issues: list[dict] | None = None) -> str:
    return json.dumps({"score": score, "issues": issues or []}, ensure_ascii=False)


# ---------------- SSE ----------------


@dataclass
class SSEEvent:
    event: str | None
    data: dict | None
    comment: str | None = None


def parse_sse(text: str, *, skip_hash_lines: bool = False) -> list[SSEEvent]:
    """解析 SSE 文本；每个 data 行必须是单行 JSON。"""
    events: list[SSEEvent] = []
    event, data_lines, comment = None, [], None
    for line in text.replace("\r\n", "\n").split("\n"):
        if skip_hash_lines and line.startswith("#"):
            continue
        if line == "":
            if event is not None or data_lines:
                assert len(data_lines) <= 1, f"data 必须是单行: {data_lines}"
                events.append(SSEEvent(event, json.loads(data_lines[0]) if data_lines else None))
            elif comment is not None:
                events.append(SSEEvent(None, None, comment))
            event, data_lines, comment = None, [], None
        elif line.startswith(":"):
            comment = line[1:].strip()
        elif line.startswith("event:"):
            event = line[len("event:") :].strip()
        elif line.startswith("data:"):
            data_lines.append(line[len("data:") :].removeprefix(" "))
    if event is not None or data_lines:
        events.append(SSEEvent(event, json.loads(data_lines[0]) if data_lines else None))
    return events


def load_sample_streams() -> dict[str, list[SSEEvent]]:
    """按 "### STREAM: name" 切分契约样例。"""
    streams: dict[str, list[str]] = {}
    current = None
    for line in SAMPLE_FILE.read_text(encoding="utf-8").splitlines():
        if line.startswith("### STREAM:"):
            current = line.split(":", 1)[1].strip()
            streams[current] = []
        elif current is not None:
            streams[current].append(line)
    return {k: parse_sse("\n".join(v) + "\n\n", skip_hash_lines=True) for k, v in streams.items()}


def structure(events: list[SSEEvent]) -> list[tuple]:
    """事件结构：事件名 + node 的 (节点, 状态)；连续的 delta 合并为一个（增量数量取决于文本）；忽略心跳。"""
    out: list[tuple] = []
    for e in events:
        if e.event is None:
            continue
        if e.event == "node":
            item = ("node", e.data["node"], e.data["status"])
        elif e.event == "delta":
            item = ("delta", e.data["round"])
        else:
            item = (e.event,)
        if item[0] == "delta" and out and out[-1] == item:
            continue
        out.append(item)
    return out
