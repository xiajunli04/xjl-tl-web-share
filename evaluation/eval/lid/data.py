"""语种识别样本（design D3）：从 FLORES-200 devtest 生成 15 种语种 × 三档长度 × 100 条样本。

- 单词：有空格的语言取 ≥5 个字母的词（去掉首尾标点，不含数字）；中日泰无空格语言取 2–4 个字
- 词组：有空格的语言取句中连续 2–3 个词；中日泰取 5–10 个字
- 整句：devtest 原句
- “字”按字素簇计：泰文的元音符号、声调符号（Unicode Mn/Mc）与前一个字符合为一个字，截取时不会把它们切开
- 每种语种、每档用 ``random.Random(f"{SEED}-{flores}-{tier}")`` 独立抽样，两次运行结果完全相同

压缩包缓存在 ``evaluation/.cache/``（不入库），首次下载的 sha256 记录在 FLORES_SHA256 中并在之后校验。
下载失败且没有缓存时以非零状态退出，提示手动放置路径，不静默降级。

    uv run --no-sync python -m eval.lid.data      # 生成 data/lid/samples.jsonl 与 manifest.json
"""

from __future__ import annotations

import hashlib
import json
import random
import re
import sys
import tarfile
import time
import unicodedata
from collections.abc import Iterable
from pathlib import Path

import httpx

from eval.config import DATA_DIR, EVAL_ROOT

# FLORES-200 的下载地址、校验和与下载逻辑统一由 eval.dataset.flores 维护（与句子级测试集共用同一压缩包）
from eval.dataset.flores import FLORES_SHA256, FLORES_URL, ensure_tarball  # noqa: E402

CACHE_DIR = EVAL_ROOT / ".cache"
LID_DIR = DATA_DIR / "lid"
SAMPLES_PATH = LID_DIR / "samples.jsonl"
MANIFEST_PATH = LID_DIR / "manifest.json"

SEED = 20261003
PER_TIER = 100
TIERS = ("word", "phrase", "sentence")

# FLORES 语种代码 → 平台语种代码（ISO 639-1）
FLORES_TO_CODE: dict[str, str] = {
    "zho_Hans": "zh",
    "eng_Latn": "en",
    "jpn_Jpan": "ja",
    "kor_Hang": "ko",
    "fra_Latn": "fr",
    "deu_Latn": "de",
    "spa_Latn": "es",
    "rus_Cyrl": "ru",
    "por_Latn": "pt",
    "ita_Latn": "it",
    "arb_Arab": "ar",
    "tha_Thai": "th",
    "vie_Latn": "vi",
    "ind_Latn": "id",
    "tur_Latn": "tr",
}
CODES: tuple[str, ...] = tuple(FLORES_TO_CODE.values())
NO_SPACE = {"zho_Hans", "jpn_Jpan", "tha_Thai"}
WORD_CHARS = (2, 4)
PHRASE_CHARS = (5, 10)
PHRASE_WORDS = (2, 3)
MIN_WORD_LETTERS = 5


# ---------------------------------------------------------------- 下载与读取


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def download(url: str, dest: Path, *, retries: int = 5, expected_sha256: str | None = None) -> Path:
    """下载到 dest（已存在且校验通过时直接返回）；网络抖动时重试。校验失败或下载失败抛出 RuntimeError。"""
    if dest.exists():
        if expected_sha256 and sha256_of(dest) != expected_sha256:
            raise RuntimeError(f"{dest} 的 sha256 与记录不一致，请删除后重新下载")
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    last: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            with httpx.stream("GET", url, follow_redirects=True, timeout=60) as resp:
                resp.raise_for_status()
                with tmp.open("wb") as f:
                    for chunk in resp.iter_bytes(1 << 20):
                        f.write(chunk)
            if expected_sha256 and sha256_of(tmp) != expected_sha256:
                raise RuntimeError(f"下载的 {dest.name} sha256 不一致")
            tmp.replace(dest)
            return dest
        except (httpx.HTTPError, OSError) as e:
            last = e
            time.sleep(min(2**attempt, 20))
    tmp.unlink(missing_ok=True)
    raise RuntimeError(f"下载 {url} 失败：{last}。请手动下载并放置到 {dest}")


def flores_archive() -> Path:
    """FLORES-200 压缩包（下载、缓存与 sha256 校验见 eval.dataset.flores.ensure_tarball）。"""
    return ensure_tarball()


def read_devtest(archive: Path, langs: Iterable[str]) -> dict[str, list[str]]:
    """直接从压缩包读取 devtest 文件，不解压到磁盘。"""
    wanted = {f"flores200_dataset/devtest/{lang}.devtest": lang for lang in langs}
    out: dict[str, list[str]] = {}
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar:
            name = member.name.removeprefix("./")
            if name in wanted:
                f = tar.extractfile(member)
                assert f is not None
                out[wanted[name]] = f.read().decode("utf-8").splitlines()
    missing = set(wanted.values()) - set(out)
    if missing:
        raise RuntimeError(f"压缩包中缺少 devtest 文件：{sorted(missing)}")
    return out


# ---------------------------------------------------------------- 切分


def graphemes(text: str) -> list[str]:
    """简化的字素簇切分：组合符号（Mn/Mc/Me）并入前一个字符。"""
    out: list[str] = []
    for ch in text:
        if out and unicodedata.category(ch) in ("Mn", "Mc", "Me"):
            out[-1] += ch
        else:
            out.append(ch)
    return out


def _is_script_char(lang: str, ch: str) -> bool:
    o = ord(ch[0])
    if lang == "zho_Hans":
        return 0x4E00 <= o <= 0x9FFF or 0x3400 <= o <= 0x4DBF
    if lang == "jpn_Jpan":
        return 0x3040 <= o <= 0x30FF or 0x4E00 <= o <= 0x9FFF or 0x3400 <= o <= 0x4DBF
    if lang == "tha_Thai":
        return 0x0E01 <= o <= 0x0E4E and ch[0] not in "ฯๆ"  # 去掉省略符与重复符
    raise ValueError(lang)


def script_runs(lang: str, sentence: str) -> list[list[str]]:
    """无空格语言：按字素簇切分后，取连续的本文字字符串（遇到标点、数字、拉丁字母、空格即断开）。"""
    runs: list[list[str]] = []
    current: list[str] = []
    for g in graphemes(sentence):
        if _is_script_char(lang, g):
            current.append(g)
        elif current:
            runs.append(current)
            current = []
    if current:
        runs.append(current)
    return runs


def _strip_punct(token: str) -> str:
    start, end = 0, len(token)
    while start < end and not unicodedata.category(token[start]).startswith(("L", "M")):
        start += 1
    while end > start and not unicodedata.category(token[end - 1]).startswith(("L", "M")):
        end -= 1
    return token[start:end]


_HAS_DIGIT = re.compile(r"\d")


def clean_words(sentence: str) -> list[str | None]:
    """有空格语言：按空白切词并去掉首尾标点；含数字或去标点后为空的词记为 None（作为词组的断点）。"""
    words: list[str | None] = []
    for tok in sentence.split():
        w = _strip_punct(tok)
        words.append(w if w and not _HAS_DIGIT.search(tok) and any(c.isalpha() for c in w) else None)
    return words


def letter_count(word: str) -> int:
    return sum(1 for c in word if c.isalpha())


def _word_char(c: str) -> bool:
    return c.isalpha() or unicodedata.category(c).startswith("M") or c in "'’-"


def word_candidates(lang: str, sentences: list[str]) -> list[str]:
    if lang in NO_SPACE:
        raise ValueError("无空格语言按字数截取")
    seen: dict[str, None] = {}
    for s in sentences:
        for w in clean_words(s):
            if w and letter_count(w) >= MIN_WORD_LETTERS and all(_word_char(c) for c in w):
                seen.setdefault(w, None)
    return list(seen)


def phrase_candidates(sentences: list[str]) -> list[str]:
    seen: dict[str, None] = {}
    for s in sentences:
        words = clean_words(s)
        for n in range(PHRASE_WORDS[0], PHRASE_WORDS[1] + 1):
            for i in range(len(words) - n + 1):
                window = words[i : i + n]
                if all(window):
                    seen.setdefault(" ".join(window), None)  # type: ignore[arg-type]
    return list(seen)


def _substring_samples(lang: str, sentences: list[str], bounds: tuple[int, int], rng: random.Random) -> list[str]:
    """无空格语言：随机选句子与本文字字符串，截取 bounds 范围内随机长度的连续子串，去重直到 100 条。"""
    runs = [r for s in sentences for r in script_runs(lang, s) if len(r) >= bounds[0]]
    seen: dict[str, None] = {}
    attempts = 0
    while len(seen) < PER_TIER:
        attempts += 1
        if attempts > 100_000:
            raise RuntimeError(f"{lang} 无法生成 {PER_TIER} 条长度 {bounds} 的样本")
        run = rng.choice(runs)
        length = rng.randint(bounds[0], min(bounds[1], len(run)))
        start = rng.randint(0, len(run) - length)
        seen.setdefault("".join(run[start : start + length]), None)
    return list(seen)


def _sample(pool: list[str], rng: random.Random, lang: str, tier: str) -> list[str]:
    if len(pool) < PER_TIER:
        raise RuntimeError(f"{lang} {tier} 候选只有 {len(pool)} 条")
    return rng.sample(pool, PER_TIER)


def build_samples(devtest: dict[str, list[str]], seed: int = SEED) -> list[dict]:
    records: list[dict] = []
    for flores, code in FLORES_TO_CODE.items():
        sentences = [s.strip() for s in devtest[flores] if s.strip()]
        for tier in TIERS:
            rng = random.Random(f"{seed}-{flores}-{tier}")
            if tier == "sentence":
                texts = _sample(sentences, rng, flores, tier)
            elif flores in NO_SPACE:
                texts = _substring_samples(flores, sentences, WORD_CHARS if tier == "word" else PHRASE_CHARS, rng)
            elif tier == "word":
                texts = _sample(word_candidates(flores, sentences), rng, flores, tier)
            else:
                texts = _sample(phrase_candidates(sentences), rng, flores, tier)
            for i, text in enumerate(texts):
                records.append(
                    {"id": f"{flores}-{tier}-{i:03d}", "flores": flores, "lang": code, "tier": tier, "text": text}
                )
    return records


def write_samples(records: list[dict], path: Path = SAMPLES_PATH) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in records)
    path.write_bytes(data.encode("utf-8"))
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


def load_samples(path: Path = SAMPLES_PATH) -> list[dict]:
    with path.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def main() -> int:
    try:
        archive = flores_archive()
    except RuntimeError as e:
        print(f"[错误] {e}", file=sys.stderr)
        return 2
    devtest = read_devtest(archive, FLORES_TO_CODE)
    records = build_samples(devtest)
    digest = write_samples(records)
    manifest = {
        "source": {"name": "FLORES-200 devtest", "url": FLORES_URL, "sha256": FLORES_SHA256},
        "seed": SEED,
        "languages": FLORES_TO_CODE,
        "tiers": {
            "word": f"有空格语言：≥{MIN_WORD_LETTERS} 个字母的词；中日泰：{WORD_CHARS[0]}–{WORD_CHARS[1]} 个字",
            "phrase": (
                f"有空格语言：连续 {PHRASE_WORDS[0]}–{PHRASE_WORDS[1]} 个词；"
                f"中日泰：{PHRASE_CHARS[0]}–{PHRASE_CHARS[1]} 个字"
            ),
            "sentence": "devtest 原句",
        },
        "per_tier": PER_TIER,
        "count": len(records),
        "samples_sha256": digest,
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"写入 {len(records)} 条样本 → {SAMPLES_PATH}（sha256 {digest}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
