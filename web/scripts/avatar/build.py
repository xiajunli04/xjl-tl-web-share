"""
数字人立绘资源构建（rework-avatar-portrait-rig D2）：web/.avatar-src/<id>/*.png → public/avatars/<id>/

产物：
  base.webp     立绘 RGB + 抠像蒙版 alpha（长边 1600）
  depth.webp    平滑后的深度图（灰度，长边 512）
  atlas.webp    局部图层图集（嘴型 / 眼睛 / 表情，带羽化 alpha，已做颜色校正）
  face.webp     脸部特写小头像（256px，芯片 / 气泡 / 卡片用，避免为小头像加载整张立绘）
  manifest.json { size:[w,h], face:[x,y,w,h], layers:[{name, dst:[x,y,w,h], src:[x,y,w,h]}] }（坐标均归一化到 0–1）
  preview.png   人工检查用：各图层合成后的脸部拼图（不入库）

用法：uv run --project ../python-backend python scripts/avatar/build.py [zh en ja ko]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

WEB = Path(__file__).resolve().parents[2]
SRC = WEB / ".avatar-src"
OUT = WEB / "public" / "avatars"

BASE_LONG = 1600
DEPTH_LONG = 512
MOUTH_LAYERS = ["mouth-small", "mouth-aa", "mouth-oh", "mouth-ee"]
EYE_LAYERS = ["eyes-closed", "eyes-up"]
FACE_LAYERS = ["happy"]
THRESH = 28  # 模糊后的 RGB 差分和阈值
DILATE = 6
FEATHER = 10


def load(cid: str, name: str, size: tuple[int, int]) -> np.ndarray:
    im = Image.open(SRC / cid / f"{name}.png").convert("RGB")
    if im.size != size:
        im = im.resize(size, Image.LANCZOS)
    return np.asarray(im).astype(np.float32)


def diff_map(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    d = np.abs(a - b).sum(2)
    return np.asarray(Image.fromarray(np.clip(d, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(3))).astype(np.float32)


def centroid(d: np.ndarray, region: tuple[float, float, float, float], spread_x: float = 0.08) -> tuple[float, float]:
    """在相对区域内找成片变化的中心：大半径模糊后取峰值（细碎的发丝重绘噪声被抹平），再取峰值附近强响应的质心。"""
    h, w = d.shape
    x0, y0, x1, y1 = int(region[0] * w), int(region[1] * h), int(region[2] * w), int(region[3] * h)
    blur = np.asarray(Image.fromarray(np.clip(d, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(18))).astype(np.float32)
    sub = blur[y0:y1, x0:x1]
    py, px = np.unravel_index(np.argmax(sub), sub.shape)
    ys, xs = np.nonzero(sub >= sub[py, px] * 0.6)
    near = (np.abs(ys - py) < h * 0.05) & (np.abs(xs - px) < w * spread_x)
    return x0 + xs[near].mean(), y0 + ys[near].mean()


def window(cx: float, cy: float, hw: float, hh: float, w: int, h: int) -> tuple[int, int, int, int]:
    return max(0, int(cx - hw)), max(0, int(cy - hh)), min(w, int(cx + hw)), min(h, int(cy + hh))


def layer_alpha(d: np.ndarray, win: tuple[int, int, int, int]) -> np.ndarray:
    """窗口内的差分掩膜：阈值 → 膨胀 → 羽化；窗口外为 0，并对窗口边缘做渐隐。"""
    h, w = d.shape
    m = np.zeros((h, w), np.uint8)
    x0, y0, x1, y1 = win
    m[y0:y1, x0:x1] = (d[y0:y1, x0:x1] > THRESH).astype(np.uint8) * 255
    im = Image.fromarray(m).filter(ImageFilter.MaxFilter(DILATE * 2 + 1)).filter(ImageFilter.GaussianBlur(FEATHER))
    a = np.asarray(im).astype(np.float32) / 255
    # 窗口边缘 24px 线性渐隐，避免掩膜被窗口截断出硬边
    edge = np.zeros((h, w), np.float32)
    yy, xx = np.mgrid[0:h, 0:w]
    dx = np.minimum(xx - x0, x1 - 1 - xx)
    dy = np.minimum(yy - y0, y1 - 1 - yy)
    edge = np.clip(np.minimum(dx, dy) / 24, 0, 1)
    return a * edge


def color_match(base: np.ndarray, var: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """用掩膜外环（0.05<α<0.5）上的逐通道增益校正变体的整体色偏。"""
    ring = (alpha > 0.05) & (alpha < 0.5)
    if ring.sum() < 50:
        return var
    gain = (base[ring].mean(0) + 1) / (var[ring].mean(0) + 1)
    return np.clip(var * np.clip(gain, 0.9, 1.1), 0, 255)


def bbox(alpha: np.ndarray, pad: int = 2) -> tuple[int, int, int, int]:
    ys, xs = np.nonzero(alpha > 0.01)
    h, w = alpha.shape
    return max(0, xs.min() - pad), max(0, ys.min() - pad), min(w, xs.max() + pad + 1), min(h, ys.max() + pad + 1)


def pack(tiles: list[tuple[str, Image.Image]], width: int = 1024) -> tuple[Image.Image, dict[str, tuple[int, int, int, int]]]:
    """简单的行装箱。"""
    x = y = row_h = 0
    pos: dict[str, tuple[int, int, int, int]] = {}
    for name, im in sorted(tiles, key=lambda t: -t[1].height):
        if x + im.width > width:
            x, y, row_h = 0, y + row_h + 2, 0
        pos[name] = (x, y, im.width, im.height)
        x += im.width + 2
        row_h = max(row_h, im.height)
    atlas = Image.new("RGBA", (width, y + row_h), (0, 0, 0, 0))
    for name, im in tiles:
        px, py, _, _ = pos[name]
        atlas.paste(im, (px, py))
    return atlas, pos


def build(cid: str) -> None:
    src_base = Image.open(SRC / cid / "base.png").convert("RGB")
    scale = BASE_LONG / max(src_base.size)
    size = (round(src_base.width * scale), round(src_base.height * scale))
    W, H = size
    base = load(cid, "base", size)

    # 嘴、眼中心：张嘴与闭眼的强差分质心（限定在画面中央的脸部大致范围内）
    d_aa = diff_map(base, load(cid, "mouth-aa", size))
    d_eye = diff_map(base, load(cid, "eyes-closed", size))
    mx, my = centroid(d_aa, (0.25, 0.12, 0.75, 0.5))
    # 双眼间距较大：邻域放宽到能同时包含两只眼睛
    ex, ey = centroid(d_eye, (0.25, 0.08, 0.75, (my - H * 0.03) / H), spread_x=0.16)
    face_h = (my - ey) * 3.2  # 眼到嘴约占脸高的 31%
    mouth_win = window(mx, my, face_h * 0.30, face_h * 0.17, W, H)
    eye_win = window(ex, ey, face_h * 0.48, face_h * 0.15, W, H)
    face_win = (min(mouth_win[0], eye_win[0]), eye_win[1], max(mouth_win[2], eye_win[2]), mouth_win[3])

    tiles: list[tuple[str, Image.Image]] = []
    dst: dict[str, tuple[int, int, int, int]] = {}
    previews: list[tuple[str, np.ndarray]] = []
    for names, win in ((MOUTH_LAYERS, mouth_win), (EYE_LAYERS, eye_win), (FACE_LAYERS, face_win)):
        for name in names:
            var = load(cid, name, size)
            a = layer_alpha(diff_map(base, var), win)
            var = color_match(base, var, a)
            x0, y0, x1, y1 = bbox(a)
            rgba = np.dstack([var[y0:y1, x0:x1], a[y0:y1, x0:x1] * 255]).astype(np.uint8)
            tiles.append((name, Image.fromarray(rgba, "RGBA")))
            dst[name] = (x0, y0, x1 - x0, y1 - y0)
            comp = base.copy()
            comp[y0:y1, x0:x1] = base[y0:y1, x0:x1] * (1 - a[y0:y1, x0:x1, None]) + var[y0:y1, x0:x1] * a[y0:y1, x0:x1, None]
            previews.append((name, comp))

    atlas, src_pos = pack(tiles)
    out = OUT / cid
    out.mkdir(parents=True, exist_ok=True)
    atlas.save(out / "atlas.webp", "WEBP", quality=88, method=6)

    matte = Image.open(SRC / cid / "matte.png").convert("L").resize(size, Image.LANCZOS).filter(ImageFilter.GaussianBlur(1.2))
    base_im = Image.fromarray(base.astype(np.uint8)).convert("RGBA")
    base_im.putalpha(matte)
    base_im.save(out / "base.webp", "WEBP", quality=86, method=6)

    depth = Image.open(SRC / cid / "depth.png").convert("L")
    dscale = DEPTH_LONG / max(depth.size)
    depth = depth.resize((round(depth.width * dscale), round(depth.height * dscale)), Image.LANCZOS).filter(ImageFilter.GaussianBlur(3))
    depth.save(out / "depth.webp", "WEBP", quality=90)

    face = (face_win[0] / W, face_win[1] / H, (face_win[2] - face_win[0]) / W, (face_win[3] - face_win[1]) / H)

    # 小头像：脸部特写（与 lib/avatar/view.ts 的 "face" 构图一致），256px 正方形，带透明背景
    side = face[3] * 1.45 * H
    fcx, fcy = (face[0] + face[2] / 2) * W, (face[1] + face[3] / 2 - face[3] * 0.08) * H
    box = (round(fcx - side / 2), round(fcy - side / 2), round(fcx + side / 2), round(fcy + side / 2))
    base_im.crop(box).resize((256, 256), Image.LANCZOS).save(out / "face.webp", "WEBP", quality=88, method=6)
    aw, ah = atlas.size
    manifest = {
        "id": cid,
        "size": [W, H],
        "face": [round(v, 4) for v in face],
        "mouth": [round(mx / W, 4), round(my / H, 4)],
        "eyes": [round(ex / W, 4), round(ey / H, 4)],
        "layers": [
            {
                "name": name,
                "dst": [round(dst[name][0] / W, 5), round(dst[name][1] / H, 5), round(dst[name][2] / W, 5), round(dst[name][3] / H, 5)],
                "src": [round(src_pos[name][0] / aw, 5), round(src_pos[name][1] / ah, 5), round(src_pos[name][2] / aw, 5), round(src_pos[name][3] / ah, 5)],
            }
            for name, _ in tiles
        ],
    }
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    # 预览：脸部窗口的合成效果拼图（人工检查对齐与色差）
    fx0, fy0, fx1, fy1 = window((face_win[0] + face_win[2]) / 2, (face_win[1] + face_win[3]) / 2, face_h * 0.7, face_h * 0.6, W, H)
    cells = [("base", base)] + previews
    cw, ch = fx1 - fx0, fy1 - fy0
    sheet = Image.new("RGB", (cw * 4, ch * ((len(cells) + 3) // 4)), "white")
    for i, (_, img) in enumerate(cells):
        sheet.paste(Image.fromarray(img[fy0:fy1, fx0:fx1].astype(np.uint8)), ((i % 4) * cw, (i // 4) * ch))
    sheet.save(SRC / cid / "preview.png")
    kb = {p.name: round(p.stat().st_size / 1024) for p in out.iterdir()}
    print(f"{cid}: size={size} mouth=({mx:.0f},{my:.0f}) eyes=({ex:.0f},{ey:.0f}) files(KB)={kb}")


if __name__ == "__main__":
    for cid in sys.argv[1:] or ["zh", "en", "ja", "ko"]:
        build(cid)
