"use client";

import { useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useReducedMotion } from "motion/react";
import { FileSearchIcon, LocateFixedIcon, ScanTextIcon } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/feedback/empty-state";
import { useDocTaskSelector } from "@/hooks/use-doc-task";
import { langName } from "@/lib/languages";
import { visibleSegments } from "@/lib/doc-task";
import type { DocSegmentVO } from "@/lib/api/documents";
import { cn } from "@/lib/utils";
import { useWorkspace } from "./context";
import { activeTerms, termRegex } from "./inline";
import { SegmentRow, type ChunkMark, type PendingMode } from "./segment-row";

const FRESH_MS = 2000;

function ListSkeleton({ label }: { label?: string }) {
  return (
    <div className="relative flex-1 overflow-hidden" aria-busy="true">
      {Array.from({ length: 10 }).map((_, i) => (
        <div key={i} className="grid grid-cols-2 border-b border-border/40">
          <div className="space-y-2 py-3 pr-4 pl-12">
            <Skeleton className={cn("h-3.5", i % 3 === 0 ? "w-2/5" : "w-full")} />
            {i % 3 !== 0 && <Skeleton className="h-3.5 w-4/5" />}
          </div>
          <div className="space-y-2 border-l border-border/40 py-3 pr-4 pl-5">
            <Skeleton className={cn("h-3.5", i % 3 === 0 ? "w-1/3" : "w-11/12")} />
            {i % 3 !== 0 && <Skeleton className="h-3.5 w-3/5" />}
          </div>
        </div>
      ))}
      {label && (
        <div className="absolute inset-x-0 top-24 flex justify-center">
          <span className="inline-flex items-center gap-2 rounded-full border bg-popover px-4 py-2 text-sm shadow-popover">
            <ScanTextIcon className="size-4 animate-breathe rounded-full text-brand motion-reduce:animate-none" />
            {label}
          </span>
        </div>
      )}
    </div>
  );
}

/** 双栏对照虚拟列表：只渲染可视区域；按内容动态测量行高（同一行两栏等高） */
export function SegmentList() {
  const ws = useWorkspace();
  const reduce = useReducedMotion();
  const task = useDocTaskSelector(ws.store, (s) => s.task);
  const segments = useDocTaskSelector(ws.store, (s) => s.segments);
  const terms = useDocTaskSelector(ws.store, (s) => s.terms);
  const doneChunks = useDocTaskSelector(ws.store, (s) => s.doneChunks);
  const freshAt = useDocTaskSelector(ws.store, (s) => s.freshAt);
  const fixedAt = useDocTaskSelector(ws.store, (s) => s.fixedAt);
  const lastChunk = useDocTaskSelector(ws.store, (s) => s.lastChunk);
  const parentRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => (segments ? visibleSegments(segments) : []), [segments]);
  const rowOfSeq = useMemo(() => {
    const m = new Map<number, number>();
    rows.forEach((s, i) => m.set(s.seq, i));
    return m;
  }, [rows]);

  const status = task?.status;
  const translating = status === "TRANSLATING";
  const pendingMode: PendingMode =
    status === "TRANSLATING" || status === "ANALYZING" || status === "PARSING" || status === "PENDING"
      ? "shimmer"
      : status === "AWAITING_CONFIRM"
        ? "awaiting"
        : "idle";
  // 终结后所有可翻译段都可编辑 / 重译；执行中只允许已有译文的段（一致性阶段会改写译文，期间禁用）
  const terminal = status === "COMPLETED" || status === "FAILED" || status === "CANCELLED";
  const actionsMode: "all" | "translated" | "none" = terminal ? "all" : status === "CONSISTENCY" ? "none" : "translated";

  const sourceTerms = useMemo(() => termRegex(activeTerms(terms).map((t) => t.source)), [terms]);
  const targetTerms = useMemo(
    () => termRegex(activeTerms(terms).filter((t) => t.target !== t.source).map((t) => t.target)),
    [terms],
  );

  // 一致性报告：段落 → 被统一成的译法
  const fixedTo = useMemo(() => {
    const m = new Map<number, string[]>();
    for (const issue of task?.consistencyReport?.issues ?? []) {
      for (const seq of issue.fixedSegs) m.set(seq, [...(m.get(seq) ?? []), issue.chosen]);
    }
    return m;
  }, [task?.consistencyReport]);

  // 当前在翻译的块：第一个未完成的块
  const activeChunk = useMemo(() => {
    if (!translating || !segments) return null;
    let min: number | null = null;
    for (const s of segments) {
      if (s.chunkIndex === null || doneChunks.has(s.chunkIndex)) continue;
      if (!s.translatable) continue;
      if (min === null || s.chunkIndex < min) min = s.chunkIndex;
    }
    return min;
  }, [translating, segments, doneChunks]);

  // React Compiler 不对 useVirtualizer 做记忆化（其返回值包含可变方法）
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => {
      const s = rows[i];
      if (!s) return 56;
      if (s.blockType === "code") return 40 + s.source.split("\n").length * 17;
      if (s.blockType === "heading") return 52;
      return 36 + Math.ceil(s.source.length / 70) * 22;
    },
    overscan: 8,
    getItemKey: (i) => rows[i]?.seq ?? i,
  });

  // 定位：滚动到目标段落（闪烁由行内动画完成）
  const flash = ws.flash;
  useEffect(() => {
    if (!flash) return;
    const idx = rowOfSeq.get(flash.seq);
    if (idx === undefined) return;
    virtualizer.scrollToIndex(idx, { align: "center" });
  }, [flash, rowOfSeq, virtualizer]);

  // 自动跟随：新完成的块滚动到可视区域
  useEffect(() => {
    if (!ws.follow || lastChunk === null || !segments) return;
    const first = segments.find((s) => s.chunkIndex === lastChunk && s.blockType !== "blank");
    const idx = first ? rowOfSeq.get(first.seq) : undefined;
    if (idx === undefined) return;
    virtualizer.scrollToIndex(idx, { align: "start", behavior: reduce ? "auto" : "smooth" });
    // 只在新块完成时触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastChunk]);

  const srcLang = task ? (task.sourceLang === "auto" ? task.detectedLang : task.sourceLang) : null;
  const now = Date.now();
  const items = virtualizer.getVirtualItems();
  const translatableCount = rows.filter((s) => s.translatable).length;

  const header = (
    <div className="grid shrink-0 grid-cols-2 border-b bg-muted/30 text-xs">
      <div className="flex items-center gap-2 py-2 pr-4 pl-12 font-medium">
        原文
        <span className="font-normal text-muted-foreground">{srcLang ? langName(srcLang) : "识别中"}</span>
        {segments && (
          <span className="ml-auto font-normal text-muted-foreground tabular-nums">
            {rows.length} 段 · 可翻译 {translatableCount}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 border-l py-2 pr-3 pl-5 font-medium">
        译文
        <span className="font-normal text-muted-foreground">{task ? langName(task.targetLang) : ""}</span>
        <label className="ml-auto inline-flex cursor-pointer items-center gap-1.5 font-normal text-muted-foreground">
          <LocateFixedIcon className="size-3.5" />
          自动跟随
          <Switch size="sm" checked={ws.follow} onCheckedChange={ws.setFollow} aria-label="自动跟随翻译进度" />
        </label>
      </div>
    </div>
  );

  if (!segments) {
    const parsing = !task || status === "PENDING" || status === "PARSING";
    return (
      <>
        {header}
        <ListSkeleton label={parsing ? "正在解析文档结构…" : undefined} />
      </>
    );
  }
  if (!rows.length) {
    return (
      <>
        {header}
        <EmptyState
          className="flex-1"
          icon={FileSearchIcon}
          title="还没有可显示的段落"
          description={status === "CANCELLED" || status === "FAILED" ? "任务在解析完成前已结束，继续执行后会重新解析。" : "文档解析完成后将在这里逐段对照显示。"}
        />
      </>
    );
  }

  return (
    <>
      {header}
      <div ref={parentRef} className="scrollbar-thin relative min-h-0 flex-1 overflow-y-auto" style={{ contain: "strict" }}>
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((vi) => {
            const seg = rows[vi.index];
            const prev: DocSegmentVO | undefined = rows[vi.index - 1];
            const chunk: ChunkMark =
              seg.chunkIndex !== null && seg.chunkIndex !== prev?.chunkIndex
                ? {
                    index: seg.chunkIndex,
                    status: doneChunks.has(seg.chunkIndex) ? "done" : seg.chunkIndex === activeChunk ? "active" : "pending",
                  }
                : null;
            const fresh = (freshAt.get(seg.seq) ?? 0) > now - FRESH_MS;
            const fixedRecently = (fixedAt.get(seg.seq) ?? 0) > now - FRESH_MS;
            const flashNonce =
              flash?.seq === seg.seq ? flash.nonce : fixedRecently ? (fixedAt.get(seg.seq) ?? null) : null;
            return (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                className="absolute top-0 left-0 w-full border-b border-border/50"
                style={{ transform: `translateY(${vi.start}px)` }}
              >
                <SegmentRow
                  seg={seg}
                  tableHead={seg.blockType === "table_row" && prev?.blockType !== "table_row"}
                  chunk={chunk}
                  selected={ws.selectedSeq === seg.seq}
                  editing={ws.editingSeq === seg.seq}
                  flashNonce={flashNonce}
                  fresh={fresh}
                  fixedTo={fixedTo.get(seg.seq) ?? null}
                  pendingMode={pendingMode}
                  actionsEnabled={actionsMode === "all" || (actionsMode === "translated" && seg.target !== null)}
                  sourceTerms={sourceTerms}
                  targetTerms={targetTerms}
                />
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
