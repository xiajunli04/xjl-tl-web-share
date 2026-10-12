"""E5 图片翻译数据集：用 Pillow 渲染告示、菜单、商品标签三类合成图片，并输出真值文本块与参考译文。

用法：
    uv run python -m eval.multimodal.image_dataset render   # 生成 data/image/images/*.png 与 truth.jsonl
    uv run python -m eval.multimodal.image_dataset check    # 校验图片与真值齐全、坐标合法

每张图 3–6 行文字，每行一个真值块（文本、像素 bbox、归一化 bbox、参考译文）。变化维度：字体、文字/背景颜色、
渐变与噪点背景、±3° 小角度倾斜（倾斜后 bbox 取旋转后四角的外接矩形）。随机种子固定，结果可复现。
"""

import json
import math
import random
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

DATA = Path(__file__).resolve().parents[2] / "data" / "image"
IMAGES = DATA / "images"
FONTS = Path("C:/Windows/Fonts")

# 每种源语言可用的字体（文件名, 字体集索引）；按存在与否过滤
FONT_CANDIDATES = {
    "zh": [("msyh.ttc", 0), ("simhei.ttf", 0), ("simsun.ttc", 0), ("msyhbd.ttc", 0)],
    "ja": [("YuGothM.ttc", 0), ("meiryo.ttc", 0), ("msgothic.ttc", 0), ("YuGothB.ttc", 0)],
    "en": [("arial.ttf", 0), ("georgia.ttf", 0), ("verdana.ttf", 0), ("arialbd.ttf", 0), ("times.ttf", 0)],
}

# (场景, 源语言) → [(原文, 参考译文)]；目标：zh → en，en / ja → zh
POOLS: dict[tuple[str, str], list[tuple[str, str]]] = {
    ("menu", "zh"): [
        ("宫保鸡丁", "Kung Pao Chicken"), ("麻婆豆腐", "Mapo Tofu"), ("鱼香肉丝", "Yu-Shiang Shredded Pork"),
        ("西红柿炒鸡蛋", "Scrambled Eggs with Tomatoes"), ("酸辣汤", "Hot and Sour Soup"),
        ("扬州炒饭", "Yangzhou Fried Rice"), ("红烧肉", "Braised Pork Belly"), ("清蒸鲈鱼", "Steamed Sea Bass"),
        ("干煸四季豆", "Dry-Fried Green Beans"), ("小笼包", "Xiaolongbao"),
    ],
    ("menu", "en"): [
        ("Grilled Salmon", "烤三文鱼"), ("Caesar Salad", "凯撒沙拉"), ("Mushroom Soup", "蘑菇汤"),
        ("Beef Burger", "牛肉汉堡"), ("French Fries", "薯条"), ("Chocolate Cake", "巧克力蛋糕"),
        ("Iced Latte", "冰拿铁"), ("Fresh Orange Juice", "鲜榨橙汁"), ("Chicken Wings", "鸡翅"),
    ],
    ("menu", "ja"): [
        ("醤油ラーメン", "酱油拉面"), ("味噌汁", "味噌汤"), ("天ぷら盛り合わせ", "天妇罗拼盘"), ("親子丼", "亲子丼"),
        ("焼き鳥", "烤鸡肉串"), ("抹茶アイス", "抹茶冰淇淋"), ("餃子", "煎饺"), ("カレーライス", "咖喱饭"),
        ("生ビール", "生啤酒"),
    ],
    ("sign", "zh"): [
        ("禁止吸烟", "No Smoking"), ("出口", "Exit"), ("小心地滑", "Caution: Wet Floor"), ("请勿触摸", "Do Not Touch"),
        ("紧急出口", "Emergency Exit"), ("洗手间", "Restroom"), ("请排队", "Please Queue Here"),
        ("施工中", "Under Construction"), ("停车场", "Parking"), ("闲人免进", "Staff Only"),
    ],
    ("sign", "en"): [
        ("No Parking", "禁止停车"), ("Emergency Exit", "紧急出口"), ("Restrooms", "洗手间"), ("Keep Out", "禁止入内"),
        ("Wet Floor", "小心地滑"), ("Elevator", "电梯"), ("Information", "问询处"), ("Watch Your Step", "小心台阶"),
        ("Push", "推"), ("Pull", "拉"),
    ],
    ("sign", "ja"): [
        ("立入禁止", "禁止入内"), ("非常口", "紧急出口"), ("足元注意", "小心脚下"), ("撮影禁止", "禁止拍照"),
        ("お手洗い", "洗手间"), ("駐輪禁止", "禁止停放自行车"), ("工事中", "施工中"), ("出口", "出口"),
    ],
    ("label", "zh"): [
        ("有机绿茶", "Organic Green Tea"), ("净含量500毫升", "Net content: 500 ml"),
        ("保质期十二个月", "Shelf life: 12 months"), ("请置于阴凉干燥处", "Store in a cool, dry place"),
        ("开封后请冷藏", "Refrigerate after opening"), ("无添加防腐剂", "No added preservatives"),
        ("生产日期见瓶盖", "Production date: see cap"),
    ],
    ("label", "en"): [
        ("Organic Honey", "有机蜂蜜"), ("Net Wt. 250 g", "净重 250 克"), ("Keep refrigerated", "请冷藏保存"),
        ("Best before: see lid", "保质期见盖子"), ("Gluten free", "无麸质"), ("Made in New Zealand", "新西兰制造"),
        ("Shake well before use", "使用前请摇匀"), ("Contains nuts", "含坚果"),
    ],
    ("label", "ja"): [
        ("内容量 200ml", "净含量 200 毫升"), ("要冷蔵", "需冷藏"), ("無添加", "无添加"), ("日本製", "日本制造"),
        ("開封後はお早めにお召し上がりください", "开封后请尽快食用"),
        ("直射日光を避けて保存してください", "请避免阳光直射保存"),
        ("原材料名：緑茶", "配料：绿茶"),
    ],
}

# 评测术语表：E5 术语准确率只统计这些
GLOSSARY = [
    {"source": "宫保鸡丁", "target": "Kung Pao Chicken", "sourceLang": "zh", "targetLang": "en"},
    {"source": "麻婆豆腐", "target": "Mapo Tofu", "sourceLang": "zh", "targetLang": "en"},
    {"source": "小笼包", "target": "Xiaolongbao", "sourceLang": "zh", "targetLang": "en"},
    {"source": "Caesar Salad", "target": "凯撒沙拉", "sourceLang": "en", "targetLang": "zh"},
    {"source": "親子丼", "target": "亲子丼", "sourceLang": "ja", "targetLang": "zh"},
    {"source": "非常口", "target": "紧急出口", "sourceLang": "ja", "targetLang": "zh"},
]

TARGET = {"zh": "en", "en": "zh", "ja": "zh"}
PER_COMBO = 4  # 每个 (场景, 源语言) 生成 4 张 → 36 张

PALETTES = [  # (背景起, 背景止, 文字)
    ((250, 250, 245), (235, 232, 220), (30, 30, 30)),
    ((20, 60, 140), (10, 40, 100), (255, 255, 255)),
    ((200, 30, 40), (160, 20, 30), (255, 255, 255)),
    ((255, 215, 0), (240, 190, 0), (20, 20, 20)),
    ((30, 30, 30), (55, 55, 55), (240, 240, 240)),
    ((235, 245, 235), (210, 230, 210), (20, 80, 40)),
]


def _fonts(lang: str) -> list[tuple[Path, int]]:
    return [(FONTS / n, i) for n, i in FONT_CANDIDATES[lang] if (FONTS / n).exists()]


def _background(w: int, h: int, c0: tuple, c1: tuple, rng: random.Random) -> Image.Image:
    img = Image.new("RGB", (w, h), c0)
    d = ImageDraw.Draw(img)
    for y in range(h):  # 纵向渐变
        t = y / max(1, h - 1)
        d.line([(0, y), (w, y)], fill=tuple(int(c0[k] + (c1[k] - c0[k]) * t) for k in range(3)))
    if rng.random() < 0.5:  # 一半图片加轻微噪点
        noise = Image.effect_noise((w, h), 18).convert("RGB")
        img = Image.blend(img, noise, 0.06)
    return img


def _rotate_point(x: float, y: float, cx: float, cy: float, deg: float) -> tuple[float, float]:
    # 与 PIL Image.rotate(angle) 一致：逆时针旋转 angle 度（图像坐标 y 向下）
    rad = math.radians(deg)
    dx, dy = x - cx, y - cy
    return cx + dx * math.cos(rad) + dy * math.sin(rad), cy - dx * math.sin(rad) + dy * math.cos(rad)


def render_one(scene: str, lang: str, idx: int, rng: random.Random) -> dict:
    pool = POOLS[(scene, lang)]
    n = rng.randint(3, min(6, len(pool)))
    items = rng.sample(pool, n)
    font_path, font_index = rng.choice(_fonts(lang))
    c0, c1, fg = rng.choice(PALETTES)
    size = rng.choice([30, 34, 38, 44])
    font = ImageFont.truetype(str(font_path), size, index=font_index)

    pad, gap = 48, int(size * 0.7)
    probe = ImageDraw.Draw(Image.new("RGB", (10, 10)))
    widths = [probe.textbbox((0, 0), t, font=font)[2] for t, _ in items]
    w = max(560, max(widths) + pad * 2)
    h = pad * 2 + n * size + (n - 1) * gap
    img = _background(w, h, c0, c1, rng)
    d = ImageDraw.Draw(img)

    blocks = []
    align_center = scene == "sign" or rng.random() < 0.3
    for k, (text, ref) in enumerate(items):
        y = pad + k * (size + gap)
        tw = widths[k]
        x = (w - tw) // 2 if align_center else pad
        d.text((x, y), text, font=font, fill=fg)
        x0, y0, x1, y1 = d.textbbox((x, y), text, font=font)
        blocks.append({"id": k + 1, "text": text, "reference": ref, "box": [x0, y0, x1, y1]})

    angle = rng.choice([0, 0, -2, 2, -3, 3])
    if angle:
        img = img.rotate(angle, resample=Image.BICUBIC, expand=False, fillcolor=c1)
        cx, cy = w / 2, h / 2
        for b in blocks:
            x0, y0, x1, y1 = b["box"]
            pts = [_rotate_point(px, py, cx, cy, angle) for px, py in ((x0, y0), (x1, y0), (x0, y1), (x1, y1))]
            b["box"] = [max(0, min(p[0] for p in pts)), max(0, min(p[1] for p in pts)),
                        min(w, max(p[0] for p in pts)), min(h, max(p[1] for p in pts))]
    if rng.random() < 0.25:  # 少量轻微模糊，模拟手机拍摄
        img = img.filter(ImageFilter.GaussianBlur(0.6))

    name = f"{scene}-{lang}-{idx + 1:02d}"
    img.save(IMAGES / f"{name}.png")
    for b in blocks:
        b["box"] = [round(v, 1) for v in b["box"]]
        b["bbox"] = [round(b["box"][0] / w, 4), round(b["box"][1] / h, 4), round(b["box"][2] / w, 4),
                     round(b["box"][3] / h, 4)]
    terms = [g for g in GLOSSARY if g["sourceLang"] == lang and any(g["source"] in b["text"] for b in blocks)]
    return {"id": name, "file": f"images/{name}.png", "scene": scene, "sourceLang": lang, "targetLang": TARGET[lang],
            "width": w, "height": h, "font": font_path.name, "angle": angle, "blocks": blocks, "terms": terms}


def render(seed: int = 20261004) -> list[dict]:
    IMAGES.mkdir(parents=True, exist_ok=True)
    rng = random.Random(seed)
    rows = []
    for scene in ("sign", "menu", "label"):
        for lang in ("zh", "en", "ja"):
            for i in range(PER_COMBO):
                rows.append(render_one(scene, lang, i, rng))
    with open(DATA / "truth.jsonl", "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    (DATA / "glossary.json").write_text(json.dumps(GLOSSARY, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return rows


def load_truth() -> list[dict]:
    with open(DATA / "truth.jsonl", encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def check() -> list[str]:
    problems = []
    rows = load_truth()
    if len(rows) < 30:
        problems.append(f"至少 30 张，实际 {len(rows)} 张")
    for r in rows:
        p = DATA / r["file"]
        if not p.exists():
            problems.append(f"{r['id']} 缺少图片")
            continue
        with Image.open(p) as im:
            if im.size != (r["width"], r["height"]):
                problems.append(f"{r['id']} 尺寸与真值不符")
        for b in r["blocks"]:
            x0, y0, x1, y1 = b["bbox"]
            if not (0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1):
                problems.append(f"{r['id']}#{b['id']} bbox 非法 {b['bbox']}")
            if not b["text"] or not b["reference"]:
                problems.append(f"{r['id']}#{b['id']} 缺少文本或参考译文")
    return problems


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    if cmd == "render":
        out = render()
        print(f"已生成 {len(out)} 张，文本块 {sum(len(r['blocks']) for r in out)} 个")
    issues = check()
    print("\n".join(issues) if issues else "数据集完整")
    sys.exit(1 if issues else 0)
