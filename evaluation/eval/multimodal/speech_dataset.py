"""E4 同传数据集：用 edge-tts 合成 data/speech/sentences.jsonl 的音频并转为 16 kHz 单声道 WAV。

用法：
    uv run python -m eval.multimodal.speech_dataset synth     # 合成缺失的音频
    uv run python -m eval.multimodal.speech_dataset check     # 校验 40 条记录与音频齐全

合成音色刻意与平台播报默认音色不同（播报用女声，这里用男声），避免"自己听自己"。
"""

import asyncio
import json
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

DATA = Path(__file__).resolve().parents[2] / "data" / "speech"
AUDIO = DATA / "audio"
SAMPLE_RATE = 16000

VOICES = {
    "zh": "zh-CN-YunxiNeural",
    "en": "en-US-GuyNeural",
    "ja": "ja-JP-KeitaNeural",
    "ko": "ko-KR-InJoonNeural",
}


def load_sentences() -> list[dict]:
    with open(DATA / "sentences.jsonl", encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def wav_path(sid: str) -> Path:
    return AUDIO / f"{sid}.wav"


def wav_seconds(path: Path) -> float:
    with wave.open(str(path)) as w:
        return w.getnframes() / w.getframerate()


def read_pcm16(path: Path) -> bytes:
    """读取 16 kHz 单声道 PCM16 WAV 的原始采样。"""
    with wave.open(str(path)) as w:
        if w.getframerate() != SAMPLE_RATE or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError(f"{path.name} 不是 16 kHz 单声道 PCM16")
        return w.readframes(w.getnframes())


async def _synth_one(text: str, voice: str, mp3: Path) -> None:
    import edge_tts

    await edge_tts.Communicate(text, voice).save(str(mp3))


def _to_wav(mp3: Path, out: Path) -> None:
    import imageio_ffmpeg

    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    subprocess.run([ffmpeg, "-loglevel", "error", "-y", "-i", str(mp3), "-ar", str(SAMPLE_RATE), "-ac", "1",
                    "-sample_fmt", "s16", str(out)], check=True)


async def synth(force: bool = False) -> int:
    AUDIO.mkdir(parents=True, exist_ok=True)
    done = failed = 0
    with tempfile.TemporaryDirectory() as tmp:
        for s in load_sentences():
            out = wav_path(s["id"])
            if out.exists() and not force:
                continue
            mp3 = Path(tmp) / f"{s['id']}.mp3"
            for attempt in range(5):
                try:
                    await _synth_one(s["text"], VOICES[s["lang"]], mp3)
                    break
                except Exception as e:  # noqa: BLE001  edge-tts 偶发 403 / 限流时不返回音频
                    print(f"  {s['id']} 第 {attempt + 1} 次失败：{e}")
                    await asyncio.sleep(5 * (attempt + 1))
            else:
                print(f"{s['id']} 合成失败，跳过（可稍后重跑 synth 补齐）", file=sys.stderr)
                failed += 1
                continue
            _to_wav(mp3, out)
            done += 1
            print(f"{s['id']} {wav_seconds(out):.2f}s")
            await asyncio.sleep(1.5)  # 句间间隔，降低被限流的概率
    print(f"新合成 {done} 条，失败 {failed} 条")
    return 1 if failed else 0


def check() -> list[str]:
    """返回问题列表（为空表示数据集完整）。"""
    problems = []
    rows = load_sentences()
    if len(rows) != 40:
        problems.append(f"应有 40 条，实际 {len(rows)} 条")
    for lang in VOICES:
        n = sum(1 for r in rows if r["lang"] == lang)
        if n != 10:
            problems.append(f"{lang} 应有 10 条，实际 {n} 条")
    for r in rows:
        for k in ("id", "lang", "text", "targetLang", "reference"):
            if not r.get(k):
                problems.append(f"{r.get('id')} 缺少 {k}")
        p = wav_path(r["id"])
        if not p.exists():
            problems.append(f"{r['id']} 缺少音频")
            continue
        try:
            read_pcm16(p)
        except ValueError as e:
            problems.append(str(e))
    return problems


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    if cmd == "synth":
        sys.exit(asyncio.run(synth(force="--force" in sys.argv)))
    issues = check()
    print("\n".join(issues) if issues else "数据集完整：40 条记录与音频齐全")
    sys.exit(1 if issues else 0)
