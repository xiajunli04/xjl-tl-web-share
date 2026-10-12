/**
 * 图片翻译 mock（NEXT_PUBLIC_MOCK_API=1）：脚本化 SSE 事件序列 + 内存记录（列表 / 详情 / 图片字节 / PATCH / 收藏 / 删除）。
 * 示例图（文件名 sample-*.png）返回与 public/samples/*.svg 对齐的文本块；其他图片返回通用占位块。
 */
import { ApiError, type RequestOptions } from "@/lib/http";
import { abortError, type SseMessage } from "@/lib/sse";
import type {
  ImageBlock,
  ImageTermHit,
  ImageTraceItem,
  ImageTranslateParams,
  ImageTranslationDetail,
  ImageTranslationItem,
} from "@/lib/api/image";
import { validateImageFile } from "@/lib/api/image";
import type { PageResult } from "@/lib/api/types";
import { IMAGE_SAMPLES, SAMPLE_FILE_PREFIX, rasterizeSample, type ImageSample } from "@/lib/image-samples";

type PxBox = [number, number, number, number];
interface SampleBlock {
  text: string;
  box: PxBox;
  t: Record<string, string>;
}

const SAMPLE_BLOCKS: Record<ImageSample["key"], { lang: string; blocks: SampleBlock[]; terms: { source: string; target: string; blockIndex: number; lang: string }[] }> = {
  menu: {
    lang: "zh",
    blocks: [
      { text: "川味小馆 · 今日菜单", box: [350, 86, 850, 154], t: { en: "Sichuan Bistro · Today's Menu", ja: "四川食堂・本日のメニュー" } },
      { text: "宫保鸡丁", box: [144, 256, 332, 310], t: { en: "Kung Pao Chicken", ja: "鶏肉のピーナッツ炒め" } },
      { text: "鸡丁配花生，微辣", box: [144, 320, 348, 351], t: { en: "Diced chicken with peanuts, mild", ja: "鶏肉とピーナッツ、ピリ辛" } },
      { text: "麻婆豆腐", box: [144, 386, 332, 440], t: { en: "Mapo Tofu", ja: "麻婆豆腐" } },
      { text: "嫩豆腐，麻辣鲜香", box: [144, 450, 348, 481], t: { en: "Silky tofu, numbing and spicy", ja: "柔らかい豆腐、痺れる辛さ" } },
      { text: "鱼香肉丝", box: [144, 516, 332, 570], t: { en: "Yu-Shiang Shredded Pork", ja: "豚肉の細切り魚香炒め" } },
      { text: "酸甜微辣，下饭", box: [144, 580, 324, 611], t: { en: "Sweet, sour, a little spicy", ja: "甘酸っぱくピリ辛" } },
      { text: "水煮牛肉", box: [654, 256, 842, 310], t: { en: "Boiled Beef in Chili Oil", ja: "牛肉の唐辛子煮込み" } },
      { text: "红油牛肉，特辣", box: [654, 320, 834, 351], t: { en: "Beef in red chili oil, extra hot", ja: "ラー油の牛肉、激辛" } },
      { text: "回锅肉", box: [654, 386, 798, 440], t: { en: "Twice-Cooked Pork", ja: "回鍋肉" } },
      { text: "蒜苗爆炒二刀肉", box: [654, 450, 834, 481], t: { en: "Pork belly with garlic sprouts", ja: "ニンニクの芽と豚バラ炒め" } },
      { text: "酸辣汤", box: [654, 516, 798, 570], t: { en: "Hot and Sour Soup", ja: "酸辣湯" } },
      { text: "开胃暖身", box: [654, 580, 762, 611], t: { en: "Warming appetizer", ja: "食欲をそそる温かいスープ" } },
      { text: "辣度可调 · 欢迎品尝", box: [444, 768, 756, 810], t: { en: "Spice level adjustable · Enjoy!", ja: "辛さ調整可・どうぞ召し上がれ" } },
    ],
    terms: [{ source: "宫保鸡丁", target: "Kung Pao Chicken", blockIndex: 1, lang: "en" }],
  },
  sign: {
    lang: "ja",
    blocks: [
      { text: "新宿駅 南口", box: [330, 160, 870, 272], t: { zh: "新宿站 南口", en: "Shinjuku Station South Exit" } },
      { text: "Shinjuku Sta. South Exit", box: [356, 288, 844, 334], t: { zh: "新宿站 南出口", en: "Shinjuku Sta. South Exit" } },
      { text: "改札はこちら", box: [444, 418, 836, 498], t: { zh: "检票口在这边", en: "Ticket gates this way" } },
      { text: "足元にご注意ください", box: [316, 664, 884, 734], t: { zh: "请注意脚下", en: "Please watch your step" } },
    ],
    terms: [],
  },
  poster: {
    lang: "en",
    blocks: [
      { text: "SPRING", box: [190, 205, 710, 312], t: { zh: "春季", ja: "春の" } },
      { text: "TECH FORUM 2026", box: [122, 348, 778, 414], t: { zh: "技术论坛 2026", ja: "テックフォーラム 2026" } },
      { text: "AI · Cloud · Open Source", box: [182, 484, 718, 532], t: { zh: "人工智能 · 云计算 · 开源", ja: "AI・クラウド・オープンソース" } },
      { text: "May 18 · Hall B", box: [202, 772, 698, 836], t: { zh: "5 月 18 日 · B 厅", ja: "5月18日・B ホール" } },
      { text: "Free admission for students", box: [192, 968, 708, 1010], t: { zh: "学生免费入场", ja: "学生は入場無料" } },
    ],
    terms: [{ source: "Open Source", target: "开源", blockIndex: 2, lang: "zh" }],
  },
};

const sampleOf = (key: string) => IMAGE_SAMPLES.find((s) => s.key === key);

function translate(b: SampleBlock, target: string) {
  return b.t[target] ?? `[${target}] ${b.t.en ?? b.t.zh ?? b.text}`;
}

function sampleBlocks(key: ImageSample["key"], target: string, withTranslation: boolean): ImageBlock[] {
  const s = sampleOf(key)!;
  return SAMPLE_BLOCKS[key].blocks.map((b, i) => ({
    id: i + 1,
    text: b.text,
    bbox: [b.box[0] / s.width, b.box[1] / s.height, b.box[2] / s.width, b.box[3] / s.height],
    ...(withTranslation ? { translation: translate(b, target), lang: SAMPLE_BLOCKS[key].lang } : {}),
  }));
}

/** 非示例图：在图片上分布几个通用占位块 */
function genericBlocks(target: string, withTranslation: boolean): ImageBlock[] {
  const rows: [string, string, [number, number, number, number]][] = [
    ["示例标题（mock）", "Sample title (mock)", [0.1, 0.08, 0.9, 0.18]],
    ["第一段识别文字", "First recognized line", [0.1, 0.32, 0.62, 0.4]],
    ["第二段识别文字", "Second recognized line", [0.1, 0.46, 0.62, 0.54]],
    ["底部说明文字", "Footer note", [0.3, 0.82, 0.7, 0.9]],
  ];
  return rows.map(([text, en, bbox], i) => ({
    id: i + 1,
    text,
    bbox,
    ...(withTranslation ? { translation: target === "en" ? en : `[${target}] ${en}`, lang: "zh" } : {}),
  }));
}

function termHitsOf(key: ImageSample["key"] | null, target: string): ImageTermHit[] {
  if (!key) return [];
  return SAMPLE_BLOCKS[key].terms
    .filter((t) => t.lang === target)
    .map((t) => ({ source: t.source, target: t.target, followed: true, blockIds: [t.blockIndex + 1] }));
}

/* ---------------- 记录存储 ---------------- */

interface StoredRecord extends ImageTranslationDetail {
  sampleKey: ImageSample["key"] | null;
}

const records: StoredRecord[] = [];
const originals = new Map<number, Blob>();
let nextId = 1;
const iso = (offsetMin: number) => new Date(Date.now() - offsetMin * 60_000).toISOString();

function previewOf(blocks: ImageBlock[]) {
  const b = blocks.find((x) => x.translation);
  return b ? `${b.text} → ${b.translation}` : null;
}

function trace(blockCount: number, lang: string, engine: string, terms: number): ImageTraceItem[] {
  if (engine === "qwen-mt-image") {
    return [
      { node: "translate", status: "completed", summary: "千问图片翻译完成", latencyMs: 4200 },
      { node: "render", status: "completed", summary: "结果图已保存", latencyMs: 3 },
    ];
  }
  return [
    { node: "ocr", status: "completed", summary: blockCount ? `识别到 ${blockCount} 个文本块（${lang}）` : "未识别到文字", latencyMs: 3210 },
    { node: "terms", status: "completed", summary: terms ? `命中 ${terms} 条术语` : "未命中术语", latencyMs: 4 },
    { node: "translate", status: "completed", summary: `已翻译 ${blockCount} 块`, latencyMs: 2100 },
    { node: "render", status: "completed", summary: "坐标已归一化", latencyMs: 1 },
  ];
}

const LANG_LABEL: Record<string, string> = { zh: "中文", en: "英语", ja: "日语" };

function seed() {
  if (records.length) return;
  const make = (key: ImageSample["key"], target: string, engine: string, minutesAgo: number, favorite = false) => {
    const s = sampleOf(key)!;
    const blocks = engine === "qwen-mt-image" ? [] : sampleBlocks(key, target, true);
    const termHits = engine === "qwen-mt-image" ? [] : termHitsOf(key, target);
    const n = SAMPLE_BLOCKS[key].blocks.length;
    const rec: StoredRecord = {
      id: nextId++,
      sampleKey: key,
      engine,
      sourceLang: "auto",
      detectedLang: engine === "qwen-mt-image" ? null : SAMPLE_BLOCKS[key].lang,
      targetLang: target,
      width: s.width,
      height: s.height,
      blockCount: blocks.length,
      preview: engine === "qwen-mt-image" ? `${s.title}（整图译图）` : previewOf(blocks),
      hasResultImage: engine === "qwen-mt-image",
      favorite,
      createdAt: iso(minutesAgo),
      modelConfigId: engine === "qwen-mt-image" ? 6 : 2,
      mime: "image/png",
      sizeBytes: 180_000 + n * 3000,
      blocks,
      glossaryIds: termHits.length ? [7] : [],
      termHits,
      trace: trace(blocks.length, LANG_LABEL[SAMPLE_BLOCKS[key].lang] ?? "", engine, termHits.length),
      promptTokens: engine === "qwen-mt-image" ? null : 1500 + n * 40,
      completionTokens: engine === "qwen-mt-image" ? null : 300 + n * 12,
      latencyMs: engine === "qwen-mt-image" ? 4300 : 5400 + n * 50,
    };
    records.unshift(rec);
  };
  make("poster", "zh", "qwen-mt-image", 60 * 26);
  make("sign", "zh", "vision", 60 * 5, true);
  make("menu", "en", "vision", 42);
}

function itemOf(r: StoredRecord): ImageTranslationItem {
  const { id, engine, sourceLang, detectedLang, targetLang, width, height, blockCount, preview, hasResultImage, favorite, createdAt } = r;
  return { id, engine, sourceLang, detectedLang, targetLang, width, height, blockCount, preview, hasResultImage, favorite, createdAt };
}

function detailOf(r: StoredRecord): ImageTranslationDetail {
  const { sampleKey: _sampleKey, ...rest } = r;
  void _sampleKey;
  return structuredClone(rest);
}

function find(id: number) {
  seed();
  const r = records.find((x) => x.id === id);
  if (!r) throw new ApiError("A0404", "资源不存在", undefined, 404);
  return r;
}

/* ---------------- SSE ---------------- */

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(abortError());
      },
      { once: true },
    );
  });
}

function readSize(blob: Blob): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve({ width: 1200, height: 900 });
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

export async function mockImageStream(
  p: ImageTranslateParams,
  opts: { signal?: AbortSignal; onMessage: (m: SseMessage) => void },
): Promise<void> {
  seed();
  await sleep(300, opts.signal);
  const invalid = validateImageFile({ type: p.image.type, size: p.image.size });
  if (invalid) throw new ApiError("A0450", invalid, "mock-img-a0450", 400);
  if (p.engine === "qwen-mt-image") throw new ApiError("C0173", "千问图片翻译未配置（mock）", "mock-img-c0173", 503);

  const name = p.filename ?? "";
  const key = name.startsWith(SAMPLE_FILE_PREFIX)
    ? (name.slice(SAMPLE_FILE_PREFIX.length).replace(/\.png$/, "") as ImageSample["key"])
    : null;
  const sample = key && SAMPLE_BLOCKS[key] ? key : null;
  const { width, height } = await readSize(p.image);
  const target = p.targetLang;
  const lang = sample ? SAMPLE_BLOCKS[sample].lang : "zh";
  const ocrBlocks = sample ? sampleBlocks(sample, target, false) : genericBlocks(target, false);
  const full = sample ? sampleBlocks(sample, target, true) : genericBlocks(target, true);
  const termHits = termHitsOf(sample, target);
  const emit = (event: string, data: unknown) => opts.onMessage({ event, data: JSON.stringify(data) });
  const requestId = `img-${Math.random().toString(16).slice(2, 6)}`;
  let seq = 0;

  emit("start", { requestId });
  emit("node", { seq: ++seq, node: "ocr", status: "started" });
  await sleep(1600, opts.signal);
  emit("node", { seq: ++seq, node: "ocr", status: "completed", summary: `识别到 ${ocrBlocks.length} 个文本块（${LANG_LABEL[lang] ?? lang}）`, latencyMs: 1600 });
  emit("blocks", { width, height, detectedLang: lang, blocks: ocrBlocks });
  await sleep(500, opts.signal);
  emit("node", { seq: ++seq, node: "terms", status: "completed", summary: termHits.length ? `命中 ${termHits.length} 条术语` : "未命中术语", latencyMs: 4 });
  emit("node", { seq: ++seq, node: "translate", status: "started" });
  await sleep(1700, opts.signal);
  emit("node", { seq: ++seq, node: "translate", status: "completed", summary: `已翻译 ${full.length} 块`, latencyMs: 1700 });
  emit("translation", { blocks: full });
  await sleep(250, opts.signal);
  emit("node", { seq: ++seq, node: "render", status: "completed", summary: "坐标已归一化", latencyMs: 1 });

  const rec: StoredRecord = {
    id: nextId++,
    sampleKey: sample,
    engine: p.engine || "vision",
    sourceLang: p.sourceLang || "auto",
    detectedLang: lang,
    targetLang: target,
    width,
    height,
    blockCount: full.length,
    preview: previewOf(full),
    hasResultImage: false,
    favorite: false,
    createdAt: new Date().toISOString(),
    modelConfigId: p.modelConfigId ?? 2,
    mime: p.image.type,
    sizeBytes: p.image.size,
    blocks: full,
    glossaryIds: p.glossaryIds ?? [],
    termHits,
    trace: trace(full.length, LANG_LABEL[lang] ?? lang, "vision", termHits.length),
    promptTokens: 1500 + full.length * 40,
    completionTokens: 300 + full.length * 12,
    latencyMs: 4050,
  };
  records.unshift(rec);
  originals.set(rec.id, p.image);
  await sleep(120, opts.signal);
  emit("done", {
    id: rec.id,
    detectedLang: lang,
    blocks: full,
    termHits,
    trace: rec.trace,
    usage: { promptTokens: rec.promptTokens, completionTokens: rec.completionTokens },
    latencyMs: rec.latencyMs,
    modelConfigId: rec.modelConfigId,
    resultImageBase64: null,
  });
}

/* ---------------- REST ---------------- */

export async function mockImageRequest<T>(path: string, opts: RequestOptions): Promise<T> {
  seed();
  const method = opts.method ?? "GET";
  const q = opts.query ?? {};
  const r = (v: unknown) => v as T;
  let m: RegExpMatchArray | null;
  if (path === "/api/image-translations" && method === "GET") {
    const kw = String(q.keyword ?? "").trim().toLowerCase();
    let rows = records.filter(
      (x) => !kw || x.blocks.some((b) => b.text.toLowerCase().includes(kw) || (b.translation ?? "").toLowerCase().includes(kw)),
    );
    if (q.targetLang) rows = rows.filter((x) => x.targetLang === q.targetLang);
    if (String(q.favorite) === "true") rows = rows.filter((x) => x.favorite);
    const pageNum = Number(q.pageNum ?? 1);
    const pageSize = Number(q.pageSize ?? 10);
    const page: PageResult<ImageTranslationItem> = {
      records: rows.slice((pageNum - 1) * pageSize, pageNum * pageSize).map(itemOf),
      total: rows.length,
      pageNum,
      pageSize,
    };
    return r(page);
  }
  if ((m = path.match(/^\/api\/image-translations\/(\d+)$/))) {
    const rec = find(Number(m[1]));
    if (method === "DELETE") {
      records.splice(records.indexOf(rec), 1);
      originals.delete(rec.id);
      return r(null);
    }
    return r(detailOf(rec));
  }
  if ((m = path.match(/^\/api\/image-translations\/(\d+)\/blocks$/)) && method === "PATCH") {
    const rec = find(Number(m[1]));
    const body = (opts.body ?? {}) as { blocks?: { id: number; translation: string }[] };
    for (const e of body.blocks ?? []) {
      const b = rec.blocks.find((x) => x.id === e.id);
      if (!b) throw new ApiError("A0410", `文本块 ${e.id} 不存在`, undefined, 400);
      b.translation = e.translation;
    }
    rec.preview = previewOf(rec.blocks);
    return r(detailOf(rec));
  }
  if ((m = path.match(/^\/api\/image-translations\/(\d+)\/favorite$/)) && method === "PUT") {
    const rec = find(Number(m[1]));
    rec.favorite = !!(opts.body as { favorite?: boolean } | undefined)?.favorite;
    return r(null);
  }
  throw new ApiError("A0404", `mock 未实现：${method} ${path}`, undefined, 404);
}

/** 原图 / 结果图字节 */
export async function mockImageDownload(path: string): Promise<{ blob: Blob; filename: string | null }> {
  const m = path.match(/^\/api\/image-translations\/(\d+)\/(image|result-image)$/);
  if (!m) throw new ApiError("A0404", "资源不存在", undefined, 404);
  const rec = find(Number(m[1]));
  const kind = m[2];
  if (kind === "result-image" && !rec.hasResultImage) throw new ApiError("A0404", "结果图不存在", undefined, 404);
  const sample = rec.sampleKey ? sampleOf(rec.sampleKey) : null;
  let original = originals.get(rec.id);
  if (!original && sample) {
    original = await rasterizeSample(sample);
    originals.set(rec.id, original);
  }
  if (!original) throw new ApiError("A0404", "图片不存在", undefined, 404);
  if (kind === "image") return { blob: original, filename: `image-${rec.id}.png` };
  // 结果图：用前端渲染器把译文画到原图上，模拟 qwen-mt-image 返回的整图
  const { computeStyles, exportPng } = await import("@/lib/image-render");
  const url = URL.createObjectURL(original);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = url;
    });
    const blocks = rec.sampleKey ? sampleBlocks(rec.sampleKey, rec.targetLang, true) : [];
    const blob = await exportPng(img, blocks, computeStyles(img, blocks));
    return { blob, filename: `result-${rec.id}.png` };
  } finally {
    URL.revokeObjectURL(url);
  }
}
