"use client";

import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ChevronDownIcon,
  CoinsIcon,
  MinusIcon,
  SquareIcon,
  TimerIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { DURATION, EASE_OUT } from "@/components/motion/tokens";
import { cn } from "@/lib/utils";
import { formatMs, formatTokens, nodeMeta } from "./node-meta";

/** interrupted：clarify 节点中断，等待用户回答追问 */
export type TimelineStatus = "pending" | "running" | "completed" | "skipped" | "stopped" | "error" | "interrupted";

export interface TimelineItem {
  key: string;
  node: string;
  status: TimelineStatus;
  /** 覆盖节点名称与图标（文档任务的阶段时间线复用本组件） */
  label?: string;
  icon?: LucideIcon;
  summary?: string | null;
  latencyMs?: number | null;
  tokens?: number | null;
  /** 摘要下方的额外信息（路径 / 分数等） */
  extra?: React.ReactNode;
  /** 可展开的详情（历史回放中的 detail JSON） */
  detail?: React.ReactNode;
}

/** 完成时的对勾：路径描绘动画 */
function Check() {
  const reduce = useReducedMotion();
  return (
    <svg viewBox="0 0 24 24" className="size-3.5" fill="none" aria-hidden>
      <motion.path
        d="M5 12.5l4.2 4.2L19 7"
        stroke="currentColor"
        strokeWidth={2.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: reduce ? 1 : 0, opacity: reduce ? 0 : 1 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: reduce ? DURATION.fast : 0.35, ease: EASE_OUT }}
      />
    </svg>
  );
}

function Indicator({ status, node, icon }: { status: TimelineStatus; node: string; icon?: LucideIcon }) {
  const Icon = icon ?? nodeMeta(node).icon;
  return (
    <div className="relative flex size-7 shrink-0 items-center justify-center">
      {status === "running" && (
        <>
          <span className="absolute inset-0 animate-pulse-ring rounded-full bg-brand/40 motion-reduce:hidden" />
          <span className="absolute -inset-1 rounded-full ring-2 ring-brand/30" />
        </>
      )}
      {status === "interrupted" && (
        <span className="absolute -inset-1 animate-breathe rounded-full ring-2 ring-warning/40 motion-reduce:animate-none" />
      )}
      <motion.span
        layout="position"
        className={cn(
          "relative flex size-7 items-center justify-center rounded-full border transition-colors duration-150",
          status === "pending" && "border-dashed border-border bg-background text-muted-foreground/60",
          status === "running" && "border-transparent bg-brand-gradient text-brand-foreground shadow-brand",
          status === "completed" && "border-success/30 bg-success-soft text-success",
          status === "skipped" && "border-border bg-muted text-muted-foreground/70",
          status === "stopped" && "border-warning/40 bg-warning-soft text-warning",
          status === "error" && "border-danger/40 bg-danger-soft text-danger",
          status === "interrupted" && "border-warning/40 bg-warning-soft text-warning",
        )}
      >
        {status === "completed" ? (
          <Check />
        ) : status === "skipped" ? (
          <MinusIcon className="size-3.5" />
        ) : status === "stopped" ? (
          <SquareIcon className="size-3" />
        ) : status === "error" ? (
          <XIcon className="size-3.5" />
        ) : (
          <Icon className="size-3.5" />
        )}
      </motion.span>
    </div>
  );
}

/** 连接线：上一个节点结束（完成 / 跳过）后从上到下填充 */
function Connector({ filled }: { filled: boolean }) {
  return (
    <div className="absolute top-8 bottom-0 left-[13.5px] w-px overflow-hidden bg-border">
      <motion.div
        className="h-full w-full origin-top bg-linear-to-b from-success/70 to-brand/60"
        initial={false}
        animate={{ scaleY: filled ? 1 : 0 }}
        transition={{ duration: 0.4, ease: EASE_OUT }}
      />
    </div>
  );
}

function Row({ item, last, index }: { item: TimelineItem; last: boolean; index: number }) {
  const [open, setOpen] = useState(false);
  const base = nodeMeta(item.node);
  const meta = { ...base, label: item.label ?? base.label };
  const reduce = useReducedMotion();
  const done = item.status === "completed" || item.status === "skipped";
  const dim = item.status === "pending" || item.status === "skipped";

  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, x: reduce ? 0 : -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: DURATION.page, ease: EASE_OUT, delay: Math.min(index, 12) * 0.02 }}
      className="relative flex gap-3 pb-5 last:pb-0"
      data-status={item.status}
    >
      {!last && <Connector filled={done} />}
      <Indicator status={item.status} node={item.node} icon={item.icon} />
      <div className={cn("min-w-0 flex-1 pt-0.5", dim && "opacity-60")}>
        <div className="flex items-center gap-2">
          <span className={cn("text-sm font-medium", item.status === "running" && "text-brand")}>
            {meta.label}
          </span>
          <span className="font-mono text-[11px] text-muted-foreground">{item.node}</span>
          {item.status === "skipped" && (
            <span className="rounded bg-muted px-1.5 text-[11px] text-muted-foreground">跳过</span>
          )}
          {item.status === "stopped" && (
            <span className="rounded bg-warning-soft px-1.5 text-[11px] text-warning">已停止</span>
          )}
          {item.status === "interrupted" && (
            <span className="rounded bg-warning-soft px-1.5 text-[11px] text-warning">等待澄清</span>
          )}
          {(item.latencyMs || item.tokens) && item.status === "completed" ? (
            <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground tabular-nums">
              {item.latencyMs !== undefined && item.latencyMs !== null && (
                <span className="inline-flex items-center gap-0.5">
                  <TimerIcon className="size-3" />
                  {formatMs(item.latencyMs)}
                </span>
              )}
              {!!item.tokens && (
                <span className="inline-flex items-center gap-0.5">
                  <CoinsIcon className="size-3" />
                  {formatTokens(item.tokens)}
                </span>
              )}
            </span>
          ) : null}
        </div>
        <AnimatePresence initial={false} mode="wait">
          <motion.p
            key={item.summary ?? item.status}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: DURATION.fast }}
            className="mt-0.5 text-xs leading-relaxed text-muted-foreground"
          >
            {item.summary ||
              (item.status === "running" ? "执行中…" : item.status === "pending" ? meta.desc : "")}
          </motion.p>
        </AnimatePresence>
        {item.extra && <div className="mt-2">{item.extra}</div>}
        {item.detail && (
          <div className="mt-1.5">
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ChevronDownIcon className={cn("size-3 transition-transform", open && "rotate-180")} />
              {open ? "收起详情" : "查看详情"}
            </button>
            <AnimatePresence initial={false}>
              {open && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: DURATION.page, ease: EASE_OUT }}
                  className="overflow-hidden"
                >
                  <div className="mt-2">{item.detail}</div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
      </div>
    </motion.li>
  );
}

/** Agent 时间线：节点脉冲光环、连接线随进度填充、完成打勾、跳过置灰 */
export function AgentTimeline({ items, className }: { items: TimelineItem[]; className?: string }) {
  return (
    <ol className={cn("relative", className)} aria-label="Agent 执行时间线">
      {items.map((item, i) => (
        <Row key={item.key} item={item} index={i} last={i === items.length - 1} />
      ))}
    </ol>
  );
}
