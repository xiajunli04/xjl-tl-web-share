"""要求 LLM 输出 JSON 的辅助函数。

OpenAI 兼容协议通过 response_format 开启 JSON 模式；Anthropic 没有对应参数，只能靠提示词约束，
因此解析时需要容错（去掉 Markdown 代码块、截取第一个 {...}）。
"""

import json
import re
from typing import Any

from app.llm.openai_compat import OpenAICompatibleClient

_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)


def json_mode_extra(client: Any) -> dict[str, Any]:
    if isinstance(client, OpenAICompatibleClient):
        return {"response_format": {"type": "json_object"}}
    return {}


def parse_json_object(text: str | None) -> dict[str, Any] | None:
    """解析 LLM 返回的 JSON 对象，失败返回 None。"""
    if not text:
        return None
    s = _FENCE.sub("", text.strip()).strip()
    candidates = [s]
    start, end = s.find("{"), s.rfind("}")
    if 0 <= start < end:
        candidates.append(s[start : end + 1])
    for c in candidates:
        try:
            obj = json.loads(c)
        except (ValueError, TypeError):
            continue
        if isinstance(obj, dict):
            return obj
    return None
