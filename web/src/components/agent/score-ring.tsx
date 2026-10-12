"use client";

import { motion, useReducedMotion } from "motion/react";
import { NumberTicker } from "@/components/motion/number-ticker";
import { DURATION, EASE_OUT } from "@/components/motion/tokens";
import { cn } from "@/lib/utils";

/** 评审分环形进度：描边与数字同步滚动（400ms） */
export function ScoreRing({
  score,
  passed,
  size = 56,
  className,
}: {
  /** null：评审输出无法解析，视为通过 */
  score: number | null;
  passed: boolean;
  size?: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  if (score === null) {
    return (
      <div
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full border-2 border-dashed border-muted-foreground/30 text-sm font-semibold text-muted-foreground",
          className,
        )}
        style={{ width: size, height: size }}
        title="评审输出无法解析，视为通过"
      >
        —
      </div>
    );
  }
  const r = 15.5;
  const c = 2 * Math.PI * r;
  return (
    <div className={cn("relative shrink-0", className)} style={{ width: size, height: size }}>
      <svg viewBox="0 0 36 36" className="size-full -rotate-90" aria-hidden>
        <circle cx="18" cy="18" r={r} className="fill-none stroke-muted" strokeWidth="3" />
        <motion.circle
          cx="18"
          cy="18"
          r={r}
          className={cn("fill-none", passed ? "stroke-success" : "stroke-warning")}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: reduce ? c * (1 - score / 100) : c }}
          animate={{ strokeDashoffset: c * (1 - score / 100) }}
          transition={{ duration: reduce ? 0 : DURATION.number * 1.5, ease: EASE_OUT }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <NumberTicker value={score} className="text-sm font-semibold" />
      </div>
    </div>
  );
}

/** 评分徽标（译文区底栏） */
export function ScoreBadge({ score, passed }: { score: number | null; passed: boolean }) {
  return (
    <motion.span
      layout
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-medium whitespace-nowrap ring-1",
        passed ? "bg-success-soft text-success ring-success/25" : "bg-warning-soft text-warning ring-warning/25",
      )}
    >
      评审
      {score === null ? (
        <span className="font-semibold">通过</span>
      ) : (
        <NumberTicker value={score} className="font-semibold" />
      )}
    </motion.span>
  );
}
