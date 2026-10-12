"""E4 / E5 指标：字错率、词错率、IoU 匹配、OCR 字符准确率、百分位数。"""

import re
import unicodedata
from collections.abc import Sequence

CJK_LANGS = {"zh", "ja", "ko", "yue"}
# 只保留文字与数字：标点、空白不计入错误率（ASR 输出常缺标点，评测只看字词）
_KEEP = re.compile(r"[\w]", re.UNICODE)


def normalize_chars(text: str) -> list[str]:
    """NFKC 归一化、转小写，去掉标点与空白，按字符切分（用于 CER）。"""
    t = unicodedata.normalize("NFKC", text).lower()
    return [c for c in t if _KEEP.match(c) and c != "_"]


def normalize_words(text: str) -> list[str]:
    """NFKC 归一化、转小写，去掉标点后按空白切词（用于英文 WER）。"""
    t = unicodedata.normalize("NFKC", text).lower()
    t = re.sub(r"[^\w\s']", " ", t)
    return t.split()


def edit_distance(a: Sequence[str], b: Sequence[str]) -> int:
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        for j, y in enumerate(b, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y))
        prev = cur
    return prev[-1]


def error_rate(reference: str, hypothesis: str, lang: str) -> float:
    """中日韩用字错率（CER），其他语言用词错率（WER）；参考为空时返回 0（假设也为空）或 1。"""
    if lang in CJK_LANGS:
        ref, hyp = normalize_chars(reference), normalize_chars(hypothesis)
    else:
        ref, hyp = normalize_words(reference), normalize_words(hypothesis)
    if not ref:
        return 0.0 if not hyp else 1.0
    return edit_distance(ref, hyp) / len(ref)


def char_accuracy(reference: str, hypothesis: str) -> float:
    """OCR 字符准确率 = max(0, 1 - CER)，不区分语言。"""
    ref, hyp = normalize_chars(reference), normalize_chars(hypothesis)
    if not ref:
        return 1.0 if not hyp else 0.0
    return max(0.0, 1.0 - edit_distance(ref, hyp) / len(ref))


Box = Sequence[float]


def iou(a: Box, b: Box) -> float:
    ix0, iy0 = max(a[0], b[0]), max(a[1], b[1])
    ix1, iy1 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix1 - ix0) * max(0.0, iy1 - iy0)
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def match_boxes(truth: Sequence[Box], pred: Sequence[Box], threshold: float = 0.5) -> list[tuple[int, int, float]]:
    """贪心一对一匹配：按 IoU 从高到低配对，只保留 IoU ≥ threshold 的对，返回 (真值下标, 预测下标, IoU)。"""
    pairs = sorted(((iou(t, p), i, j) for i, t in enumerate(truth) for j, p in enumerate(pred)), reverse=True)
    used_t: set[int] = set()
    used_p: set[int] = set()
    out: list[tuple[int, int, float]] = []
    for score, i, j in pairs:
        if score < threshold:
            break
        if i in used_t or j in used_p:
            continue
        used_t.add(i)
        used_p.add(j)
        out.append((i, j, score))
    return sorted(out)


def percentile(values: Sequence[float], q: float) -> float | None:
    """线性插值百分位数（q 取 0–100）；空序列返回 None。"""
    xs = sorted(v for v in values if v is not None)
    if not xs:
        return None
    k = (len(xs) - 1) * q / 100
    lo, hi = int(k), min(int(k) + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)
