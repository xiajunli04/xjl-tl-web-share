"""
数字人立绘资源生成（rework-avatar-portrait-rig）：调用 v36 NanoBanana Pro 图像编辑接口。

流程（每个形象）：
  1. base：正面半身、闭口微笑、无耳机、纯净浅紫背景的立绘（中文形象由主视觉概念图得到，其他由语言头像表得到）
  2. 以 base 为输入做"只改局部"的编辑，得到嘴型 / 眼睛 / 表情变体，以及抠像蒙版与深度图
  3. 原始 PNG 存到 web/.avatar-src/<id>/（不入库），再由 build.py 裁切压缩到 public/avatars/<id>/

用法（需要 ~/.claude/skills/v36-api-tools 及其 .env 中的 V36_API_KEY）：
  uv run --project ../python-backend python scripts/avatar/generate.py [zh en ja ko] [--only base|variants] [--force]
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

WEB = Path(__file__).resolve().parents[2]
SRC = WEB / ".avatar-src"
CONCEPTS = WEB.parent / "docs" / "design" / "avatar-concepts"
CLI = Path.home() / ".claude" / "skills" / "v36-api-tools" / "scripts" / "v36-nanobanana-cli.py"
MODEL = "nano-banana-pro"

KEEP = (
    "Keep everything else pixel-identical: the same framing, pose, face shape, hair, accessories, clothes, lighting "
    "and background. Do not move, zoom, crop, rotate or shift anything."
)

FRAMING = (
    "Front-facing half-body portrait centered in frame, head straight and level looking directly at the viewer, "
    "framed from the top of the head (with some headroom) down to the waist, exactly the same framing, scale, "
    "camera height and head position as the second attached image. Expression: gentle calm closed-mouth smile, "
    "eyes fully open. No earpiece or headset (bare ears). Background: plain soft lavender-white radial gradient, "
    "clean and empty, no text."
)

# 形象：头像表中的描述（用于定位与 1:1 复刻）
CHARACTERS = {
    "zh": None,  # 中文形象的 base 由主视觉单独生成（见 BASE_ZH）
    "en": "the character labeled 'English' (blonde long wavy hair, navy tailored blazer over a white shirt, small flag pin)",
    "ja": "the character labeled '日本語' (dark hair in an elegant updo with pink floral kanzashi hair ornaments, pale pink floral kimono)",
    "ko": "the character labeled '한국어' (black hair neatly tied back with an ornamental hair pin, hanbok with a green jeogori and a pink otgoreum ribbon)",
}

BASE_ZH = (
    "Recreate the attached character 1:1 — exactly the same face, eyes, makeup, hairstyle, hairpins with tassels, "
    "earrings, white qinghua blue-and-white porcelain cheongsam and the same premium semi-realistic anime 2.5D CG "
    "rendering. Remove the earpiece completely; no globe, no speech bubbles, no orbit rings, no text. "
)

VARIANTS = {
    "mouth-small": "ONLY change her mouth: lips slightly parted as when softly saying 'n' or 'i', a very small opening.",
    "mouth-aa": "ONLY change her mouth: she is speaking, mouth naturally open as when saying the vowel 'ah', teeth slightly visible, friendly expression.",
    "mouth-oh": "ONLY change her mouth: rounded open lips as when saying the vowel 'oh', friendly expression.",
    "mouth-ee": "ONLY change her mouth: lips spread in a speaking smile showing the upper teeth as when saying 'ee'.",
    "eyes-closed": "ONLY change her eyes: both eyes gently closed as in a natural blink, eyelashes down. The mouth stays exactly as it is.",
    "eyes-up": "ONLY change her eyes: both irises look up and slightly to the side as if thinking. The mouth stays exactly as it is.",
    "happy": "ONLY change her facial expression: a joyful bright open-mouth smile with eyes smiling into soft crescents.",
    "matte": (
        "Convert this exact image into an alpha matte with exactly the same framing: the person, including every hair "
        "strand, hair ornaments, earrings and clothing, filled pure white; the entire background pure black. Only soft "
        "anti-aliased gray at the silhouette edges, no other details or shading."
    ),
    "depth": (
        "Convert this exact image into a smooth grayscale monocular depth map with exactly the same framing: nearer "
        "surfaces brighter, farther surfaces darker, the background pure black, no texture details, soft gradients "
        "on the face (nose brightest), hair and clothing."
    ),
}


def run_cli(prompt: str, inputs: list[Path], out: Path, ratio: str = "3:4", retries: int = 3) -> bool:
    for attempt in range(1, retries + 1):
        with tempfile.TemporaryDirectory() as tmp:
            cmd = [
                sys.executable, str(CLI), "edit", prompt,
                "--model", MODEL, "--size", "2K", "--aspect-ratio", ratio,
                "-d", tmp, "--", *map(str, inputs),
            ]
            try:
                subprocess.run(cmd, cwd=CLI.parent.parent, check=True, capture_output=True, timeout=420)
                img = next(Path(tmp).glob("image_*"), None)
                if img:
                    out.parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(img), out)
                    print(f"  ✓ {out.relative_to(WEB)}", flush=True)
                    return True
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
                print(f"  ! {out.name} 第 {attempt} 次失败：{type(e).__name__}", flush=True)
        time.sleep(5 * attempt)
    print(f"  ✗ {out.name} 生成失败", flush=True)
    return False


def gen_base(cid: str, force: bool) -> bool:
    out = SRC / cid / "base.png"
    if out.exists() and not force:
        return True
    if cid == "zh":
        return run_cli(BASE_ZH + FRAMING.replace("as the second attached image", "as a standard portrait"),
                       [CONCEPTS / "11-guofeng-hero.webp"], out)
    zh = SRC / "zh" / "base.png"
    prompt = (
        f"From the first attached avatar sheet, recreate {CHARACTERS[cid]} 1:1 — exactly the same face, eyes, makeup, "
        "skin tone, hairstyle, accessories and outfit — rendered in exactly the same premium semi-realistic anime 2.5D "
        f"CG style and soft lighting as the second attached image. {FRAMING}"
    )
    return run_cli(prompt, [CONCEPTS / "12-language-avatars.webp", zh], out)


def gen_variants(cid: str, force: bool) -> None:
    base = SRC / cid / "base.png"
    todo = [(k, p) for k, p in VARIANTS.items() if force or not (SRC / cid / f"{k}.png").exists()]
    with ThreadPoolExecutor(max_workers=3) as pool:
        for k, p in todo:
            prompt = f"Edit this exact image minimally. {p}" + ("" if k in ("matte", "depth") else f" {KEEP}")
            pool.submit(run_cli, prompt, [base], SRC / cid / f"{k}.png")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("ids", nargs="*", default=list(CHARACTERS))
    ap.add_argument("--only", choices=["base", "variants"])
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    # 中文 base 是其他形象的构图参照，先生成
    if args.only != "variants":
        if "zh" in args.ids:
            gen_base("zh", args.force)
        with ThreadPoolExecutor(max_workers=3) as pool:
            list(pool.map(lambda c: gen_base(c, args.force), [c for c in args.ids if c != "zh"]))
    if args.only != "base":
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda c: gen_variants(c, args.force), args.ids))


if __name__ == "__main__":
    main()
