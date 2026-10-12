"""评审结果的修正判定（design D5）：短文本 review 节点与文档分块评审共用。

按 MQM 严重度决定是否修正，满足其一即修正：
- 评审问题中存在 critical 或 major
- 规则检查发现未遵循的硬约束术语
- 总分低于兜底分 min_score

评审输出无法解析（score 为 None 且没有问题）时视为通过。
"""

from collections.abc import Iterable, Sequence
from typing import Any

BLOCKING_SEVERITIES = frozenset({"critical", "major"})
SEVERITIES = ("critical", "major", "minor")


def _severity(issue: Any) -> str:
    """问题可以是 ReviewIssue（短文本）或 dict（文档）。"""
    value = issue.get("severity") if isinstance(issue, dict) else getattr(issue, "severity", None)
    return str(value or "").strip().lower()


def needs_refine(score: int | None, issues: Iterable[Any], rule_issues: Sequence[Any], min_score: int) -> bool:
    if any(_severity(i) in BLOCKING_SEVERITIES for i in issues):
        return True
    if rule_issues:
        return True
    return score is not None and score < min_score


def severity_counts(issues: Iterable[Any]) -> dict[str, int]:
    """按严重度计数：{"critical": n, "major": n, "minor": n}；无法识别的严重度计为 minor（与解析规则一致）。"""
    counts = dict.fromkeys(SEVERITIES, 0)
    for i in issues:
        s = _severity(i)
        counts[s if s in counts else "minor"] += 1
    return counts
