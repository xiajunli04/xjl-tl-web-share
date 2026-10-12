"""LLM 评审（MQM，design D4）：GEMBA-MQM 风格的无参考逐块评审。

- 评审单位：同一 chunkIndex 的可翻译段落一起送审（原文段落 + 译文段落，按序号对应）
- 输出：JSON `{"errors":[{"segment", "category", "severity", "span", "explanation"}]}`
- 罚分：critical 25、major 5、minor 1；文档级报告"每千源词罚分"= 总罚分 / 已评审块的源词数 × 1000
- 评审模型默认 gpt-6-luna（与译者不同），temperature 0，请求 JSON 输出；解析失败重试一次，仍失败记为缺失
  （缺失块不计 0 分，也不计入分母）；网络错误另有指数退避重试
- 缓存：results/mqm_cache/{sha256}.json，键为（文档、配置、块、原文与译文内容哈希、评审模型、提示词版本）；
  轮次不在键中，因此重复运行得到相同译文时直接复用。解析失败的结果不缓存，下次重新评审
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
import time
from collections import Counter
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path

from eval.config import RESULTS_DIR, get_config

PROMPT_VERSION = "gemba-mqm-zh-v1"
SEVERITY_WEIGHTS = {"critical": 25, "major": 5, "minor": 1}
CATEGORIES = ("accuracy", "fluency", "terminology", "style", "locale")
CACHE_DIR = RESULTS_DIR / "mqm_cache"

SYSTEM_PROMPT = "你是一名资深的翻译质量评估专家，熟悉 MQM（多维质量度量）错误标注框架。你只输出 JSON。"

USER_TEMPLATE = """请按 MQM 框架标注下面这段{src_lang}→{tgt_lang}技术文档翻译中的错误。原文与译文按编号逐段对应。

错误类别（category）只能是：
- accuracy：准确性（误译、漏译、增译、未翻译的内容）
- fluency：流畅性（语法、标点、拼写、不通顺、不连贯）
- terminology：术语（术语译法错误、不符合领域惯例、同一术语前后不一致）
- style：风格（措辞生硬、不符合技术文档的语体）
- locale：本地化惯例（数字、日期、单位、引号等格式）

严重度（severity）只能是：
- critical：严重错误，导致读者无法理解或被误导
- major：主要错误，影响阅读或改变了部分含义，但读者仍能理解大意
- minor：次要错误，不影响理解，但确属瑕疵

说明：
- 技术文档中保留英文的产品名、API 资源名、代码标识符（例如 Pod、Deployment、`spec`）是常见惯例，不算错误
- Markdown 标记、链接与行内代码原样保留是正确的
- span 填写译文中出错的片段（漏译时填写原文中被遗漏的片段）；没有错误时输出 {{"errors": []}}

输出格式（只输出 JSON，不要任何解释性文字）：
{{"errors": [{{"segment": 1, "category": "accuracy", "severity": "major", "span": "出错片段",
"explanation": "简要原因"}}]}}

{segments}"""

_WORD = re.compile(r"[A-Za-z0-9]+(?:['’.\-][A-Za-z0-9]+)*")
_CJK_CHAR = re.compile(r"[㐀-鿿]")

LLMCall = Callable[[list[dict]], str]


def count_source_words(text: str) -> int:
    """英文按单词计；若混有汉字，每个汉字计一个词。"""
    return len(_WORD.findall(text)) + len(_CJK_CHAR.findall(text))


def build_messages(pairs: Sequence[tuple[str, str]], src_lang: str = "英语", tgt_lang: str = "简体中文") -> list[dict]:
    blocks = []
    for i, (src, tgt) in enumerate(pairs, 1):
        blocks.append(f"[{i}] 原文：\n{src}\n[{i}] 译文：\n{tgt}")
    user = USER_TEMPLATE.format(src_lang=src_lang, tgt_lang=tgt_lang, segments="\n\n".join(blocks))
    return [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user}]


def parse_errors(content: str | None) -> list[dict] | None:
    """容错解析：去掉代码围栏，截取第一个 JSON 对象；结构不符返回 None。"""
    if not content:
        return None
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", content.strip(), flags=re.I)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        data = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None
    errors = data.get("errors") if isinstance(data, dict) else None
    if not isinstance(errors, list):
        return None
    out = []
    for e in errors:
        if not isinstance(e, dict):
            continue
        sev = str(e.get("severity", "")).strip().lower()
        if sev not in SEVERITY_WEIGHTS:
            continue  # neutral / none 等不计分
        cat = str(e.get("category", "")).strip().lower()
        out.append(
            {
                "segment": e.get("segment"),
                "category": cat if cat in CATEGORIES else "other",
                "severity": sev,
                "span": str(e.get("span", "")),
                "explanation": str(e.get("explanation", "")),
            }
        )
    return out


def penalty(errors: Sequence[dict]) -> int:
    return sum(SEVERITY_WEIGHTS[e["severity"]] for e in errors)


def per_thousand(total_penalty: float, source_words: int) -> float | None:
    return total_penalty / source_words * 1000 if source_words else None


@dataclass
class ChunkJudgement:
    chunk_index: int
    source_words: int
    errors: list[dict] | None  # None 表示缺失（两次解析均失败或网络失败）
    cached: bool = False
    attempts: int = 0

    @property
    def missing(self) -> bool:
        return self.errors is None

    @property
    def penalty(self) -> int | None:
        return None if self.errors is None else penalty(self.errors)


@dataclass
class DocJudgement:
    chunks: list[ChunkJudgement]
    total_penalty: int = 0
    judged_words: int = 0
    by_severity: Counter = field(default_factory=Counter)
    by_category: Counter = field(default_factory=Counter)

    @property
    def score(self) -> float | None:
        """每千源词罚分（越低越好）；全部缺失时为 None。"""
        return per_thousand(self.total_penalty, self.judged_words)

    @property
    def missing_chunks(self) -> int:
        return sum(c.missing for c in self.chunks)


def summarize(chunks: list[ChunkJudgement]) -> DocJudgement:
    doc = DocJudgement(chunks=chunks)
    for c in chunks:
        if c.errors is None:
            continue
        doc.total_penalty += penalty(c.errors)
        doc.judged_words += c.source_words
        doc.by_severity.update(e["severity"] for e in c.errors)
        doc.by_category.update(e["category"] for e in c.errors)
    return doc


def _openai_call(model: str, temperature: float, timeout: float) -> LLMCall:
    import openai

    cfg = get_config()
    if not cfg.llm_base_url or not cfg.llm_api_key:
        raise RuntimeError("缺少 TEST_LLM_BASE_URL / TEST_LLM_API_KEY，无法调用评审模型")
    client = openai.OpenAI(base_url=cfg.llm_base_url, api_key=cfg.llm_api_key, timeout=timeout, max_retries=3)
    json_mode = {"enabled": True}

    def call(messages: list[dict]) -> str:
        kwargs = {"model": model, "messages": messages, "temperature": temperature}
        if json_mode["enabled"]:
            kwargs["response_format"] = {"type": "json_object"}
        try:
            resp = client.chat.completions.create(**kwargs)
        except openai.BadRequestError:
            if not json_mode["enabled"]:
                raise
            json_mode["enabled"] = False  # 中转站不支持 JSON 模式时退回普通输出（解析有容错）
            kwargs.pop("response_format")
            resp = client.chat.completions.create(**kwargs)
        return resp.choices[0].message.content or ""

    return call


class MqmJudge:
    def __init__(
        self,
        llm: LLMCall | None = None,
        *,
        model: str | None = None,
        temperature: float | None = None,
        cache_dir: Path = CACHE_DIR,
        network_attempts: int = 4,
        backoff: float = 3.0,
    ) -> None:
        cfg = get_config()
        self.model = model or cfg.judge_model
        self.temperature = cfg.judge_temperature if temperature is None else temperature
        self._llm = llm
        self._timeout = cfg.judge_timeout
        self.cache_dir = cache_dir
        self.network_attempts = network_attempts
        self.backoff = backoff
        self.calls = 0
        self._lock = threading.Lock()
        self._key_locks: dict[str, threading.Lock] = {}

    @property
    def llm(self) -> LLMCall:
        if self._llm is None:
            self._llm = _openai_call(self.model, self.temperature, self._timeout)
        return self._llm

    def cache_key(self, doc: str, group: str, chunk_index: int, pairs: Sequence[tuple[str, str]]) -> str:
        content = hashlib.sha256(json.dumps(list(pairs), ensure_ascii=False).encode("utf-8")).hexdigest()
        key = {
            "doc": doc,
            "group": group,
            "chunk": chunk_index,
            "content": content,
            "model": self.model,
            "prompt": PROMPT_VERSION,
        }
        return hashlib.sha256(json.dumps(key, sort_keys=True).encode("utf-8")).hexdigest()

    def _call_with_retry(self, messages: list[dict]) -> str | None:
        for i in range(self.network_attempts):
            try:
                with self._lock:
                    self.calls += 1
                return self.llm(messages)
            except Exception:  # noqa: BLE001 网络抖动、TLS 失败、5xx 等一律退避重试
                if i == self.network_attempts - 1:
                    return None
                time.sleep(self.backoff * (2**i))
        return None

    def judge_chunk(
        self, doc: str, group: str, chunk_index: int, pairs: Sequence[tuple[str, str]]
    ) -> ChunkJudgement:
        words = sum(count_source_words(s) for s, _ in pairs)
        key = self.cache_key(doc, group, chunk_index, pairs)
        with self._lock:
            key_lock = self._key_locks.setdefault(key, threading.Lock())
        # 同一键串行：并发评审两轮相同的译文时，后到者等待并命中缓存
        with key_lock:
            return self._judge_locked(key, chunk_index, words, doc, group, pairs)

    def _judge_locked(
        self, key: str, chunk_index: int, words: int, doc: str, group: str, pairs: Sequence[tuple[str, str]]
    ) -> ChunkJudgement:
        path = self.cache_dir / f"{key}.json"
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            return ChunkJudgement(chunk_index, words, data["errors"], cached=True)
        messages = build_messages(pairs)
        errors = None
        attempts = 0
        for _ in range(2):  # 解析失败重试一次
            attempts += 1
            content = self._call_with_retry(messages)
            errors = parse_errors(content)
            if errors is not None:
                break
        if errors is not None:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            record = {
                "doc": doc,
                "group": group,
                "chunk": chunk_index,
                "model": self.model,
                "prompt": PROMPT_VERSION,
                "sourceWords": words,
                "errors": errors,
            }
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(record, ensure_ascii=False, indent=1), encoding="utf-8")
            tmp.replace(path)
        return ChunkJudgement(chunk_index, words, errors, cached=False, attempts=attempts)


def chunk_pairs(segments: Sequence[dict]) -> dict[int, list[tuple[str, str]]]:
    """按 chunkIndex 分组可翻译段落；跳过不可翻译段与没有原文的段，缺失译文按空串送审（会被判为漏译）。"""
    groups: dict[int, list[tuple[str, str]]] = {}
    for seg in sorted(segments, key=lambda s: s.get("seq", 0)):
        if not seg.get("translatable") or seg.get("chunkIndex") is None or not (seg.get("source") or "").strip():
            continue
        groups.setdefault(int(seg["chunkIndex"]), []).append((seg["source"], seg.get("target") or ""))
    return dict(sorted(groups.items()))
