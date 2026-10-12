/** 图片翻译示例图（public/samples/*.svg，点击后栅格化为 PNG 再提交，与真实上传流程一致） */

export interface ImageSample {
  key: "menu" | "sign" | "poster";
  title: string;
  description: string;
  url: string;
  width: number;
  height: number;
  /** 建议的目标语言 */
  targetLang: string;
}

export const IMAGE_SAMPLES: ImageSample[] = [
  { key: "menu", title: "川菜菜单", description: "中文 → 英语", url: "/samples/menu.svg", width: 1200, height: 900, targetLang: "en" },
  { key: "sign", title: "车站指示牌", description: "日语 → 中文", url: "/samples/sign.svg", width: 1200, height: 800, targetLang: "zh" },
  { key: "poster", title: "活动海报", description: "英语 → 中文", url: "/samples/poster.svg", width: 900, height: 1200, targetLang: "zh" },
];

/** 文件名前缀：mock 据此识别示例图并返回对应的文本块 */
export const SAMPLE_FILE_PREFIX = "sample-";

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片加载失败"));
    img.src = src;
  });
}

/** 把 SVG 栅格化为原尺寸 PNG */
export async function rasterizeSample(sample: Pick<ImageSample, "url" | "width" | "height">): Promise<Blob> {
  const img = await loadImage(sample.url);
  const canvas = document.createElement("canvas");
  canvas.width = sample.width;
  canvas.height = sample.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 不可用");
  ctx.drawImage(img, 0, 0, sample.width, sample.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("示例图生成失败"))), "image/png"),
  );
}

export async function sampleFile(sample: ImageSample): Promise<File> {
  const blob = await rasterizeSample(sample);
  return new File([blob], `${SAMPLE_FILE_PREFIX}${sample.key}.png`, { type: "image/png" });
}
