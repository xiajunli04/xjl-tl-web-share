import { ApiError, authHeader, buildUrl, ensureFreshToken, http, toApiError, withAuthRetry } from "@/lib/http";
import { isAbortError, readSseStream, type SseMessage } from "@/lib/sse";
import type { BBox } from "@/lib/image-render";
import type { ModelOption, Usage } from "./translate";
import type { PageResult } from "./types";

// 与 docs/contracts/speech-image-api.md §1.5 / §2.3 一一对应

export type ImageEngineId = "vision" | "qwen-mt-image";
export type ImageNode = "ocr" | "terms" | "translate" | "render";

export interface ImageBlock {
  id: number;
  text: string;
  /** blocks 事件中尚无译文 */
  translation?: string | null;
  bbox: BBox;
  lang?: string | null;
}

export interface ImageTermHit {
  source: string;
  target: string;
  followed: boolean;
  blockIds: number[];
}

export interface ImageTraceItem {
  node: ImageNode | string;
  status: "started" | "completed" | "skipped" | string;
  summary?: string | null;
  latencyMs?: number | null;
}

/* ---------- SSE 事件 data ---------- */

export interface ImageStartEvent {
  requestId: string;
}
export interface ImageNodeEvent {
  seq: number;
  node: ImageNode;
  status: "started" | "completed" | "skipped";
  summary?: string;
  latencyMs?: number;
}
export interface ImageBlocksEvent {
  width: number;
  height: number;
  detectedLang: string | null;
  blocks: ImageBlock[];
}
export interface ImageTranslationEvent {
  blocks: ImageBlock[];
}
export interface ImageDoneEvent {
  /** Spring 落库后补充的记录 id */
  id?: number;
  detectedLang: string | null;
  blocks: ImageBlock[];
  termHits: ImageTermHit[];
  trace: ImageTraceItem[];
  usage: Usage | null;
  latencyMs: number;
  modelConfigId: number | null;
  /** qwen-mt-image：JPG base64 */
  resultImageBase64: string | null;
}
export interface ImageErrorEvent {
  code: string;
  message: string;
  traceId?: string;
}

export type ImageEvent =
  | { event: "start"; data: ImageStartEvent }
  | { event: "node"; data: ImageNodeEvent }
  | { event: "blocks"; data: ImageBlocksEvent }
  | { event: "translation"; data: ImageTranslationEvent }
  | { event: "done"; data: ImageDoneEvent }
  | { event: "error"; data: ImageErrorEvent };

const EVENT_NAMES = new Set(["start", "node", "blocks", "translation", "done", "error"]);

/** 原始 SSE 消息 → 类型化事件；未知事件返回 null */
export function toImageEvent(m: SseMessage): ImageEvent | null {
  if (!EVENT_NAMES.has(m.event)) return null;
  return { event: m.event, data: JSON.parse(m.data) } as ImageEvent;
}

/* ---------- 记录 ---------- */

export interface ImageTranslationItem {
  id: number;
  engine: ImageEngineId | string;
  sourceLang: string;
  detectedLang: string | null;
  targetLang: string;
  width: number;
  height: number;
  blockCount: number;
  preview: string | null;
  hasResultImage: boolean;
  favorite: boolean;
  createdAt: string;
}

export interface ImageTranslationDetail extends ImageTranslationItem {
  modelConfigId: number | null;
  mime: string;
  sizeBytes: number;
  blocks: ImageBlock[];
  glossaryIds: number[] | null;
  termHits: ImageTermHit[] | null;
  trace: ImageTraceItem[] | null;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number | null;
}

export interface ImageQuery {
  pageNum: number;
  pageSize: number;
  keyword?: string;
  targetLang?: string;
  favorite?: boolean;
  from?: string;
  to?: string;
}

export interface ImageTranslateParams {
  image: Blob;
  filename?: string;
  sourceLang: string;
  targetLang: string;
  engine: ImageEngineId | string;
  modelConfigId?: number | null;
  glossaryIds?: number[];
}

export interface ImageStreamOptions {
  signal?: AbortSignal;
  onEvent: (e: ImageEvent) => void;
}

/** 客户端预校验（与服务端 A0450 规则一致） */
export const IMAGE_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  minSide: 32,
  maxSide: 8192,
  mimes: ["image/jpeg", "image/png", "image/webp", "image/bmp"],
} as const;

/** 校验文件类型与大小；通过返回 null，否则返回中文原因 */
export function validateImageFile(file: { type: string; size: number }): string | null {
  if (!file.size) return "图片为空";
  if (!(IMAGE_LIMITS.mimes as readonly string[]).includes(file.type)) return "仅支持 JPG / PNG / WEBP / BMP 图片";
  if (file.size > IMAGE_LIMITS.maxBytes) return "图片不能超过 10 MB";
  return null;
}

/** 校验尺寸；通过返回 null */
export function validateImageSize(width: number, height: number): string | null {
  if (Math.min(width, height) < IMAGE_LIMITS.minSide) return `图片宽高不能小于 ${IMAGE_LIMITS.minSide} px`;
  if (Math.max(width, height) > IMAGE_LIMITS.maxSide) return `图片宽高不能超过 ${IMAGE_LIMITS.maxSide} px`;
  return null;
}

export function buildImageForm(p: ImageTranslateParams): FormData {
  const form = new FormData();
  form.append("image", p.image, p.filename ?? "image.png");
  form.append("sourceLang", p.sourceLang || "auto");
  form.append("targetLang", p.targetLang);
  form.append("engine", p.engine || "vision");
  if (p.modelConfigId != null) form.append("modelConfigId", String(p.modelConfigId));
  for (const id of p.glossaryIds ?? []) form.append("glossaryIds", String(id));
  return form;
}

/** POST multipart 并以 SSE 读取（令牌刷新、A0230 重试、AbortSignal 与 streamSse 一致） */
async function streamMultipart(
  path: string,
  form: FormData,
  opts: { signal?: AbortSignal; onMessage: (m: SseMessage) => void },
) {
  await ensureFreshToken();
  const res = await withAuthRetry(async () => {
    let r: Response;
    try {
      r = await fetch(buildUrl(path), {
        method: "POST",
        headers: { Accept: "text/event-stream", ...authHeader() },
        body: form,
        signal: opts.signal,
        cache: "no-store",
      });
    } catch (e) {
      if (isAbortError(e)) throw e;
      throw new ApiError("B0001", "网络异常，无法连接服务器");
    }
    if (!r.ok) throw await toApiError(r);
    if (!(r.headers.get("Content-Type") ?? "").includes("text/event-stream")) throw await toApiError(r);
    return r;
  });
  if (!res.body) throw new ApiError("B0001", "服务响应异常（空响应体）");
  await readSseStream(res.body, opts.onMessage, opts.signal);
}

const BASE = "/api/image-translations";

// 开发 mock 开关在各方法内就地展开，生产构建中整段被移除（见 lib/mock/flags.ts）
export const imageApi = {
  /**
   * 提交图片翻译。流建立之前的错误（A0450 / C0170 / 限流）以 ApiError 抛出；
   * 流建立之后的错误以 error 事件交给 onEvent。
   */
  translate: async (p: ImageTranslateParams, opts: ImageStreamOptions) => {
    const onMessage = (m: SseMessage) => {
      const e = toImageEvent(m);
      if (e) opts.onEvent(e);
    };
    if (process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_MOCK_API === "1") {
      const { mockImageStream } = await import("@/lib/mock/image");
      return mockImageStream(p, { signal: opts.signal, onMessage });
    }
    return streamMultipart(BASE, buildImageForm(p), { signal: opts.signal, onMessage });
  },
  page: (q: ImageQuery) => http.get<PageResult<ImageTranslationItem>>(BASE, { ...q }),
  get: (id: number) => http.get<ImageTranslationDetail>(`${BASE}/${id}`),
  /** 原图字节（带 JWT 的 fetch；调用方自行创建 / 释放 blob URL） */
  image: async (id: number) => (await http.download(`${BASE}/${id}/image`)).blob,
  /** qwen-mt-image 结果图；无则 404 */
  resultImage: async (id: number) => (await http.download(`${BASE}/${id}/result-image`)).blob,
  patchBlocks: (id: number, blocks: { id: number; translation: string }[]) =>
    http.patch<ImageTranslationDetail>(`${BASE}/${id}/blocks`, { blocks }),
  favorite: (id: number, favorite: boolean) => http.put<null>(`${BASE}/${id}/favorite`, { favorite }),
  remove: (id: number) => http.del<null>(`${BASE}/${id}`),
  /** 支持图片输入的对话模型（vision 引擎可选模型） */
  visionModels: () => http.get<ModelOption[]>("/api/model-configs/options", { vision: true }),
};

export const IMAGE_QUERY_KEY = ["image-translations"] as const;
