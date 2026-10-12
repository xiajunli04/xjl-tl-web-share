/**
 * 图片翻译覆盖渲染（design D10「覆盖渲染」）：
 * 1. 每个 bbox 外扩 4 px 的边框像素取中位色作为背景，填充 2 px 圆角矩形；
 * 2. 文字色取与背景对比度更高的黑 / 白；框内存在明显前景色（原文字色）时优先使用前景色；
 * 3. 字号二分查找，在 bbox 内自动换行并居中；竖排 / 旋转文字按水平排版处理；
 * 4. 导出 PNG 时以原图分辨率重绘。
 *
 * 纯函数（中位色、对比度、换行、字号）与 Canvas 绘制分开，前者有单元测试。
 */

export type RGB = [number, number, number];
/** 归一化坐标 [x0, y0, x1, y1]，0–1 */
export type BBox = [number, number, number, number];

export interface RenderBlock {
  id: number;
  text: string;
  translation?: string | null;
  bbox: BBox;
}

export interface BlockStyle {
  bg: RGB;
  fg: RGB;
}

export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/* ---------------- 颜色 ---------------- */

/** 各通道分别取中位数；空数组返回白色 */
export function medianColor(pixels: readonly RGB[]): RGB {
  if (!pixels.length) return [255, 255, 255];
  const channel = (i: 0 | 1 | 2) => {
    const v = pixels.map((p) => p[i]).sort((a, b) => a - b);
    const mid = v.length >> 1;
    return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
  };
  return [channel(0), channel(1), channel(2)];
}

/** WCAG 相对亮度 */
export function relativeLuminance([r, g, b]: RGB): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 对比度（1–21） */
export function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const BLACK: RGB = [17, 17, 17];
const WHITE: RGB = [255, 255, 255];

/**
 * 文字色：前景候选与背景对比度 ≥ minContrast 时使用前景色（保留原图文字颜色），
 * 否则在近黑 / 白之间取对比度更高者。
 */
export function pickTextColor(bg: RGB, foreground?: RGB | null, minContrast = 3): RGB {
  if (foreground && contrastRatio(foreground, bg) >= minContrast) return foreground;
  return contrastRatio(BLACK, bg) >= contrastRatio(WHITE, bg) ? BLACK : WHITE;
}

function colorDistance(a: RGB, b: RGB) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

/**
 * 框内"明显的前景色"：与背景色距离超过阈值的像素占比在 [minRatio, maxRatio] 之间时，返回这些像素的中位色。
 * 占比过低是噪声，过高说明背景估计不可靠（例如框内是整块色块），两种情况都返回 null。
 */
export function foregroundColor(
  inner: readonly RGB[],
  bg: RGB,
  { threshold = 80, minRatio = 0.04, maxRatio = 0.6 }: { threshold?: number; minRatio?: number; maxRatio?: number } = {},
): RGB | null {
  if (!inner.length) return null;
  const far = inner.filter((p) => colorDistance(p, bg) > threshold);
  const ratio = far.length / inner.length;
  if (ratio < minRatio || ratio > maxRatio) return null;
  return medianColor(far);
}

export const rgbCss = ([r, g, b]: RGB, alpha = 1) =>
  alpha >= 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${alpha})`;

/* ---------------- 坐标与采样 ---------------- */

/** 归一化 bbox → 像素矩形（取整并裁剪到图像内，宽高至少 1 px） */
export function bboxToRect(bbox: BBox, width: number, height: number): PixelRect {
  const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v));
  const x0 = Math.floor(clamp(bbox[0], 1) * width);
  const y0 = Math.floor(clamp(bbox[1], 1) * height);
  const x1 = Math.ceil(clamp(bbox[2], 1) * width);
  const y1 = Math.ceil(clamp(bbox[3], 1) * height);
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

function px(data: ArrayLike<number>, width: number, x: number, y: number): RGB {
  const i = (y * width + x) * 4;
  return [data[i], data[i + 1], data[i + 2]];
}

/**
 * 矩形外扩 pad 像素的环形边框采样（裁剪到图像内；矩形贴边时只取图像内的部分）。
 * step > 1 时隔点采样以控制大图的计算量。
 */
export function ringPixels(
  data: ArrayLike<number>,
  width: number,
  height: number,
  rect: PixelRect,
  pad = 4,
  step = 1,
): RGB[] {
  const ox0 = Math.max(0, rect.x - pad);
  const oy0 = Math.max(0, rect.y - pad);
  const ox1 = Math.min(width, rect.x + rect.w + pad);
  const oy1 = Math.min(height, rect.y + rect.h + pad);
  const out: RGB[] = [];
  for (let y = oy0; y < oy1; y += step) {
    const insideY = y >= rect.y && y < rect.y + rect.h;
    for (let x = ox0; x < ox1; x += step) {
      if (insideY && x >= rect.x && x < rect.x + rect.w) continue;
      out.push(px(data, width, x, y));
    }
  }
  // 矩形覆盖整张图时没有外环：退化为矩形边缘一圈
  if (!out.length) {
    for (let x = rect.x; x < rect.x + rect.w; x += step) {
      out.push(px(data, width, x, rect.y), px(data, width, x, rect.y + rect.h - 1));
    }
  }
  return out;
}

/** 矩形内部像素（隔点采样） */
export function innerPixels(data: ArrayLike<number>, width: number, rect: PixelRect, step = 1): RGB[] {
  const out: RGB[] = [];
  for (let y = rect.y; y < rect.y + rect.h; y += step) {
    for (let x = rect.x; x < rect.x + rect.w; x += step) out.push(px(data, width, x, y));
  }
  return out;
}

/** 由像素数据计算各文本块的背景色与文字色 */
export function analyzeBlocks(
  data: ArrayLike<number>,
  width: number,
  height: number,
  blocks: readonly Pick<RenderBlock, "id" | "bbox">[],
  pad = 4,
): Map<number, BlockStyle> {
  const styles = new Map<number, BlockStyle>();
  for (const b of blocks) {
    const rect = bboxToRect(b.bbox, width, height);
    const area = rect.w * rect.h;
    // 控制采样点数量在约 4000 以内
    const step = Math.max(1, Math.floor(Math.sqrt(area / 4000)));
    const bg = medianColor(ringPixels(data, width, height, rect, pad, step));
    const fg = foregroundColor(innerPixels(data, width, rect, step), bg);
    styles.set(b.id, { bg, fg: pickTextColor(bg, fg) });
  }
  return styles;
}

/* ---------------- 排版 ---------------- */

/** 不能出现在行首的标点 */
const NO_LINE_START = /^[，。、；：！？）】》」』,.;:!?)\]}%]/;
/** 不能出现在行尾的标点 */
const NO_LINE_END = /^[（【《「『(\[{“‘"]$/;

/** 拆成可换行的最小单元：CJK 逐字、拉丁按词（含尾随空格）；标点并入前一单元 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const re = /\s+|[A-Za-z0-9À-ɏЀ-ӿ'’\-]+[^\S\n]*|./gu;
  // 不能出现在行尾的开括号 / 引号：并入下一个单元
  let open = "";
  for (const m of text.matchAll(re)) {
    const t = m[0];
    if (/^\s+$/.test(t)) {
      if (open) open += t;
      else if (tokens.length) tokens[tokens.length - 1] += t;
      continue;
    }
    if (NO_LINE_END.test(t)) {
      open += t;
      continue;
    }
    if (!open && tokens.length && NO_LINE_START.test(t)) {
      tokens[tokens.length - 1] += t;
      continue;
    }
    tokens.push(open + t);
    open = "";
  }
  if (open) tokens.push(open);
  return tokens;
}

/**
 * 按最大宽度自动换行（保留显式换行）：
 * - CJK 逐字换行；拉丁按词换行，单词本身超宽时按字符截断；
 * - 行尾空白不计入宽度。
 */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    // 超长单元：逐字符拆分
    const pushChars = (token: string) => {
      for (const ch of Array.from(token)) {
        if (line && measure((line + ch).trimEnd()) > maxWidth) {
          lines.push(line.trimEnd());
          line = ch.trimStart();
        } else line += ch;
      }
    };
    for (const token of tokenize(para)) {
      if (measure((line + token).trimEnd()) <= maxWidth) {
        line += token;
        continue;
      }
      if (line) {
        lines.push(line.trimEnd());
        line = "";
      }
      if (measure(token.trimEnd()) <= maxWidth) line = token;
      else pushChars(token);
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

export interface FitResult {
  fontSize: number;
  lines: string[];
  lineHeight: number;
  /** 即使取最小字号也放不下 */
  overflow: boolean;
}

/**
 * 二分查找能放进 boxW × boxH 的最大字号（精度 0.5 px）。
 * measure(s, fontSize) 返回文本在该字号下的宽度。
 */
export function fitText(
  text: string,
  boxW: number,
  boxH: number,
  measure: (s: string, fontSize: number) => number,
  { minSize = 6, maxSize, lineHeight = 1.2 }: { minSize?: number; maxSize?: number; lineHeight?: number } = {},
): FitResult {
  const hi0 = Math.max(minSize, Math.min(maxSize ?? boxH / lineHeight, boxH / lineHeight));
  // 多字符单元（拉丁单词）：strict 模式下不允许把单词拆到两行
  const words = tokenize(text).filter((t) => Array.from(t.trimEnd()).length > 1);
  const fits = (size: number, strict: boolean) => {
    if (strict && words.some((w) => measure(w.trimEnd(), size) > boxW + 0.01)) return { ok: false, lines: [] as string[] };
    const lines = wrapText(text, boxW, (s) => measure(s, size));
    const widest = Math.max(0, ...lines.map((l) => measure(l, size)));
    return { ok: lines.length * size * lineHeight <= boxH + 0.01 && widest <= boxW + 0.01, lines };
  };
  const search = (strict: boolean): FitResult | null => {
    let best = fits(minSize, strict);
    if (!best.ok) return null;
    const top = fits(hi0, strict);
    if (top.ok) return { fontSize: hi0, lines: top.lines, lineHeight, overflow: false };
    let lo = minSize;
    let hi = hi0;
    while (hi - lo > 0.5) {
      const mid = (lo + hi) / 2;
      const r = fits(mid, strict);
      if (r.ok) {
        lo = mid;
        best = r;
      } else hi = mid;
    }
    return { fontSize: Math.floor(lo * 2) / 2, lines: best.lines, lineHeight, overflow: false };
  };
  // 优先保持单词完整；最小字号也放不下时才允许拆词
  const r = search(true) ?? search(false);
  if (r) return r;
  return { fontSize: minSize, lines: fits(minSize, false).lines, lineHeight, overflow: true };
}

/**
 * 覆盖矩形的外扩量（画布像素）：水平 12%、垂直 18% 的框高，且不少于 2 个原图像素。
 * 只扩大背景色块，不改变译文排版区域。
 */
export function coverPadding(boxHeight: number, unit: number): { ex: number; ey: number } {
  return { ex: Math.max(2 * unit, boxHeight * 0.12), ey: Math.max(2 * unit, boxHeight * 0.18) };
}

/* ---------------- Canvas 绘制 ---------------- */

export const RENDER_FONT_FAMILY =
  '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans", system-ui, sans-serif';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface DrawOptions {
  /** 第 i 个块的不透明度（0–1），用于逐块交叉淡入；缺省为 1 */
  alphaOf?: (index: number, block: RenderBlock) => number;
  /** 只绘制有译文的块（默认 true） */
  translatedOnly?: boolean;
}

/** 在已绘制原图的画布上覆盖译文（width/height 为画布像素尺寸） */
export function drawOverlay(
  ctx: Ctx2D,
  blocks: readonly RenderBlock[],
  styles: Map<number, BlockStyle>,
  width: number,
  height: number,
  { alphaOf, translatedOnly = true }: DrawOptions = {},
) {
  // 原图上 1 px 对应画布的像素数（导出时为 1，显示缩放时 < 1）
  const unit = Math.max(0.5, Math.min(width, height) / 1000);
  blocks.forEach((b, i) => {
    const text = (b.translation ?? "").trim();
    if (translatedOnly && !text) return;
    const alpha = alphaOf ? Math.max(0, Math.min(1, alphaOf(i, b))) : 1;
    if (alpha <= 0) return;
    const style = styles.get(b.id) ?? { bg: WHITE, fg: BLACK };
    const r = bboxToRect(b.bbox, width, height);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = rgbCss(style.bg);
    // 视觉模型给出的框常比实际字形略小（笔画下沿、右侧收尾露出），覆盖区按框高等比外扩
    const { ex, ey } = coverPadding(r.h, unit);
    const radius = Math.min(2 * unit + ey / 2, (r.w + 2 * ex) / 2, (r.h + 2 * ey) / 2);
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") ctx.roundRect(r.x - ex, r.y - ey, r.w + 2 * ex, r.h + 2 * ey, radius);
    else ctx.rect(r.x - ex, r.y - ey, r.w + 2 * ex, r.h + 2 * ey);
    ctx.fill();
    if (text) {
      const pad = Math.min(2 * unit, r.w / 8, r.h / 8);
      const innerW = Math.max(1, r.w - pad * 2);
      const innerH = Math.max(1, r.h - pad * 2);
      const measure = (s: string, size: number) => {
        ctx.font = `500 ${size}px ${RENDER_FONT_FAMILY}`;
        return ctx.measureText(s).width;
      };
      const fit = fitText(text, innerW, innerH, measure, { minSize: Math.max(4, 6 * unit) });
      ctx.font = `500 ${fit.fontSize}px ${RENDER_FONT_FAMILY}`;
      ctx.fillStyle = rgbCss(style.fg);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const lh = fit.fontSize * fit.lineHeight;
      const total = lh * fit.lines.length;
      const top = r.y + r.h / 2 - total / 2 + lh / 2;
      ctx.beginPath();
      ctx.rect(r.x - unit, r.y - unit, r.w + 2 * unit, r.h + 2 * unit);
      ctx.clip();
      fit.lines.forEach((line, li) => ctx.fillText(line, r.x + r.w / 2, top + li * lh, innerW + 1));
    }
    ctx.restore();
  });
}

/** 分析用的像素数据：长边不超过 maxSide（大图降采样以控制耗时） */
export function readPixels(
  source: CanvasImageSource,
  naturalW: number,
  naturalH: number,
  maxSide = 1600,
): { data: Uint8ClampedArray; width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(naturalW, naturalH));
  const width = Math.max(1, Math.round(naturalW * scale));
  const height = Math.max(1, Math.round(naturalH * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas 不可用");
  ctx.drawImage(source, 0, 0, width, height);
  return { data: ctx.getImageData(0, 0, width, height).data, width, height };
}

/** 计算样式（外扩 4 px 按原图像素换算到分析分辨率） */
export function computeStyles(
  img: HTMLImageElement,
  blocks: readonly Pick<RenderBlock, "id" | "bbox">[],
): Map<number, BlockStyle> {
  const { data, width, height } = readPixels(img, img.naturalWidth, img.naturalHeight);
  const pad = Math.max(1, Math.round((4 * width) / img.naturalWidth));
  return analyzeBlocks(data, width, height, blocks, pad);
}

/** 把原图与译文绘制到画布（画布尺寸由调用方设置） */
export function renderToCanvas(
  canvas: HTMLCanvasElement,
  img: CanvasImageSource,
  blocks: readonly RenderBlock[],
  styles: Map<number, BlockStyle>,
  opts?: DrawOptions,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  drawOverlay(ctx, blocks, styles, canvas.width, canvas.height, opts);
}

/** 以原图分辨率导出译图 PNG */
export function exportPng(
  img: HTMLImageElement,
  blocks: readonly RenderBlock[],
  styles: Map<number, BlockStyle>,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  renderToCanvas(canvas, img, blocks, styles);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("导出失败"))), "image/png"),
  );
}

/** 显示用画布尺寸：长边不超过 maxSide */
export function displaySize(naturalW: number, naturalH: number, maxSide = 2048) {
  const scale = Math.min(1, maxSide / Math.max(naturalW, naturalH));
  return { width: Math.max(1, Math.round(naturalW * scale)), height: Math.max(1, Math.round(naturalH * scale)) };
}
