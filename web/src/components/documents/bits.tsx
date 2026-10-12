"use client";

import { useId } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ArrowRightIcon } from "lucide-react";
import { NumberTicker } from "@/components/motion/number-ticker";
import { DURATION, EASE_OUT } from "@/components/motion/tokens";
import type { DocStatus, DocStrategy } from "@/lib/api/documents";
import { langName } from "@/lib/languages";
import { cn } from "@/lib/utils";
import { STATUS_META, STRATEGY_META, toneDot, toneSoft, type Tone } from "./meta";

/** 状态徽标：运行中呼吸；状态变化时颜色平滑过渡 */
export function StatusBadge({ status, className }: { status: DocStatus; className?: string }) {
  const meta = STATUS_META[status];
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap ring-1 transition-colors duration-500",
        toneSoft(meta.tone),
        className,
      )}
      data-status={status}
    >
      <span
        className={cn(
          "size-1.5 rounded-full transition-colors duration-500",
          toneDot(meta.tone),
          meta.live && "animate-breathe motion-reduce:animate-none",
        )}
      />
      {meta.label}
    </span>
  );
}

export function LangPair({ source, target, detected, className }: { source: string; target: string; detected?: string | null; className?: string }) {
  const src = source === "auto" && detected ? detected : source;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground", className)}>
      {langName(src)}
      <ArrowRightIcon className="size-3" />
      {langName(target)}
    </span>
  );
}

export function StrategyBadge({ strategy, className }: { strategy: DocStrategy; className?: string }) {
  const meta = STRATEGY_META[strategy];
  const Icon = meta.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground", className)}>
      <Icon className="size-3" />
      {meta.label}
    </span>
  );
}

const RING_STROKE: Record<Tone, string> = {
  brand: "",
  success: "stroke-success",
  warning: "stroke-warning",
  danger: "stroke-danger",
  info: "stroke-info",
  muted: "stroke-muted-foreground/50",
};

/** 进度环：描边与百分比数字同步平滑过渡；品牌色时使用渐变描边 */
export function ProgressRing({
  value,
  tone = "brand",
  size = 56,
  stroke = 4,
  className,
  children,
}: {
  /** 0–1 */
  value: number;
  tone?: Tone;
  size?: number;
  stroke?: number;
  className?: string;
  children?: React.ReactNode;
}) {
  const id = useId();
  const reduce = useReducedMotion();
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const r = 18 - stroke / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className={cn("relative shrink-0", className)} style={{ width: size, height: size }}>
      <svg viewBox="0 0 36 36" className="size-full -rotate-90" aria-hidden>
        <defs>
          <linearGradient id={`ring-${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" style={{ stopColor: "var(--brand-from)" }} />
            <stop offset="1" style={{ stopColor: "var(--brand-to)" }} />
          </linearGradient>
        </defs>
        <circle cx="18" cy="18" r={r} className="fill-none stroke-muted" strokeWidth={stroke} />
        <motion.circle
          cx="18"
          cy="18"
          r={r}
          className={cn("fill-none transition-[stroke] duration-500", RING_STROKE[tone])}
          stroke={tone === "brand" ? `url(#ring-${id})` : undefined}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          initial={false}
          animate={{ strokeDashoffset: c * (1 - v) }}
          transition={reduce ? { duration: 0 } : { duration: DURATION.number * 1.5, ease: EASE_OUT }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        {children ?? <NumberTicker value={Math.round(v * 100)} suffix="%" className="text-xs font-semibold" />}
      </div>
    </div>
  );
}

/** 线性进度条（顶栏 / 卡片） */
export function ProgressBar({ value, tone = "brand", className }: { value: number; tone?: Tone; className?: string }) {
  const reduce = useReducedMotion();
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return (
    <div className={cn("relative h-1.5 overflow-hidden rounded-full bg-muted", className)}>
      <motion.div
        className={cn(
          "absolute inset-y-0 left-0 rounded-full transition-colors duration-500",
          tone === "brand" ? "bg-brand-gradient" : toneDot(tone),
        )}
        initial={false}
        animate={{ width: `${v * 100}%` }}
        transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 120, damping: 24 }}
      />
      {tone === "brand" && v > 0 && v < 1 && (
        <div className="absolute inset-0 overflow-hidden motion-reduce:hidden" aria-hidden>
          <div className="h-full w-1/3 animate-shimmer bg-linear-to-r from-transparent via-background/40 to-transparent" />
        </div>
      )}
    </div>
  );
}
