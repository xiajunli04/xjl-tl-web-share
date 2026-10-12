"use client";

import { useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { AlertCircleIcon, CameraIcon, ClipboardPasteIcon, ImageUpIcon, Loader2Icon, SparklesIcon, UploadIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DURATION, EASE_OUT, staggerDelay } from "@/components/motion";
import { IMAGE_LIMITS } from "@/lib/api/image";
import { IMAGE_SAMPLES, sampleFile, type ImageSample } from "@/lib/image-samples";
import { cn } from "@/lib/utils";

const ACCEPT = IMAGE_LIMITS.mimes.join(",");

/** 从剪贴板读取图片（需要浏览器授权）；不支持时返回 null */
export async function readClipboardImage(): Promise<File | null> {
  if (!navigator.clipboard?.read) return null;
  const items = await navigator.clipboard.read();
  for (const item of items) {
    const type = item.types.find((t) => t.startsWith("image/"));
    if (type) {
      const blob = await item.getType(type);
      return new File([blob], `clipboard-${Date.now()}.${type.split("/")[1] ?? "png"}`, { type });
    }
  }
  return null;
}

/** 空状态：大号拖拽区（拖入流光边框、图标上浮）+ 上传 / 拍照 / 粘贴 + 示例图 */
export function DropZone({
  onFile,
  onCamera,
  onSample,
  error,
  onDismissError,
  coarsePointer,
}: {
  onFile: (file: File) => void;
  onCamera: () => void;
  onSample: (sample: ImageSample, file: File) => void;
  error: string | null;
  onDismissError: () => void;
  /** 触屏设备：拍照直接走 capture 文件输入 */
  coarsePointer: boolean;
}) {
  const reduce = useReducedMotion();
  const inputRef = useRef<HTMLInputElement>(null);
  const captureRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [loadingSample, setLoadingSample] = useState<string | null>(null);
  const depth = useRef(0);

  const pick = (files: FileList | null) => {
    const f = files?.[0];
    if (f) onFile(f);
  };

  const paste = async () => {
    try {
      const file = await readClipboardImage();
      if (file) onFile(file);
      else toast.info("剪贴板里没有图片", { description: "截图后按 Ctrl+V（macOS 为 ⌘V）即可粘贴" });
    } catch {
      toast.info("浏览器未授权读取剪贴板", { description: "请直接按 Ctrl+V（macOS 为 ⌘V）粘贴截图" });
    }
  };

  const chooseSample = async (s: ImageSample) => {
    setLoadingSample(s.key);
    try {
      onSample(s, await sampleFile(s));
    } catch {
      toast.error("示例图加载失败");
    } finally {
      setLoadingSample(null);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <div
        className="relative rounded-3xl p-0.5"
        onDragEnter={(e) => {
          e.preventDefault();
          depth.current++;
          setDragging(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={() => {
          depth.current = Math.max(0, depth.current - 1);
          if (!depth.current) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          depth.current = 0;
          setDragging(false);
          pick(e.dataTransfer.files);
        }}
      >
        {/* 流光边框：拖入时显示旋转的渐变描边 */}
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden rounded-3xl">
          <motion.div
            className="absolute top-1/2 left-1/2 aspect-square w-[150%] -translate-x-1/2 -translate-y-1/2 bg-[conic-gradient(from_0deg,transparent_0%,var(--brand-from)_12%,var(--brand-to)_24%,transparent_36%,transparent_50%,var(--brand-from)_62%,var(--brand-to)_74%,transparent_86%)]"
            initial={false}
            animate={{ opacity: dragging ? 1 : 0, rotate: dragging && !reduce ? 360 : 0 }}
            transition={{
              opacity: { duration: DURATION.page },
              rotate: dragging && !reduce ? { duration: 2.4, ease: "linear", repeat: Infinity } : { duration: 0 },
            }}
          />
        </div>
        <div
          className={cn(
            "relative flex flex-col items-center rounded-[calc(1.5rem-2px)] border-2 border-dashed bg-card px-6 py-12 text-center shadow-card transition-colors duration-300 md:py-16 short:py-7",
            dragging ? "border-transparent bg-brand-soft/30" : "border-border",
          )}
        >
          <div className="pointer-events-none absolute inset-0 rounded-[inherit] bg-[radial-gradient(60%_50%_at_50%_0%,var(--brand-soft),transparent_70%)]" />
          <motion.span
            className="relative mb-5 flex size-16 items-center justify-center rounded-2xl bg-brand-gradient text-brand-foreground shadow-brand"
            animate={{ y: dragging && !reduce ? -10 : 0, scale: dragging && !reduce ? 1.06 : 1 }}
            transition={{ type: "spring", stiffness: 380, damping: 20 }}
          >
            <ImageUpIcon className="size-7" />
          </motion.span>
          <h2 className="relative text-lg font-semibold tracking-tight">
            {dragging ? "松开鼠标，开始翻译" : "拖入图片，或选择下方的方式开始"}
          </h2>
          <p className="relative mt-1.5 text-sm text-muted-foreground">
            识别图中文字并翻译，译文直接覆盖在原位置 · 支持 JPG / PNG / WEBP / BMP，不超过 10 MB
          </p>
          <div className="relative mt-6 flex flex-wrap justify-center gap-2.5">
            <Button size="lg" className="h-10 px-4" onClick={() => inputRef.current?.click()}>
              <UploadIcon />
              上传图片
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="h-10 px-4"
              onClick={() => (coarsePointer ? captureRef.current?.click() : onCamera())}
            >
              <CameraIcon />
              拍照
            </Button>
            <Button size="lg" variant="outline" className="h-10 px-4" onClick={paste}>
              <ClipboardPasteIcon />
              粘贴
              <kbd className="ml-1 rounded border bg-muted px-1 font-mono text-[10px] text-muted-foreground">Ctrl V</kbd>
            </Button>
          </div>
          <input ref={inputRef} type="file" accept={ACCEPT} hidden onChange={(e) => {
              pick(e.target.files);
              e.target.value = "";
            }} />
          <input
            ref={captureRef}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={(e) => {
              pick(e.target.files);
              e.target.value = "";
            }}
          />
          <AnimatePresence>
            {error && (
              <motion.div
                role="alert"
                initial={{ opacity: 0, y: -4, height: 0 }}
                animate={{ opacity: 1, y: 0, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: DURATION.page, ease: EASE_OUT }}
                className="relative mt-5 overflow-hidden"
              >
                <div className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
                  <AlertCircleIcon className="size-4 shrink-0" />
                  {error}
                  <button type="button" aria-label="关闭错误提示" onClick={onDismissError} className="ml-1 rounded p-0.5 hover:bg-danger/10">
                    <XIcon className="size-3.5" />
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <div>
        <div className="mb-3 flex items-center gap-2 text-sm font-medium">
          <SparklesIcon className="size-4 text-brand" />
          试试示例图片
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {IMAGE_SAMPLES.map((s, i) => (
            <motion.button
              key={s.key}
              type="button"
              disabled={!!loadingSample}
              onClick={() => chooseSample(s)}
              initial={{ opacity: 0, y: reduce ? 0 : 8 }}
              animate={{ opacity: 1, y: 0, transition: { duration: DURATION.page, ease: EASE_OUT, delay: 0.1 + staggerDelay(i) } }}
              whileHover={reduce ? undefined : { y: -3 }}
              className="group overflow-hidden rounded-xl border bg-card text-left shadow-card outline-none transition-shadow hover:shadow-popover focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60"
            >
              <div className="relative h-32 overflow-hidden bg-muted">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={s.url} alt={s.title} className="size-full object-cover transition-transform duration-500 group-hover:scale-105" />
                {loadingSample === s.key && (
                  <span className="absolute inset-0 flex items-center justify-center bg-background/60">
                    <Loader2Icon className="size-5 animate-spin text-brand" />
                  </span>
                )}
              </div>
              <div className="flex items-center justify-between px-3 py-2.5">
                <span className="text-sm font-medium">{s.title}</span>
                <span className="text-xs text-muted-foreground">{s.description}</span>
              </div>
            </motion.button>
          ))}
        </div>
      </div>
    </div>
  );
}
