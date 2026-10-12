"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from "motion/react";
import { Columns2Icon, ImageIcon, LanguagesIcon, MinusIcon, PlusIcon, ScanSearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { DURATION, EASE_OUT } from "@/components/motion/tokens";
import type { ImageBlock } from "@/lib/api/image";
import { computeStyles, displaySize, renderToCanvas, type BlockStyle } from "@/lib/image-render";
import { cn } from "@/lib/utils";
import { useImageElement } from "./use-image-element";

export type ViewMode = "translated" | "original" | "compare";

export interface Highlight {
  id: number;
  /** 每次点击递增，用于重复点击同一块时重新播放脉冲 */
  nonce: number;
}

const MODE_OPTIONS = [
  { value: "translated", label: <><LanguagesIcon className="size-3.5" />译图</>, title: "原图上覆盖译文" },
  { value: "original", label: <><ImageIcon className="size-3.5" />原图</>, title: "原始图片" },
  { value: "compare", label: <><Columns2Icon className="size-3.5" />对比</>, title: "拖动分隔滑块对比：左侧原图，右侧译图" },
] as const;

const ZOOMS = [1, 1.5, 2, 3, 4];
const pct = (v: number) => `${(v * 100).toFixed(3)}%`;

/**
 * 画布查看器：
 * - 「译图 / 原图 / 对比」三种查看方式；对比为可拖拽分隔滑块（左原图、右译图），松手惯性回弹；
 * - 缩放（1×–4×，可滚动）；
 * - 处理中：扫描线循环（reduced-motion 下改为进度条），文本框错开淡入描边，译文逐块交叉淡入；
 * - 点击文本列表时对应框高亮脉冲；qwen-mt-image 记录用结果图代替覆盖渲染。
 */
export function ImageViewer({
  src,
  width,
  height,
  blocks,
  resultUrl,
  phase = "translated",
  processing = false,
  progress = 0,
  statusText,
  highlight,
  onBlockClick,
  mode: modeProp,
  onModeChange,
  className,
  compact,
}: {
  src: string;
  width: number;
  height: number;
  blocks: ImageBlock[];
  resultUrl?: string | null;
  phase?: "scanning" | "blocks" | "translated";
  processing?: boolean;
  /** 0–1，reduced-motion 下的进度条 */
  progress?: number;
  statusText?: string;
  highlight?: Highlight | null;
  onBlockClick?: (id: number) => void;
  mode?: ViewMode;
  onModeChange?: (m: ViewMode) => void;
  className?: string;
  /** 只读小尺寸（历史详情） */
  compact?: boolean;
}) {
  const reduce = useReducedMotion();
  const img = useImageElement(src);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [innerMode, setInnerMode] = useState<ViewMode>("translated");
  const mode = modeProp ?? innerMode;
  const setMode = (m: ViewMode) => (onModeChange ? onModeChange(m) : setInnerMode(m));
  const [zoom, setZoom] = useState(1);

  const hasResultImage = !!resultUrl;
  const translatedReady = hasResultImage || blocks.some((b) => (b.translation ?? "").trim());
  // 处理中只展示原图 + 文本框 + 逐块淡入的译文；完成后按查看方式展示
  const effectiveMode: ViewMode = processing ? "translated" : translatedReady ? mode : "original";

  /* ---------- 覆盖渲染 ---------- */
  const geometryKey = blocks.map((b) => `${b.id}:${b.bbox.join(",")}`).join("|");
  const styles = useMemo<Map<number, BlockStyle>>(
    () => (img && blocks.length ? computeStyles(img, blocks) : new Map()),
    // 只在图片或文本框几何变化时重新取色（编辑译文不需要）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [img, geometryKey],
  );
  const size = displaySize(width, height);
  const animatedRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !img || hasResultImage) return;
    canvas.width = size.width;
    canvas.height = size.height;
    const hasTranslation = blocks.some((b) => (b.translation ?? "").trim());
    // 首次出现译文（处理中）时逐块交叉淡入，其余情况（编辑、历史）直接重绘
    if (processing && hasTranslation && !animatedRef.current && !reduce) {
      animatedRef.current = true;
      const start = performance.now();
      const STAGGER = 70;
      const DUR = 260;
      let raf = 0;
      const frame = (now: number) => {
        const t = now - start;
        renderToCanvas(canvas, img, blocks, styles, { alphaOf: (i) => (t - i * STAGGER) / DUR });
        if (t < blocks.length * STAGGER + DUR) raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
      return () => cancelAnimationFrame(raf);
    }
    if (hasTranslation) animatedRef.current = true;
    renderToCanvas(canvas, img, blocks, styles);
  }, [img, blocks, styles, size.width, size.height, hasResultImage, processing, reduce]);

  /* ---------- 对比滑块 ---------- */
  const pos = useMotionValue(50);
  const clip = useTransform(pos, (v) => `inset(0 0 0 ${v}%)`);
  const handleLeft = useTransform(pos, (v) => `${v}%`);
  const drag = useRef<{ samples: { x: number; t: number }[] } | null>(null);

  const percentAt = (clientX: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || !rect.width) return pos.get();
    return Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100));
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (effectiveMode !== "compare") return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pos.stop();
    const p = percentAt(e.clientX);
    pos.set(p);
    drag.current = { samples: [{ x: p, t: performance.now() }] };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const p = percentAt(e.clientX);
    pos.set(p);
    const s = drag.current.samples;
    s.push({ x: p, t: performance.now() });
    if (s.length > 5) s.shift();
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || reduce) return;
    const s = d.samples;
    const first = s[0];
    const last = s[s.length - 1];
    const dt = (last.t - first.t) / 1000;
    const velocity = dt > 0 ? (last.x - first.x) / dt : 0;
    // 惯性滑行，越界时弹回边界
    animate(pos, 0, {
      type: "inertia",
      velocity,
      power: 0.25,
      timeConstant: 220,
      min: 0,
      max: 100,
      bounceStiffness: 320,
      bounceDamping: 26,
      restDelta: 0.05,
    });
  };
  const onHandleKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 2;
    if (e.key === "ArrowLeft") pos.set(Math.max(0, pos.get() - step));
    else if (e.key === "ArrowRight") pos.set(Math.min(100, pos.get() + step));
    else return;
    e.preventDefault();
  };

  const showBoxes = phase === "blocks" && blocks.length > 0;
  const zoomIndex = ZOOMS.indexOf(zoom);
  const ratio = width / height;
  const hl = highlight ? blocks.find((b) => b.id === highlight.id) : undefined;

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      {!processing && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 pb-2.5">
          {translatedReady && (
            <Segmented<ViewMode>
              ariaLabel="查看方式"
              size="sm"
              value={mode}
              onChange={setMode}
              options={MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label, title: o.title }))}
            />
          )}
          <div className="ml-auto flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="缩小"
              disabled={zoomIndex <= 0}
              onClick={() => setZoom(ZOOMS[Math.max(0, zoomIndex - 1)])}
            >
              <MinusIcon />
            </Button>
            <button
              type="button"
              onClick={() => setZoom(1)}
              className="min-w-11 rounded-md px-1 text-center text-xs text-muted-foreground tabular-nums hover:text-foreground"
              title="重置缩放"
            >
              {Math.round(zoom * 100)}%
            </button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="放大"
              disabled={zoomIndex >= ZOOMS.length - 1}
              onClick={() => setZoom(ZOOMS[Math.min(ZOOMS.length - 1, zoomIndex + 1)])}
            >
              <PlusIcon />
            </Button>
          </div>
        </div>
      )}

      {/* 视口：按容器宽高适配图片比例，放大后可滚动 */}
      <div
        className={cn(
          "scrollbar-thin relative min-h-0 flex-1 overflow-auto rounded-xl bg-[repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)] bg-size-[20px_20px]",
          compact ? "min-h-64" : "min-h-80",
        )}
        style={{ containerType: "size" }}
      >
        <div className="flex min-h-full min-w-full items-center justify-center p-3">
          <motion.div
            ref={stageRef}
            className={cn(
              "relative shrink-0 overflow-hidden rounded-lg shadow-popover ring-1 ring-foreground/10 select-none",
              effectiveMode === "compare" && "cursor-ew-resize touch-none",
            )}
            style={{
              aspectRatio: `${width} / ${height}`,
              width: `calc(min(100cqw - 24px, (100cqh - 24px) * ${ratio}) * ${zoom})`,
            }}
            layout={!reduce}
            transition={{ duration: DURATION.page, ease: EASE_OUT }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {/* 原图（底层） */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt="原图" draggable={false} className="absolute inset-0 size-full" />

            {/* 译图层：覆盖渲染画布或 qwen-mt-image 结果图 */}
            <motion.div
              className="absolute inset-0"
              style={{ clipPath: effectiveMode === "compare" ? clip : "inset(0 0 0 0%)" }}
              initial={false}
              animate={{ opacity: effectiveMode === "original" ? 0 : 1 }}
              transition={{ duration: DURATION.page, ease: EASE_OUT }}
            >
              {hasResultImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={resultUrl!} alt="译图" draggable={false} className="size-full" />
              ) : (
                <canvas ref={canvasRef} aria-label="译图" className="size-full" />
              )}
            </motion.div>

            {/* 处理中：OCR 文本框依次描边淡入 */}
            <AnimatePresence>
              {showBoxes &&
                blocks.map((b, i) => (
                  <motion.span
                    key={`box-${b.id}`}
                    aria-hidden
                    className="pointer-events-none absolute rounded-[3px] border-2 border-brand bg-brand/10 shadow-[0_0_0_3px_color-mix(in_oklch,var(--brand)_18%,transparent)]"
                    style={{ left: pct(b.bbox[0]), top: pct(b.bbox[1]), width: pct(b.bbox[2] - b.bbox[0]), height: pct(b.bbox[3] - b.bbox[1]) }}
                    initial={{ opacity: 0, scale: reduce ? 1 : 1.06 }}
                    animate={{ opacity: 1, scale: 1, transition: { duration: DURATION.page, ease: EASE_OUT, delay: reduce ? 0 : i * 0.06 } }}
                    exit={{ opacity: 0, transition: { duration: 0.3, delay: reduce ? 0 : i * 0.04 } }}
                  />
                ))}
            </AnimatePresence>

            {/* 可点击热区（选中文本块） */}
            {onBlockClick && !processing && effectiveMode !== "compare" && !hasResultImage &&
              blocks.map((b) => (
                <button
                  key={`hit-${b.id}`}
                  type="button"
                  aria-label={`选中文本块：${b.text}`}
                  onClick={() => onBlockClick(b.id)}
                  className="absolute rounded-[3px] outline-none hover:ring-2 hover:ring-brand/50 focus-visible:ring-2 focus-visible:ring-brand"
                  style={{ left: pct(b.bbox[0]), top: pct(b.bbox[1]), width: pct(b.bbox[2] - b.bbox[0]), height: pct(b.bbox[3] - b.bbox[1]) }}
                />
              ))}

            {/* 高亮脉冲 */}
            <AnimatePresence>
              {hl && highlight && effectiveMode !== "original" && (
                <motion.span
                  key={`hl-${highlight.id}-${highlight.nonce}`}
                  aria-hidden
                  className="pointer-events-none absolute rounded-[4px] border-2 border-brand"
                  style={{ left: pct(hl.bbox[0]), top: pct(hl.bbox[1]), width: pct(hl.bbox[2] - hl.bbox[0]), height: pct(hl.bbox[3] - hl.bbox[1]) }}
                  initial={{ opacity: 0 }}
                  animate={
                    reduce
                      ? { opacity: 1 }
                      : {
                          opacity: 1,
                          boxShadow: [
                            "0 0 0 0px color-mix(in oklch, var(--brand) 55%, transparent)",
                            "0 0 0 10px color-mix(in oklch, var(--brand) 0%, transparent)",
                            "0 0 0 0px color-mix(in oklch, var(--brand) 55%, transparent)",
                            "0 0 0 10px color-mix(in oklch, var(--brand) 0%, transparent)",
                          ],
                        }
                  }
                  exit={{ opacity: 0 }}
                  transition={{ duration: 1.4, ease: "easeOut" }}
                />
              )}
            </AnimatePresence>

            {/* 对比分隔线 */}
            {effectiveMode === "compare" && (
              <motion.div className="pointer-events-none absolute inset-y-0 z-10 w-0" style={{ left: handleLeft }}>
                <span className="absolute inset-y-0 -left-px w-0.5 bg-white shadow-[0_0_0_1px_rgb(0_0_0/0.15)]" />
                <button
                  type="button"
                  role="slider"
                  aria-label="对比分隔位置"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(pos.get())}
                  onKeyDown={onHandleKey}
                  className="pointer-events-auto absolute top-1/2 left-0 flex size-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white text-neutral-700 shadow-popover ring-1 ring-black/10 outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  <Columns2Icon className="size-4" />
                </button>
                <span className="absolute top-3 right-3 rounded-md bg-black/55 px-1.5 py-0.5 text-[11px] whitespace-nowrap text-white">原图</span>
                <span className="absolute top-3 left-3 rounded-md bg-black/55 px-1.5 py-0.5 text-[11px] whitespace-nowrap text-white">译图</span>
              </motion.div>
            )}

            {/* 扫描线 / reduced-motion 进度条 */}
            <AnimatePresence>
              {processing && (
                <motion.div
                  key="scan"
                  className="pointer-events-none absolute inset-0"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0, transition: { duration: 0.4 } }}
                >
                  {reduce ? (
                    <div className="absolute inset-x-0 bottom-0 bg-black/45 px-3 py-2 text-xs text-white backdrop-blur-sm">
                      <div className="mb-1.5 flex items-center gap-1.5">
                        <ScanSearchIcon className="size-3.5" />
                        {statusText ?? "识别中"}
                      </div>
                      <div className="h-1 overflow-hidden rounded-full bg-white/25" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                        <div className="h-full rounded-full bg-white transition-[width] duration-300" style={{ width: `${Math.max(6, progress * 100)}%` }} />
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="absolute inset-0 bg-linear-to-b from-brand/5 via-transparent to-brand/5" />
                      <motion.div
                        className="absolute inset-x-0 h-24 -translate-y-full bg-linear-to-b from-transparent via-brand/25 to-transparent"
                        animate={{ top: ["0%", "100%"] }}
                        transition={{ duration: 2.2, ease: "linear", repeat: Infinity }}
                      >
                        <span className="absolute inset-x-0 bottom-1/2 h-0.5 bg-brand shadow-[0_0_14px_2px_var(--brand)]" />
                      </motion.div>
                    </>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </div>
      </div>
    </div>
  );
}
