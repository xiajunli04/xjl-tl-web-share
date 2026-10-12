# 图片翻译评测数据集（自建，E5）

用于 add-speech-and-image-translation 的 E5 实验（实验报告第 11 节）。

## 组成

- `images/*.png`：36 张合成图片 = 3 类场景（告示 sign、菜单 menu、商品标签 label）× 3 种源语言（中文、英语、日语）× 每组 4 张。
- `truth.jsonl`：每张图一行，含尺寸、字体、倾斜角，以及真值文本块 `blocks[{id, text, reference, box, bbox}]`：
  - `box`：像素坐标 `[x0, y0, x1, y1]`；`bbox`：按图片宽高归一化到 0–1。
  - `reference`：参考译文（中文 → 英语；英语 / 日语 → 中文），菜名与告示采用常见规范译法。
- `glossary.json`：评测用术语表（宫保鸡丁 → Kung Pao Chicken、Caesar Salad → 凯撒沙拉、非常口 → 紧急出口 等 6 条），用于术语准确率。

## 生成方式

```bash
cd evaluation
uv run python -m eval.multimodal.image_dataset render   # 固定随机种子渲染，结果可复现（需要 Windows 自带字体）
uv run python -m eval.multimodal.image_dataset check    # 校验图片、尺寸与坐标
```

变化维度：字体（中文 4 种、日文 4 种、英文 5 种）、6 套前景 / 背景配色、纵向渐变、约一半加轻微噪点、
约四分之一加轻微高斯模糊、0° / ±2° / ±3° 倾斜（倾斜后真值框取旋转后四角的外接矩形）。

## 局限

- **合成图片**：文字清晰、单行排版、背景简单，没有透视变形、反光、遮挡和手写体，OCR 难度明显低于真实拍摄，结论只作参考。
- 每行一个真值块；模型若把相邻两行合并成一个块，按 IoU 匹配会被计为漏检，因此块召回率偏保守。
- 倾斜后真值框是外接矩形，比文字实际区域略大，IoU 上限低于 1。
- 参考译文为单一参考，chrF 对同义译法会扣分（如 "Scrambled Eggs with Tomatoes" 与 "Tomato and Egg Stir-fry"）。
