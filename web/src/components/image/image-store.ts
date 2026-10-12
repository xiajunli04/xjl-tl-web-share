"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { imageApi, IMAGE_QUERY_KEY, validateImageFile, validateImageSize, type ImageTranslationDetail } from "@/lib/api/image";
import { editBlock, initialImageRun, reduceImageEvent, startImageRun, type ImageRunState } from "@/lib/image-run";
import { describeError } from "@/lib/errors";
import { ApiError } from "@/lib/http";
import { getQueryClient } from "@/lib/query-client";
import { isAbortError } from "@/lib/sse";

export interface ImageSettings {
  sourceLang: string;
  targetLang: string;
  engine: string;
  /** vision 引擎所用的视觉模型；null 表示默认 */
  modelConfigId: number | null;
  glossaryIds: number[];
}

export interface ImageSource {
  blob: Blob;
  url: string;
  name: string;
  width: number;
  height: number;
}

interface ImageState extends ImageSettings {
  source: ImageSource | null;
  /** qwen-mt-image 结果图（blob URL） */
  resultUrl: string | null;
  run: ImageRunState;
  /** 每次提交递增（查看器据此重置逐块淡入动画） */
  runId: number;
  favorite: boolean;
  /** 输入阶段的错误（格式 / 尺寸 / 流建立前的接口错误） */
  inputError: string | null;
  patch: (p: Partial<ImageSettings>) => void;
  submit: (blob: Blob, name?: string) => Promise<void>;
  /** 以当前图片换目标语言重译 */
  retranslate: (targetLang?: string) => Promise<void>;
  stop: () => void;
  reset: () => void;
  /** 打开一条历史记录（只读数据 + 原图 / 结果图字节） */
  loadRecord: (d: ImageTranslationDetail, original: Blob, result: Blob | null) => Promise<void>;
  editBlock: (id: number, translation: string) => void;
  setFavorite: (on: boolean) => void;
  clearInputError: () => void;
}

const DEFAULTS: ImageSettings = { sourceLang: "auto", targetLang: "en", engine: "vision", modelConfigId: null, glossaryIds: [] };

let controller: AbortController | null = null;

function readSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("无法读取图片，文件可能已损坏"));
    img.src = url;
  });
}

function base64ToBlob(b64: string, type = "image/jpeg"): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

const revoke = (url: string | null | undefined) => {
  if (url) URL.revokeObjectURL(url);
};

/** 图片翻译页状态（模块级：切换路由再回来时保留进行中的任务与结果） */
export const useImageStore = create<ImageState>()(
  persist(
    (set, get) => {
      const begin = async (source: ImageSource) => {
        controller?.abort();
        const ac = new AbortController();
        controller = ac;
        const { sourceLang, targetLang, engine, modelConfigId, glossaryIds } = get();
        revoke(get().resultUrl);
        set((s) => ({ run: startImageRun(engine), runId: s.runId + 1, resultUrl: null, favorite: false, inputError: null }));
        try {
          await imageApi.translate(
            {
              image: source.blob,
              filename: source.name,
              sourceLang,
              targetLang,
              engine,
              modelConfigId: engine === "vision" ? modelConfigId : null,
              glossaryIds,
            },
            {
              signal: ac.signal,
              onEvent: (e) => {
                if (controller !== ac) return;
                set((s) => ({ run: reduceImageEvent(s.run, e) }));
                if (e.event === "done") {
                  if (e.data.resultImageBase64) {
                    set({ resultUrl: URL.createObjectURL(base64ToBlob(e.data.resultImageBase64)) });
                  }
                  void getQueryClient().invalidateQueries({ queryKey: IMAGE_QUERY_KEY });
                }
              },
            },
          );
          // 流正常结束但没有 done / error：视为中断
          if (controller === ac && get().run.status === "running") {
            set((s) => ({ run: { ...s.run, status: "error", error: { code: "B0001", message: "连接已断开，未收到完成事件" } } }));
          }
        } catch (e) {
          if (controller !== ac) return;
          if (isAbortError(e)) {
            set((s) => ({ run: { ...s.run, status: "stopped" } }));
            return;
          }
          const err = e instanceof ApiError ? { code: e.code, message: e.message, traceId: e.traceId } : { code: "B0001", message: describeError(e) };
          set((s) => ({ run: { ...s.run, status: "error", error: err } }));
        } finally {
          if (controller === ac) controller = null;
        }
      };

      return {
        ...DEFAULTS,
        source: null,
        resultUrl: null,
        run: initialImageRun(),
        runId: 0,
        favorite: false,
        inputError: null,
        patch: (p) => set(p),
        clearInputError: () => set({ inputError: null }),
        submit: async (blob, name) => {
          const invalid = validateImageFile(blob);
          if (invalid) {
            set({ inputError: invalid });
            return;
          }
          const url = URL.createObjectURL(blob);
          let size: { width: number; height: number };
          try {
            size = await readSize(url);
          } catch (e) {
            URL.revokeObjectURL(url);
            set({ inputError: describeError(e) });
            return;
          }
          const sizeError = validateImageSize(size.width, size.height);
          if (sizeError) {
            URL.revokeObjectURL(url);
            set({ inputError: sizeError });
            return;
          }
          const prev = get().source;
          const ext = blob.type.split("/")[1] ?? "png";
          const source: ImageSource = { blob, url, name: name || `image.${ext === "jpeg" ? "jpg" : ext}`, ...size };
          set({ source });
          if (prev) revoke(prev.url);
          await begin(source);
        },
        retranslate: async (targetLang) => {
          const src = get().source;
          if (!src) return;
          if (targetLang) set({ targetLang });
          await begin(src);
        },
        stop: () => {
          controller?.abort();
        },
        reset: () => {
          controller?.abort();
          controller = null;
          revoke(get().source?.url);
          revoke(get().resultUrl);
          set({ source: null, resultUrl: null, run: initialImageRun(get().engine), favorite: false, inputError: null });
        },
        loadRecord: async (d, original, result) => {
          controller?.abort();
          controller = null;
          revoke(get().source?.url);
          revoke(get().resultUrl);
          const url = URL.createObjectURL(original);
          set({
            source: { blob: original, url, name: `image-${d.id}`, width: d.width, height: d.height },
            resultUrl: result ? URL.createObjectURL(result) : null,
            favorite: d.favorite,
            inputError: null,
            targetLang: d.targetLang,
            runId: get().runId + 1,
            run: {
              ...initialImageRun(d.engine),
              status: "done",
              phase: "translated",
              recordId: d.id,
              width: d.width,
              height: d.height,
              detectedLang: d.detectedLang,
              blocks: d.blocks,
              termHits: d.termHits ?? [],
              trace: d.trace ?? [],
              usage:
                d.promptTokens != null || d.completionTokens != null
                  ? { promptTokens: d.promptTokens ?? 0, completionTokens: d.completionTokens ?? 0 }
                  : null,
              latencyMs: d.latencyMs ?? undefined,
              modelConfigId: d.modelConfigId,
              steps: Object.fromEntries(
                (["ocr", "terms", "translate", "render"] as const).map((n) => {
                  const t = d.trace?.find((x) => x.node === n);
                  return [n, t ? { status: "done", summary: t.summary ?? undefined, latencyMs: t.latencyMs ?? undefined } : { status: "skipped" }];
                }),
              ) as ImageRunState["steps"],
            },
          });
        },
        editBlock: (id, translation) => set((s) => ({ run: { ...s.run, blocks: editBlock(s.run.blocks, id, translation) } })),
        setFavorite: (favorite) => set({ favorite }),
      };
    },
    {
      name: "tl-image",
      partialize: (s) => ({
        sourceLang: s.sourceLang,
        targetLang: s.targetLang,
        engine: s.engine,
        modelConfigId: s.modelConfigId,
        glossaryIds: s.glossaryIds,
      }),
    },
  ),
);
