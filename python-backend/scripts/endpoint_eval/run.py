"""E6 离线断句评测（D10）：按音频时钟把样本以 40 ms 一帧送入断句组件，记录每个定稿。

对照组：
- baseline：改造前的旧行为——VAD 静音达到阈值即对该段识别，非空文本一律定稿（含"嗯。"）
- rules：两段式断句，只用文本强规则（不加载声学模型）
- smart：两段式断句，文本规则 + Smart Turn v3（模型缺失时跳过）

档位：interpret（同传·均衡）、fast（同传·极速）、chat（对话·均衡），参数取服务端配置（可用环境变量覆盖）。

判定延迟 = 定稿时的音频时刻 − 最后一段语音结束 + 该次处理的计算耗时（识别、判定）。
识别结果按（音频, 语种）缓存，三组共用，不影响判定（同一段音频识别结果相同）。
"""

import hashlib
import json
import time
from collections.abc import Callable
from typing import Any

import numpy as np

from app.core.config import get_settings
from app.speech.asr import AsrResult, LocalSenseVoiceASR
from app.speech.endpointing import Commit, Discard, Endpointer, EndpointProfile, Hold, TurnJudge, profile_for
from app.speech.smart_turn import load_turn_model
from app.speech.vad import VadSegmenter

from . import RESULTS_DIR, SAMPLE_RATE
from .data import PAUSE_DIR, load_manifest, read_wav, silence

FRAME = 640
TAIL_SILENCE_MS = 4000  # 推完样本后再送的静音（足够覆盖最长的续说等待）
GROUPS = ("baseline", "rules", "smart")
PROFILES = {"interpret": ("LISTEN", "balanced"), "fast": ("LISTEN", "fast"), "chat": ("CHAT", "balanced")}
RUNS = RESULTS_DIR / "e6_runs.jsonl"


class CachedASR:
    """SenseVoice 识别结果缓存：同一段音频（与语种提示）只识别一次。

    计时按"虚拟耗时"记账：每次调用都计入该段音频首次识别的实测耗时（不论是否命中缓存），
    这样各组、各档位的判定延迟口径一致，不受运行先后（缓存冷热）影响。
    """

    def __init__(self) -> None:
        self._asr = LocalSenseVoiceASR()
        self._cache: dict[tuple[str, str | None], AsrResult] = {}
        self.real_ms = 0.0  # 实际花在识别上的时间
        self.cost_ms = 0.0  # 记账的识别耗时

    async def transcribe(self, samples: np.ndarray, lang_hint: str | None = None) -> AsrResult:
        key = (hashlib.sha1(np.ascontiguousarray(samples).tobytes()).hexdigest(), lang_hint)
        start = time.perf_counter()
        hit = self._cache.get(key)
        if hit is None:
            hit = self._cache[key] = await self._asr.transcribe(samples, lang_hint)
        self.real_ms += (time.perf_counter() - start) * 1000
        self.cost_ms += hit.latency_ms
        return hit


class Stopwatch:
    """一次处理的计算耗时：墙钟时间中把识别的实际耗时换成记账耗时。"""

    def __init__(self, asr: CachedASR) -> None:
        self._asr = asr
        self._start = time.perf_counter()
        self._real, self._cost = asr.real_ms, asr.cost_ms

    def ms(self) -> float:
        wall = (time.perf_counter() - self._start) * 1000
        return wall - (self._asr.real_ms - self._real) + (self._asr.cost_ms - self._cost)


def frames(x: np.ndarray):
    for i in range(0, len(x), FRAME):
        yield x[i : i + FRAME]


async def run_legacy(audio: np.ndarray, lang: str, profile: EndpointProfile, asr: CachedASR) -> list[dict]:
    """改造前：VAD 段即一句，识别非空就定稿。"""
    vad = VadSegmenter(min_silence_ms=profile.candidate_silence_ms, max_speech_s=profile.max_speech_s)
    out: list[dict] = []
    pos = 0
    for f in frames(audio):
        pos += len(f)
        for seg in vad.accept(f):
            watch = Stopwatch(asr)
            res = await asr.transcribe(seg.samples, lang)
            compute = watch.ms()
            if res.text:
                decide = pos * 1000 / SAMPLE_RATE
                out.append(
                    {
                        "text": res.text,
                        "endMs": seg.end_ms,
                        "delayMs": round(decide - seg.end_ms + compute),
                        "holdMs": 0,
                        "reason": "vad",
                    }
                )
    for seg in vad.flush():
        res = await asr.transcribe(seg.samples, lang)
        if res.text:
            out.append({"text": res.text, "endMs": seg.end_ms, "delayMs": None, "holdMs": 0, "reason": "flush"})
    return out


async def run_endpointer(
    audio: np.ndarray, lang: str, profile: EndpointProfile, asr: CachedASR, judge: TurnJudge
) -> tuple[list[dict], dict]:
    vad = VadSegmenter(min_silence_ms=profile.candidate_silence_ms, max_speech_s=profile.max_speech_s)
    ep = Endpointer(vad, asr, judge, profile, hint=lambda: lang)
    out: list[dict] = []
    events = {"hold": 0, "discard": 0}
    pos = 0
    for f in frames(audio):
        watch = Stopwatch(asr)
        decisions = await ep.accept(f, lang)
        compute = watch.ms()
        pos += len(f)
        for d in decisions:
            if isinstance(d, Commit):
                decide = pos * 1000 / SAMPLE_RATE
                out.append(
                    {
                        "text": d.text,
                        "endMs": d.end_ms,
                        "delayMs": round(decide - d.end_ms + compute),
                        "holdMs": d.hold_ms,
                        "reason": d.reason,
                    }
                )
            elif isinstance(d, Hold):
                events["hold"] += 1
            elif isinstance(d, Discard):
                events["discard"] += 1
    for d in await ep.flush(lang):
        if isinstance(d, Commit):
            out.append({"text": d.text, "endMs": d.end_ms, "delayMs": None, "holdMs": d.hold_ms, "reason": "flush"})
    return out, events


def profile_of(name: str, group: str) -> EndpointProfile:
    mode, latency = PROFILES[name]
    p = profile_for(get_settings(), mode, latency)
    return p if group != "baseline" else EndpointProfile(p.candidate_silence_ms, 0, p.merge_max_s, p.max_speech_s)


def done_keys() -> set[tuple[str, str, str]]:
    if not RUNS.is_file():
        return set()
    keys = set()
    for line in RUNS.read_text(encoding="utf-8").splitlines():
        if line.strip():
            r = json.loads(line)
            keys.add((r["group"], r["profile"], r["id"]))
    return keys


async def run(
    groups: list[str],
    profiles: list[str],
    label: str | None = None,
    limit: int | None = None,
    log: Callable[[str], None] = print,
) -> int:
    settings = get_settings()
    manifest = load_manifest()[:limit] if limit else load_manifest()
    model = load_turn_model("on")
    if model is not None:
        await model.warmup()
    asr = CachedASR()
    await LocalSenseVoiceASR.warmup()
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    done = done_keys()
    tail = silence(TAIL_SILENCE_MS)
    n = 0
    with RUNS.open("a", encoding="utf-8") as fh:
        for group in groups:
            if group == "smart" and model is None:
                log("smart 组跳过：Smart Turn 模型未下载（uv run python -m app.speech.download）")
                fh.write(
                    json.dumps(
                        {"group": "smart", "profile": "*", "id": "*", "skipped": "Smart Turn 模型未下载"},
                        ensure_ascii=False,
                    )
                    + "\n"
                )
                continue
            judge = TurnJudge(
                model if group == "smart" else None,
                settings.endpoint_smart_turn_threshold,
                settings.endpoint_smart_turn_confident,
            )
            for pname in profiles:
                profile = profile_of(pname, group)
                for m in manifest:
                    tag = label or group
                    if (tag, pname, m["id"]) in done:
                        continue
                    audio = np.concatenate([read_wav(PAUSE_DIR / "audio" / f"{m['id']}.wav"), tail])
                    if group == "baseline":
                        commits, events = await run_legacy(audio, m["lang"], profile, asr), {}
                    else:
                        commits, events = await run_endpointer(audio, m["lang"], profile, asr, judge)
                    rec: dict[str, Any] = {
                        "group": tag,
                        "profile": pname,
                        "id": m["id"],
                        "variant": m["variant"],
                        "lang": m["lang"],
                        "expect": m["expect"],
                        "text": m["text"],
                        "commits": commits,
                        "events": events,
                        "params": {
                            "silence": profile.candidate_silence_ms,
                            "hold": profile.hold_ms,
                            "threshold": settings.endpoint_smart_turn_threshold,
                        },
                    }
                    fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
                    fh.flush()
                    n += 1
                log(f"{tag} / {pname}：完成")
    return n
