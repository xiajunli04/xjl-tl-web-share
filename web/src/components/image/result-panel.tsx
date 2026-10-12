"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  BookMarkedIcon,
  CheckCircle2Icon,
  CheckIcon,
  CircleAlertIcon,
  CoinsIcon,
  ImageOffIcon,
  Loader2Icon,
  PencilIcon,
  ScanTextIcon,
  TimerIcon,
  XCircleIcon,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/feedback/empty-state";
import { formatMs, formatTokens } from "@/components/agent/node-meta";
import { StaggerItem } from "@/components/motion/stagger";
import { DURATION, EASE_OUT } from "@/components/motion/tokens";
import type { ImageBlock, ImageTermHit, ImageTraceItem } from "@/lib/api/image";
import type { Usage } from "@/lib/api/translate";
import { STEP_LABEL } from "@/lib/image-run";
import { langName } from "@/lib/languages";
import { cn } from "@/lib/utils";

export type SaveState = "saving" | "saved" | "error";

function BlockRow({
  b,
  index,
  selected,
  readOnly,
  save,
  onSelect,
  onEdit,
  onCommit,
}: {
  b: ImageBlock;
  index: number;
  selected: boolean;
  readOnly?: boolean;
  save?: SaveState;
  onSelect: () => void;
  onEdit: (text: string) => void;
  onCommit: (text: string, original: string) => void;
}) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLLIElement>(null);
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [selected, reduce]);

  const start = () => {
    if (readOnly) return;
    setEditing(b.translation ?? "");
    onSelect();
  };
  const finish = (commit: boolean) => {
    if (editing === null) return;
    const original = editing;
    setEditing(null);
    if (!commit) onEdit(original);
    else if ((b.translation ?? "") !== original) onCommit(b.translation ?? "", original);
  };

  return (
    <StaggerItem index={index}>
      <li
        ref={ref}
        onClick={onSelect}
        className={cn(
          "group relative cursor-pointer rounded-lg border px-3 py-2.5 transition-colors",
          selected ? "border-brand/40 bg-brand-soft/40" : "border-transparent hover:bg-muted/50",
        )}
      >
        {selected && !reduce && (
          <motion.span layoutId="image-block-selected" className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-brand" transition={{ duration: DURATION.page, ease: EASE_OUT }} />
        )}
        <div className="flex items-start gap-2.5">
          <span
            className={cn(
              "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md text-[11px] font-medium tabular-nums",
              selected ? "bg-brand text-brand-foreground" : "bg-muted text-muted-foreground",
            )}
          >
            {index + 1}
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-xs leading-relaxed text-muted-foreground">{b.text}</p>
            {editing !== null ? (
              <Textarea
                autoFocus
                rows={2}
                value={b.translation ?? ""}
                aria-label={`编辑第 ${index + 1} 块译文`}
                className="min-h-14 resize-none text-sm"
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => onEdit(e.target.value)}
                onBlur={() => finish(true)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    finish(true);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    finish(false);
                  }
                }}
              />
            ) : (
              <p
                className="text-sm leading-relaxed font-medium break-words"
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  start();
                }}
              >
                {b.translation || <span className="font-normal text-muted-foreground italic">（无译文）</span>}
              </p>
            )}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            {!readOnly && editing === null && (
              <button
                type="button"
                aria-label={`编辑第 ${index + 1} 块译文`}
                onClick={(e) => {
                  e.stopPropagation();
                  start();
                }}
                className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100"
              >
                <PencilIcon className="size-3.5" />
              </button>
            )}
            <AnimatePresence mode="wait">
              {save && (
                <motion.span
                  key={save}
                  initial={{ opacity: 0, y: reduce ? 0 : -2 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className={cn(
                    "inline-flex items-center gap-1 text-[11px] whitespace-nowrap",
                    save === "error" ? "text-danger" : save === "saved" ? "text-success" : "text-muted-foreground",
                  )}
                >
                  {save === "saving" ? <Loader2Icon className="size-3 animate-spin" /> : save === "saved" ? <CheckIcon className="size-3" /> : <CircleAlertIcon className="size-3" />}
                  {save === "saving" ? "保存中" : save === "saved" ? "已保存" : "保存失败"}
                </motion.span>
              )}
            </AnimatePresence>
          </div>
        </div>
      </li>
    </StaggerItem>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-sm font-medium">{children}</div>
    </div>
  );
}

export function TermHits({ hits, unsupported }: { hits: ImageTermHit[]; unsupported?: boolean }) {
  if (!hits.length) {
    return (
      <EmptyState
        compact
        icon={BookMarkedIcon}
        title={unsupported ? "该引擎不使用术语库" : "没有命中术语"}
        description={unsupported ? "千问图片翻译一次完成识别与翻译，无法按术语库约束译文。" : "在工具条中选择术语库后，命中的术语会作为翻译的硬约束。"}
      />
    );
  }
  return (
    <ul className="space-y-2">
      {hits.map((h, i) => (
        <StaggerItem key={`${h.source}-${i}`} index={i}>
          <li className="flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2 text-sm">
            {h.followed ? <CheckCircle2Icon className="size-4 shrink-0 text-success" /> : <XCircleIcon className="size-4 shrink-0 text-danger" />}
            <span className="min-w-0 flex-1">
              <span className="font-medium">{h.source}</span>
              <span className="mx-1.5 text-muted-foreground">→</span>
              <span className="font-medium text-brand">{h.target}</span>
            </span>
            <span className="text-[11px] text-muted-foreground">块 {h.blockIds.map((x) => `#${x}`).join(" ")}</span>
            <span className={cn("rounded-md px-1.5 py-0.5 text-[11px]", h.followed ? "bg-success-soft text-success" : "bg-danger-soft text-danger")}>
              {h.followed ? "已遵循" : "未遵循"}
            </span>
          </li>
        </StaggerItem>
      ))}
    </ul>
  );
}

export function TraceList({ trace }: { trace: ImageTraceItem[] }) {
  if (!trace.length) return null;
  return (
    <ol className="relative space-y-3 pl-5 before:absolute before:top-1.5 before:bottom-1.5 before:left-[5px] before:w-px before:bg-border">
      {trace.map((t, i) => (
        <StaggerItem key={`${t.node}-${i}`} index={i}>
          <li className="relative">
            <span className="absolute top-1.5 -left-5 size-2.5 rounded-full border-2 border-background bg-success ring-1 ring-success/30" />
            <div className="flex items-center gap-2 text-sm font-medium">
              {STEP_LABEL[t.node as keyof typeof STEP_LABEL] ?? t.node}
              {t.latencyMs != null && <span className="text-xs font-normal text-muted-foreground tabular-nums">{formatMs(t.latencyMs)}</span>}
            </div>
            {t.summary && <p className="mt-0.5 text-xs text-muted-foreground">{t.summary}</p>}
          </li>
        </StaggerItem>
      ))}
    </ol>
  );
}

export interface ResultDetails {
  engineName: string;
  modelName: string;
  detectedLang: string | null;
  targetLang: string;
  latencyMs?: number | null;
  usage: Usage | null;
  width: number;
  height: number;
  recordId?: number;
}

/** 结果右侧面板：文本（逐块原文 / 译文，可行内编辑）/ 术语 / 详情 */
export function ResultPanel({
  blocks,
  termHits,
  trace,
  details,
  oneShot,
  selectedId,
  saves,
  readOnly,
  onSelect,
  onEdit,
  onCommit,
}: {
  blocks: ImageBlock[];
  termHits: ImageTermHit[];
  trace: ImageTraceItem[];
  details: ResultDetails;
  /** qwen-mt-image：没有逐块文本 */
  oneShot?: boolean;
  selectedId: number | null;
  saves?: Record<number, SaveState>;
  readOnly?: boolean;
  onSelect: (id: number) => void;
  onEdit?: (id: number, text: string) => void;
  onCommit?: (id: number, text: string, previous: string) => void;
}) {
  const [tab, setTab] = useState("text");
  const tokens = details.usage ? details.usage.promptTokens + details.usage.completionTokens : null;
  return (
    <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="flex min-h-0 flex-1 flex-col gap-0">
      <div className="px-4 pt-3">
        <TabsList className="w-full">
          <TabsTrigger value="text">
            文本
            {blocks.length > 0 && <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums">{blocks.length}</span>}
          </TabsTrigger>
          <TabsTrigger value="terms">
            术语
            {termHits.length > 0 && <span className="rounded-full bg-brand-soft px-1.5 text-[10px] text-brand tabular-nums">{termHits.length}</span>}
          </TabsTrigger>
          <TabsTrigger value="details">详情</TabsTrigger>
        </TabsList>
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <TabsContent value="text">
          {oneShot ? (
            <EmptyState
              compact
              icon={ScanTextIcon}
              title="整图译图，没有逐块文本"
              description="千问图片翻译直接返回保留版式的译图，可在左侧切换「译图 / 原图 / 对比」查看。"
            />
          ) : !blocks.length ? (
            <EmptyState compact icon={ImageOffIcon} title="未识别到文字" description="这张图片里没有识别到可翻译的文字，换一张更清晰的图片试试。" />
          ) : (
            <>
              {!readOnly && (
                <p className="mb-2 px-1 text-[11px] text-muted-foreground">点击文本块可在画布上定位；双击或点笔形图标编辑译文，回车保存，Esc 取消。</p>
              )}
              <ul className="space-y-1">
                {blocks.map((b, i) => (
                  <BlockRow
                    key={b.id}
                    b={b}
                    index={i}
                    selected={selectedId === b.id}
                    readOnly={readOnly}
                    save={saves?.[b.id]}
                    onSelect={() => onSelect(b.id)}
                    onEdit={(t) => onEdit?.(b.id, t)}
                    onCommit={(t, prev) => onCommit?.(b.id, t, prev)}
                  />
                ))}
              </ul>
            </>
          )}
        </TabsContent>
        <TabsContent value="terms">
          <TermHits hits={termHits} unsupported={oneShot} />
        </TabsContent>
        <TabsContent value="details">
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2">
              <Meta label="引擎">{details.engineName}</Meta>
              <Meta label="模型">{details.modelName}</Meta>
              <Meta label="识别语种">{details.detectedLang ? langName(details.detectedLang) : "—"}</Meta>
              <Meta label="目标语言">{langName(details.targetLang)}</Meta>
              <Meta label="耗时">
                <span className="inline-flex items-center gap-1 tabular-nums">
                  <TimerIcon className="size-3.5 text-muted-foreground" />
                  {formatMs(details.latencyMs)}
                </span>
              </Meta>
              <Meta label="Tokens">
                <span className="inline-flex items-center gap-1 tabular-nums">
                  <CoinsIcon className="size-3.5 text-muted-foreground" />
                  {tokens != null ? formatTokens(tokens) : "—"}
                </span>
              </Meta>
              <Meta label="图片尺寸">
                <span className="tabular-nums">
                  {details.width} × {details.height}
                </span>
              </Meta>
              <Meta label="记录">{details.recordId != null ? `#${details.recordId}` : "—"}</Meta>
            </div>
            {details.usage && (
              <p className="px-1 text-[11px] text-muted-foreground tabular-nums">
                输入 {details.usage.promptTokens} / 输出 {details.usage.completionTokens} tokens
              </p>
            )}
            {trace.length > 0 && (
              <div>
                <div className="mb-2 px-1 text-xs font-medium text-muted-foreground">步骤轨迹</div>
                <TraceList trace={trace} />
              </div>
            )}
          </div>
        </TabsContent>
      </div>
    </Tabs>
  );
}
