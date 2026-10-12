"""E2 的 LLM 评审：逐项现象判定与整段对话的成对偏好（均带磁盘缓存）。

- 现象判定：给评审模型看本轮之前的原文对话、本轮原文与译文、标注的片段与正确译法说明，逐项返回是否译对。
  评审只看到原文前文，不看到任何一组的历史译文，因此对两组一视同仁。
- 成对偏好：把同一段对话的两组译文以 A / B 呈现（不告知来源），两种顺序各问一次；两次结论一致才算胜，
  否则记为平局，以消除位置偏差。
"""

from __future__ import annotations

import hashlib
import json
import threading
from collections.abc import Callable, Sequence
from pathlib import Path

from eval.config import RESULTS_DIR, get_config
from eval.metrics.mqm_judge import _openai_call  # 复用 OpenAI 兼容调用（JSON 模式不支持时自动退回）

PROMPT_VERSION = "ctx-v1"
CACHE_DIR = RESULTS_DIR / "context" / "judge_cache"
LLMCall = Callable[[list[dict]], str]

PHENOMENA_SYSTEM = (
    "你是一名严格的英译中翻译评审员。你会看到一段英文对话的前文、当前一轮的英文原文与中文译文，"
    "以及若干需要结合前文才能正确翻译的片段和正确译法说明。请逐项判断译文是否正确处理了该片段："
    "译法符合说明（含语义上等价的省略或改写）为 correct=true；译错、指代错误、无法判断所指或遗漏为 false。"
    '只输出 JSON：{"items": [{"index": 0, "correct": true, "reason": "简短理由"}]}'
)

PAIRWISE_SYSTEM = (
    "你是一名英译中翻译评审员。你会看到一段英文多轮对话，以及两份逐轮中文译文 A 与 B。"
    "请从上下文连贯性比较两份译文：代词与省略是否指代正确、称谓与人名前后是否一致、多义词是否按语境翻译、"
    "语气是否统一。不考虑与上下文无关的措辞偏好。"
    '只输出 JSON：{"winner": "A" | "B" | "tie", "reason": "简短理由"}'
)


def parse_json(content: str | None) -> dict | None:
    if not content:
        return None
    text = content.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        data = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def phenomena_messages(history: Sequence[str], source: str, translation: str, phenomena: Sequence[dict]) -> list[dict]:
    lines = ["## 前文（英文原文）"]
    lines += [f"{i + 1}. {h}" for i, h in enumerate(history)] or ["（无）"]
    lines += ["", "## 当前轮", f"原文：{source}", f"译文：{translation}", "", "## 需判定的片段"]
    lines += [f"{i}. 「{p['span']}」：{p['expected']}" for i, p in enumerate(phenomena)]
    return [{"role": "system", "content": PHENOMENA_SYSTEM}, {"role": "user", "content": "\n".join(lines)}]


def parse_phenomena(content: str | None, n: int) -> list[bool] | None:
    """返回逐项判定；缺项或格式错误返回 None。"""
    data = parse_json(content)
    if not data or not isinstance(data.get("items"), list):
        return None
    got: dict[int, bool] = {}
    for item in data["items"]:
        if isinstance(item, dict) and isinstance(item.get("index"), int) and isinstance(item.get("correct"), bool):
            got[item["index"]] = item["correct"]
    if set(got) != set(range(n)):
        return None
    return [got[i] for i in range(n)]


def pairwise_messages(sources: Sequence[str], a: Sequence[str], b: Sequence[str]) -> list[dict]:
    lines = ["## 英文对话"] + [f"{i + 1}. {s}" for i, s in enumerate(sources)]
    lines += ["", "## 译文 A"] + [f"{i + 1}. {t}" for i, t in enumerate(a)]
    lines += ["", "## 译文 B"] + [f"{i + 1}. {t}" for i, t in enumerate(b)]
    return [{"role": "system", "content": PAIRWISE_SYSTEM}, {"role": "user", "content": "\n".join(lines)}]


def parse_winner(content: str | None) -> str | None:
    data = parse_json(content)
    winner = (data or {}).get("winner")
    return winner if winner in ("A", "B", "tie") else None


def combine_orders(first: str | None, swapped: str | None) -> str:
    """first：X 在 A 位时的结论；swapped：X 在 B 位时的结论。返回 X / Y / tie（两次一致才算胜）。"""
    x_first = {"A": "X", "B": "Y"}.get(first or "", "tie")
    x_swapped = {"B": "X", "A": "Y"}.get(swapped or "", "tie")
    return x_first if x_first == x_swapped else "tie"


class ContextJudge:
    def __init__(
        self, llm: LLMCall | None = None, *, model: str | None = None, cache_dir: Path = CACHE_DIR, attempts: int = 3
    ) -> None:
        cfg = get_config()
        self.model = model or cfg.judge_model
        self._llm = llm
        self.cache_dir = cache_dir
        self.attempts = attempts
        self.calls = 0
        self._lock = threading.Lock()

    @property
    def llm(self) -> LLMCall:
        if self._llm is None:
            cfg = get_config()
            self._llm = _openai_call(self.model, 0.0, cfg.judge_timeout)
        return self._llm

    def _cached(self, kind: str, messages: list[dict], parse: Callable[[str | None], object | None]):
        key = hashlib.sha256(
            json.dumps(
                {"kind": kind, "model": self.model, "prompt": PROMPT_VERSION, "messages": messages},
                ensure_ascii=False,
                sort_keys=True,
            ).encode("utf-8")
        ).hexdigest()
        path = self.cache_dir / f"{key}.json"
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))["result"]
        result = None
        for _ in range(self.attempts):
            with self._lock:
                self.calls += 1
            try:
                content = self.llm(messages)
            except Exception:  # noqa: BLE001 网络抖动时重试
                continue
            result = parse(content)
            if result is not None:
                break
        if result is not None:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"result": result}, ensure_ascii=False), encoding="utf-8")
        return result

    def phenomena(self, history: Sequence[str], source: str, translation: str, phenomena: Sequence[dict]):
        if not phenomena:
            return []
        msgs = phenomena_messages(history, source, translation, phenomena)
        return self._cached("phenomena", msgs, lambda c: parse_phenomena(c, len(phenomena)))

    def pairwise(self, sources: Sequence[str], x: Sequence[str], y: Sequence[str]) -> str:
        """比较 X 与 Y 两组译文，返回 X / Y / tie。"""
        first = self._cached("pairwise", pairwise_messages(sources, x, y), parse_winner)
        swapped = self._cached("pairwise", pairwise_messages(sources, y, x), parse_winner)
        return combine_orders(first, swapped)
