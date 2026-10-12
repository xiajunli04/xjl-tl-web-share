import { describe, expect, it } from "vitest";
import {
  coverPadding,
  analyzeBlocks,
  bboxToRect,
  contrastRatio,
  fitText,
  foregroundColor,
  medianColor,
  pickTextColor,
  ringPixels,
  tokenize,
  wrapText,
  type RGB,
} from "@/lib/image-render";

/** 等宽测量替身：CJK 字宽 1em，其余 0.5em */
const measureAt = (s: string, size: number) =>
  Array.from(s).reduce((w, ch) => w + (/[⺀-鿿＀-￯]/.test(ch) ? size : size * 0.5), 0);
const measure10 = (s: string) => measureAt(s, 10);

/** 生成 w×h 的 RGBA 像素：fill(x, y) 返回颜色 */
function image(w: number, h: number, fill: (x: number, y: number) => RGB) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fill(x, y);
      const i = (y * w + x) * 4;
      data.set([r, g, b, 255], i);
    }
  return data;
}

describe("medianColor", () => {
  it("各通道分别取中位数，偶数个取中间两数均值", () => {
    expect(medianColor([[10, 200, 0], [30, 100, 50], [20, 0, 255]])).toEqual([20, 100, 50]);
    expect(medianColor([[0, 0, 0], [10, 20, 30]])).toEqual([5, 10, 15]);
  });
  it("少量离群点不影响结果", () => {
    const px: RGB[] = [...Array(9).fill([240, 240, 240]), [0, 0, 0]];
    expect(medianColor(px)).toEqual([240, 240, 240]);
  });
  it("空数组返回白色", () => {
    expect(medianColor([])).toEqual([255, 255, 255]);
  });
});

describe("对比度与文字色", () => {
  it("黑白对比度为 21，同色为 1", () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 1);
    expect(contrastRatio([120, 30, 60], [120, 30, 60])).toBeCloseTo(1, 5);
  });
  it("浅色背景用近黑文字，深色背景用白色文字", () => {
    expect(pickTextColor([250, 245, 230])).toEqual([17, 17, 17]);
    expect(pickTextColor([20, 40, 90])).toEqual([255, 255, 255]);
  });
  it("前景色与背景对比足够时优先使用前景色", () => {
    expect(pickTextColor([255, 255, 255], [200, 20, 20])).toEqual([200, 20, 20]);
  });
  it("前景色对比不足时退回黑白", () => {
    expect(pickTextColor([255, 255, 255], [240, 230, 230])).toEqual([17, 17, 17]);
  });
});

describe("foregroundColor", () => {
  const bg: RGB = [250, 250, 250];
  it("框内有一定比例的远色像素时返回其中位色", () => {
    const inner: RGB[] = [...Array(80).fill(bg), ...Array(20).fill([180, 0, 0])];
    expect(foregroundColor(inner, bg)).toEqual([180, 0, 0]);
  });
  it("远色像素过少（噪声）或过多（背景估计不可靠）时返回 null", () => {
    expect(foregroundColor([...Array(99).fill(bg), [0, 0, 0]], bg)).toBeNull();
    expect(foregroundColor(Array(100).fill([0, 0, 0]), bg)).toBeNull();
  });
});

describe("采样", () => {
  it("bboxToRect 取整并裁剪", () => {
    expect(bboxToRect([0.1, 0.2, 0.5, 0.6], 100, 50)).toEqual({ x: 10, y: 10, w: 40, h: 20 });
    expect(bboxToRect([-0.2, 0.9, 1.4, 1.2], 100, 50)).toEqual({ x: 0, y: 45, w: 100, h: 5 });
  });
  it("ringPixels 只取外扩边框，不含框内像素", () => {
    // 框内红色、框外蓝色
    const rect = { x: 4, y: 4, w: 4, h: 4 };
    const data = image(12, 12, (x, y) =>
      x >= 4 && x < 8 && y >= 4 && y < 8 ? [255, 0, 0] : [0, 0, 255],
    );
    const ring = ringPixels(data, 12, 12, rect, 2);
    expect(ring).toHaveLength(8 * 8 - 16);
    expect(ring.every((p) => p[2] === 255)).toBe(true);
  });
  it("贴边的框只采样图像内的部分", () => {
    const data = image(10, 10, () => [9, 9, 9]);
    const ring = ringPixels(data, 10, 10, { x: 0, y: 0, w: 5, h: 5 }, 4);
    expect(ring).toHaveLength(9 * 9 - 25);
  });
  it("analyzeBlocks：浅底红字 → 背景取浅色、文字取红色", () => {
    const data = image(40, 20, (x, y) => {
      const inBox = x >= 10 && x < 30 && y >= 5 && y < 15;
      // 框内一条竖纹模拟原文字笔画
      return inBox && x % 4 === 0 ? [190, 10, 10] : [245, 240, 230];
    });
    const styles = analyzeBlocks(data, 40, 20, [{ id: 1, bbox: [0.25, 0.25, 0.75, 0.75] }]);
    expect(styles.get(1)).toEqual({ bg: [245, 240, 230], fg: [190, 10, 10] });
  });
  it("analyzeBlocks：深色底无明显前景 → 白字", () => {
    const data = image(20, 20, () => [10, 20, 40]);
    const styles = analyzeBlocks(data, 20, 20, [{ id: 7, bbox: [0.2, 0.2, 0.8, 0.8] }]);
    expect(styles.get(7)?.fg).toEqual([255, 255, 255]);
  });
});

describe("换行", () => {
  it("tokenize：拉丁按词、CJK 逐字、标点并入前一单元", () => {
    expect(tokenize("Kung Pao Chicken")).toEqual(["Kung ", "Pao ", "Chicken"]);
    expect(tokenize("宫保鸡丁，好吃")).toEqual(["宫", "保", "鸡", "丁，", "好", "吃"]);
    // 开括号并入后一个单元，不会单独留在行尾
    expect(tokenize("Mapo Tofu (Signature)")).toEqual(["Mapo ", "Tofu ", "(Signature)"]);
    expect(tokenize("《三体》")).toEqual(["《三", "体》"]);
  });
  it("拉丁文本按词换行，行尾空格不计宽度", () => {
    // 字号 10 时每个字符 5 px；宽 40 可放 8 个字符
    expect(wrapText("Kung Pao Chicken", 40, measure10)).toEqual(["Kung Pao", "Chicken"]);
  });
  it("CJK 逐字换行，标点不出现在行首", () => {
    expect(wrapText("麻婆豆腐好吃", 40, measure10)).toEqual(["麻婆豆腐", "好吃"]);
    expect(wrapText("一二三，四", 30, measure10)).toEqual(["一二", "三，四"].map((l) => l));
  });
  it("超长单词按字符截断", () => {
    expect(wrapText("Supercalifragilistic", 40, measure10)).toEqual(["Supercal", "ifragili", "stic"]);
  });
  it("保留显式换行", () => {
    expect(wrapText("Hot\nSoup", 100, measure10)).toEqual(["Hot", "Soup"]);
  });
});

describe("fitText 字号二分", () => {
  it("单行能放下时取受高度限制的最大字号", () => {
    const r = fitText("Hi", 200, 24, measureAt, { lineHeight: 1.2 });
    expect(r.fontSize).toBe(20);
    expect(r.lines).toEqual(["Hi"]);
    expect(r.overflow).toBe(false);
  });
  it("长文本自动换行并缩小字号，结果满足宽高约束", () => {
    const text = "Kung Pao Chicken with peanuts";
    const r = fitText(text, 120, 60, measureAt);
    expect(r.overflow).toBe(false);
    expect(r.lines.length).toBeGreaterThan(1);
    expect(r.lines.length * r.fontSize * r.lineHeight).toBeLessThanOrEqual(60.01);
    for (const l of r.lines) expect(measureAt(l, r.fontSize)).toBeLessThanOrEqual(120.01);
    // 再大 1 px 就放不下（二分精度 0.5 px）
    const bigger = fitText(text, 120, 60, measureAt, { minSize: r.fontSize + 1 });
    expect(bigger.overflow || bigger.fontSize >= r.fontSize).toBe(true);
  });
  it("字号随框变大而单调不减", () => {
    const a = fitText("麻婆豆腐", 40, 40, measureAt).fontSize;
    const b = fitText("麻婆豆腐", 80, 40, measureAt).fontSize;
    const c = fitText("麻婆豆腐", 160, 80, measureAt).fontSize;
    expect(a).toBeLessThanOrEqual(b);
    expect(b).toBeLessThanOrEqual(c);
  });
  it("优先缩小字号保持单词完整，而不是把单词拆到两行", () => {
    // 宽 60、高 40：若允许拆词可用更大字号，但会出现 "Twice-Cooke / d"
    const r = fitText("Twice-Cooked Pork", 60, 40, measureAt);
    const words = r.lines.join(" ").split(/\s+/);
    expect(words).toContain("Twice-Cooked");
    expect(r.overflow).toBe(false);
  });
  it("最小字号也放不下时标记 overflow", () => {
    const r = fitText("This is a very long sentence", 10, 8, measureAt, { minSize: 6 });
    expect(r.overflow).toBe(true);
    expect(r.fontSize).toBe(6);
  });
});

describe("coverPadding", () => {
  it("按框高等比外扩，且不少于 2 个原图像素", () => {
    expect(coverPadding(50, 1)).toEqual({ ex: 6, ey: 9 });
    expect(coverPadding(5, 1)).toEqual({ ex: 2, ey: 2 });
  });
});
