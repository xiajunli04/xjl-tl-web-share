"use client";

import { memo, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  AlertCircleIcon,
  CheckIcon,
  CircleDashedIcon,
  Loader2Icon,
  PencilLineIcon,
  SparklesIcon,
  WandSparklesIcon,
  BrainCircuitIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DURATION, EASE_OUT } from "@/components/motion/tokens";
import { docApi, type DocSegmentVO } from "@/lib/api/documents";
import { toastError } from "@/lib/errors";
import { matchInfo } from "@/lib/tm-match";
import { cn } from "@/lib/utils";
import { useWorkspace } from "./context";
import { renderInline, termRegex } from "./inline";
import { RetranslateBox } from "./retranslate";

export type PendingMode = "shimmer" | "awaiting" | "idle";
export type ChunkMark = { index: number; status: "done" | "active" | "pending" } | null;

export interface RowProps {
  seg: DocSegmentVO;
  /** 是否为表格首行（表头） */
  tableHead: boolean;
  chunk: ChunkMark;
  selected: boolean;
  editing: boolean;
  flashNonce: number | null;
  fresh: boolean;
  fixedTo: string[] | null;
  pendingMode: PendingMode;
  actionsEnabled: boolean;
  sourceTerms: RegExp | null;
  targetTerms: RegExp | null;
}

function ListMarker({ prefix }: { prefix: string }) {
  const num = prefix.trim().match(/^(\d+)\./)?.[1];
  return num ? (
    <span className="w-5 shrink-0 text-right text-muted-foreground tabular-nums">{num}.</span>
  ) : (
    <span className="flex w-5 shrink-0 justify-end pt-[0.55em]">
      <span className="size-1.5 rounded-full bg-muted-foreground/60" />
    </span>
  );
}

/** 按 Markdown 语义渲染段落内容 */
function Block({ seg, text, head, terms, miss }: { seg: DocSegmentVO; text: string; head: boolean; terms: RegExp | null; miss?: RegExp | null }) {
  const inline = (t: string) => renderInline(t, { terms, miss });
  switch (seg.blockType) {
    case "heading": {
      const lv = seg.level ?? 2;
      return (
        <div className={cn("font-semibold tracking-tight", lv <= 1 ? "text-lg" : lv === 2 ? "text-base" : "text-sm")}>
          {inline(text)}
        </div>
      );
    }
    case "list_item":
      return (
        <div className="flex gap-2 text-sm leading-relaxed" style={{ paddingLeft: Math.max(0, (seg.level ?? 1) - 1) * 18 }}>
          <ListMarker prefix={seg.prefix} />
          <div className="min-w-0 flex-1">{inline(text)}</div>
        </div>
      );
    case "blockquote":
      return (
        <div className="border-l-2 border-brand/40 pl-3 text-sm leading-relaxed text-foreground/80 italic">{inline(text)}</div>
      );
    case "table_row": {
      if (!seg.translatable) {
        return <div className="font-mono text-[11px] text-muted-foreground/70">{text}</div>;
      }
      const cells = text.split("|").map((c) => c.trim());
      return (
        <div
          className={cn(
            "grid overflow-hidden rounded-md border text-xs",
            head ? "bg-muted/60 font-medium" : "bg-card",
          )}
          style={{ gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))` }}
        >
          {cells.map((c, i) => (
            <div key={i} className={cn("px-2 py-1.5", i > 0 && "border-l")}>
              {inline(c)}
            </div>
          ))}
        </div>
      );
    }
    case "code":
      return (
        <pre className="scrollbar-thin overflow-x-auto rounded-lg bg-muted/70 px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground/80">
          {text}
        </pre>
      );
    case "html":
      return <div className="truncate rounded-md bg-muted/50 px-2 py-1 font-mono text-[11px] text-muted-foreground">{text}</div>;
    case "hr":
      return <div className="my-1.5 h-px bg-border" />;
    default:
      return <div className="text-sm leading-relaxed whitespace-pre-wrap">{inline(text)}</div>;
  }
}

function PendingTarget({ seg, mode }: { seg: DocSegmentVO; mode: PendingMode }) {
  if (mode === "shimmer") {
    const lines = Math.max(1, Math.min(4, Math.ceil(seg.source.length / 70)));
    return (
      <div className="space-y-2 py-0.5" aria-label="翻译中">
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton key={i} className={cn("h-3.5", i === lines - 1 && lines > 1 ? "w-3/5" : "w-full")} />
        ))}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground/70 italic">
      <CircleDashedIcon className="size-3.5" />
      {mode === "awaiting" ? "确认术语后开始翻译" : "未翻译"}
    </div>
  );
}

function InlineEditor({ seg, onClose }: { seg: DocSegmentVO; onClose: () => void }) {
  const { id, store } = useWorkspace();
  const [value, setValue] = useState(seg.target ?? "");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (value === seg.target) return onClose();
    setSaving(true);
    try {
      const vo = await docApi.updateSegment(id, seg.seq, value);
      store.getState().patchSegment(seg.seq, vo ?? { target: value, edited: true });
      toast.success(`已保存 §${seg.seq}`);
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
      <Textarea
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void save();
        }}
        aria-label={`编辑第 ${seg.seq} 段译文`}
        className="min-h-20 bg-background text-sm leading-relaxed"
      />
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground">Ctrl + Enter 保存 · Esc 取消</span>
        <div className="ml-auto flex gap-1.5">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button size="sm" onClick={save} disabled={saving || !value.trim()}>
            {saving ? <Loader2Icon className="animate-spin" /> : <CheckIcon />}
            保存
          </Button>
        </div>
      </div>
    </div>
  );
}

function RowActions({ seg, onPinChange }: { seg: DocSegmentVO; onPinChange: (pinned: boolean) => void }) {
  const { setEditingSeq } = useWorkspace();
  const [open, setOpenState] = useState(false);
  const setOpen = (o: boolean) => {
    setOpenState(o);
    onPinChange(o);
  };
  return (
    <div
      className="absolute top-1.5 right-1.5 z-10 flex animate-in items-center gap-0.5 rounded-lg border bg-popover p-0.5 shadow-popover duration-150 fade-in-0 zoom-in-95"
      onClick={(e) => e.stopPropagation()}
    >
      <Tooltip>
        <TooltipTrigger
          render={<Button variant="ghost" size="icon-xs" aria-label="编辑译文" onClick={() => setEditingSeq(seg.seq)} />}
        >
          <PencilLineIcon />
        </TooltipTrigger>
        <TooltipContent>编辑</TooltipContent>
      </Tooltip>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger render={<Button variant="ghost" size="icon-xs" aria-label="重译本段" />}>
          <WandSparklesIcon />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-auto p-3.5">
          <RetranslateBox seg={seg} compact onDone={() => setOpen(false)} />
        </PopoverContent>
      </Popover>
    </div>
  );
}

function ChunkHeader({ chunk }: { chunk: NonNullable<ChunkMark> }) {
  return (
    <div className="col-span-2 flex items-center gap-2 px-4 pt-3 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 transition-colors duration-500",
          chunk.status === "done" && "bg-success-soft text-success",
          chunk.status === "active" && "bg-brand-soft text-brand",
          chunk.status === "pending" && "bg-muted",
        )}
      >
        {chunk.status === "done" ? (
          <CheckIcon className="size-2.5" />
        ) : chunk.status === "active" ? (
          <Loader2Icon className="size-2.5 animate-spin motion-reduce:animate-none" />
        ) : (
          <CircleDashedIcon className="size-2.5" />
        )}
        块 {chunk.index + 1}
      </span>
      <span className="h-px flex-1 bg-border/70" />
    </div>
  );
}

/** 双栏对照中的一行：原文 | 译文（同一行两栏等高） */
export const SegmentRow = memo(function SegmentRow(p: RowProps) {
  const { seg } = p;
  const { select, setEditingSeq } = useWorkspace();
  const reduce = useReducedMotion();
  // 悬停 / 选中 / 弹层打开时才挂载操作按钮，避免可视区内每行都创建 Tooltip 与 Popover
  const [hot, setHot] = useState(false);
  const [pinned, setPinned] = useState(false);
  const translated = seg.target !== null && seg.target !== undefined;
  const missWords = (seg.compliance ?? []).filter((c) => !c.compliant).map((c) => c.source);
  const miss = missWords.length ? termRegex(missWords) : null;
  const bar = !seg.translatable
    ? "bg-transparent"
    : p.fixedTo
      ? "bg-warning"
      : seg.edited
        ? "bg-info"
        : translated
          ? "bg-brand"
          : "bg-border";

  return (
    <div className="relative">
      {p.chunk && <ChunkHeader chunk={p.chunk} />}
      <div
        role="button"
        tabIndex={-1}
        aria-pressed={p.selected}
        data-seq={seg.seq}
        onClick={() => select(p.selected ? null : seg.seq)}
        onPointerEnter={() => setHot(true)}
        onPointerLeave={() => setHot(false)}
        onFocus={() => setHot(true)}
        className={cn(
          "group/row relative grid cursor-default grid-cols-2 transition-colors duration-150",
          p.selected ? "bg-brand-soft/60" : "hover:bg-muted/40",
          !seg.translatable && "opacity-80",
        )}
      >
        {p.flashNonce !== null && (
          <span key={p.flashNonce} className="pointer-events-none absolute inset-0 z-0 animate-flash rounded-sm" aria-hidden />
        )}
        {p.selected && <span className="absolute inset-y-0 left-0 w-0.5 bg-brand-gradient" aria-hidden />}

        {/* 原文 */}
        <div className="relative min-w-0 py-2.5 pr-4 pl-12">
          <span className="absolute top-3 left-3 w-6 text-right font-mono text-[10px] text-muted-foreground/60 tabular-nums select-none">
            {seg.seq}
          </span>
          <Block seg={seg} text={seg.source} head={p.tableHead} terms={p.sourceTerms} miss={miss} />
        </div>

        {/* 译文 */}
        <div className="relative min-w-0 border-l border-border/60 py-2.5 pr-4 pl-5">
          <span className={cn("absolute top-2.5 bottom-2.5 left-0 w-0.5 rounded-full transition-colors duration-700", bar)} aria-hidden />
          {p.editing ? (
            <InlineEditor seg={seg} onClose={() => setEditingSeq(null)} />
          ) : !seg.translatable ? (
            <div className="relative">
              <Block seg={seg} text={seg.source} head={p.tableHead} terms={null} />
              {seg.blockType !== "hr" && (
                <span className="mt-1 inline-flex rounded bg-muted px-1.5 py-px text-[10px] text-muted-foreground">原样保留</span>
              )}
            </div>
          ) : translated ? (
            <motion.div
              key={seg.target}
              initial={p.fresh ? { opacity: 0, y: reduce ? 0 : 3 } : false}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: DURATION.page * 1.6, ease: EASE_OUT }}
            >
              <Block seg={seg} text={seg.target!} head={p.tableHead} terms={p.targetTerms} />
              {(seg.edited || p.fixedTo || missWords.length > 0 || !!seg.tmHits?.length) && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {!!seg.tmHits?.length && (
                    <span className="inline-flex items-center gap-0.5 rounded bg-brand-soft px-1.5 py-px text-[10px] text-brand">
                      <BrainCircuitIcon className="size-2.5" />
                      记忆 {matchInfo(seg.tmHits[0]).label}
                    </span>
                  )}
                  {seg.edited && (
                    <span className="inline-flex items-center gap-0.5 rounded bg-info-soft px-1.5 py-px text-[10px] text-info">
                      <PencilLineIcon className="size-2.5" />
                      已编辑
                    </span>
                  )}
                  {p.fixedTo && (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span className="inline-flex cursor-help items-center gap-0.5 rounded bg-warning-soft px-1.5 py-px text-[10px] text-warning" />
                        }
                      >
                        <SparklesIcon className="size-2.5" />
                        一致性已修正
                      </TooltipTrigger>
                      <TooltipContent>已统一为「{p.fixedTo.join("」「")}」</TooltipContent>
                    </Tooltip>
                  )}
                  {missWords.length > 0 && (
                    <span className="inline-flex items-center gap-0.5 rounded bg-danger-soft px-1.5 py-px text-[10px] text-danger">
                      <AlertCircleIcon className="size-2.5" />
                      术语未遵循：{missWords.join("、")}
                    </span>
                  )}
                </div>
              )}
            </motion.div>
          ) : (
            <PendingTarget seg={seg} mode={p.pendingMode} />
          )}
          {p.actionsEnabled && seg.translatable && !p.editing && (hot || pinned || p.selected) && (
            <RowActions seg={seg} onPinChange={setPinned} />
          )}
        </div>
      </div>
    </div>
  );
});
