"""E6 数据（D10）：由 evaluation/data/speech 的 40 句整句音频派生，切点只由原音频决定，可复现。

- V0 原句：完整句延迟基线（期望 1 个定稿）
- V1 句中停顿：在 35%–65% 区间 RMS 最低的 40 ms 窗口处切开**原始整句音频**，插入 600 / 900 / 1200 ms 静音
  （保留句中语调；不用分开合成的两个半句——那会带句末降调）。期望 1 个定稿
- V2 停顿 + 语气词：在切点插入合成的语气词（zh "嗯……"、en "um..."、ja "えーと"、ko "음"），
  两侧各 300 ms 静音。期望 1 个定稿
- V3 两句间隔：同场景相邻两句（第 1/2、3/4 句）之间留 700 ms 静音。期望 2 个定稿（测误合并）

语气词音频由 edge-tts 合成一次后随数据提交（fillers/*.wav）；派生音频（audio/）不入库，manifest.jsonl 入库。
"""

import asyncio
import json
import shutil
import subprocess
import tempfile
import wave
from pathlib import Path

import numpy as np

from . import PAUSE_DIR, SAMPLE_RATE, SPEECH_DIR

PAUSES_MS = (600, 900, 1200)
FILLER_GAP_MS = 300
PAIR_GAP_MS = 700
TAIL_MS = 300  # 每条样本前后补的静音（推流时另加足够长的尾部静音）
FILLERS = {
    "zh": ("嗯……", "zh-CN-YunxiNeural"),
    "en": ("Um...", "en-US-GuyNeural"),
    "ja": ("えーと", "ja-JP-KeitaNeural"),
    "ko": ("음…", "ko-KR-InJoonNeural"),
}


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path)) as w:
        assert w.getframerate() == SAMPLE_RATE and w.getnchannels() == 1
        return np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768


def write_wav(path: Path, x: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())


def silence(ms: int) -> np.ndarray:
    return np.zeros(ms * SAMPLE_RATE // 1000, dtype=np.float32)


def trim(x: np.ndarray, thr: float = 0.005) -> np.ndarray:
    """去掉首尾静音（统一起止，便于拼接）。"""
    idx = np.where(np.abs(x) > thr)[0]
    return x[idx[0] : idx[-1] + 1] if len(idx) else x


def split_point(x: np.ndarray) -> int:
    """在 35%–65% 区间内找 RMS 最低的 40 ms 窗口的中心作为切点（近似词边界）。"""
    win, hop = 640, 160
    lo, hi = int(len(x) * 0.35), int(len(x) * 0.65)
    best, at = float("inf"), len(x) // 2
    for s in range(lo, max(lo + 1, hi - win), hop):
        r = float(np.sqrt(np.mean(x[s : s + win] ** 2)))
        if r < best:
            best, at = r, s + win // 2
    return at


def load_sentences() -> list[dict]:
    return [
        json.loads(line)
        for line in (SPEECH_DIR / "sentences.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


async def _synth(text: str, voice: str, out: Path) -> None:
    import edge_tts

    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        import imageio_ffmpeg  # type: ignore[import-not-found]

        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    with tempfile.TemporaryDirectory() as tmp:
        mp3 = Path(tmp) / "f.mp3"
        await edge_tts.Communicate(text, voice, rate="-15%").save(str(mp3))
        out.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [
                ffmpeg,
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(mp3),
                "-ar",
                str(SAMPLE_RATE),
                "-ac",
                "1",
                "-sample_fmt",
                "s16",
                str(out),
            ],
            check=True,
        )


def filler_audio(lang: str) -> np.ndarray:
    path = PAUSE_DIR / "fillers" / f"{lang}.wav"
    if not path.is_file():
        text, voice = FILLERS[lang]
        asyncio.run(_synth(text, voice, path))
    return trim(read_wav(path))


def build() -> list[dict]:
    """生成全部变体音频与 manifest.jsonl，返回清单。"""
    rows = load_sentences()
    manifest: list[dict] = []
    audio_dir = PAUSE_DIR / "audio"
    pad = silence(TAIL_MS)

    def emit(sid: str, variant: str, x: np.ndarray, **meta) -> None:
        write_wav(audio_dir / f"{sid}.wav", np.concatenate([pad, x, pad]))
        manifest.append(
            {"id": sid, "variant": variant, **meta, "durationMs": int((len(x) + 2 * len(pad)) * 1000 / SAMPLE_RATE)}
        )

    for r in rows:
        x = trim(read_wav(SPEECH_DIR / "audio" / f"{r['id']}.wav"))
        cut = split_point(x)
        base = {"base": [r["id"]], "lang": r["lang"], "text": r["text"], "expect": 1}
        emit(f"{r['id']}-v0", "V0", x, **base)
        for gap in PAUSES_MS:
            emit(
                f"{r['id']}-v1-{gap}",
                "V1",
                np.concatenate([x[:cut], silence(gap), x[cut:]]),
                gapMs=gap,
                cutMs=cut * 1000 // SAMPLE_RATE,
                **base,
            )
        filler = filler_audio(r["lang"])
        g = silence(FILLER_GAP_MS)
        emit(
            f"{r['id']}-v2",
            "V2",
            np.concatenate([x[:cut], g, filler, g, x[cut:]]),
            cutMs=cut * 1000 // SAMPLE_RATE,
            **base,
        )

    scenes: dict[str, list[dict]] = {}
    for r in rows:
        scenes.setdefault(r["scene"], []).append(r)
    for scene, items in scenes.items():
        items.sort(key=lambda r: r["order"])
        for a, b in ((0, 1), (2, 3)):
            if b >= len(items):
                continue
            ra, rb = items[a], items[b]
            xa, xb = (
                trim(read_wav(SPEECH_DIR / "audio" / f"{ra['id']}.wav")),
                trim(read_wav(SPEECH_DIR / "audio" / f"{rb['id']}.wav")),
            )
            emit(
                f"{scene}-{ra['order']}{rb['order']}-v3",
                "V3",
                np.concatenate([xa, silence(PAIR_GAP_MS), xb]),
                base=[ra["id"], rb["id"]],
                lang=ra["lang"],
                text=ra["text"] + rb["text"] if ra["lang"] in ("zh", "ja") else f"{ra['text']} {rb['text']}",
                expect=2,
                gapMs=PAIR_GAP_MS,
            )
    (PAUSE_DIR / "manifest.jsonl").write_text(
        "\n".join(json.dumps(m, ensure_ascii=False) for m in manifest) + "\n", encoding="utf-8"
    )
    return manifest


def load_manifest() -> list[dict]:
    path = PAUSE_DIR / "manifest.jsonl"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
