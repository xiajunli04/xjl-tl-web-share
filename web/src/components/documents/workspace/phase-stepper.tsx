"use client";

import { motion, useReducedMotion } from "motion/react";
import { MinusIcon, SquareIcon, XIcon } from "lucide-react";
import { DURATION, EASE_OUT, SPRING_LAYOUT } from "@/components/motion/tokens";
import type { DocTaskVO } from "@/lib/api/documents";
import { cn } from "@/lib/utils";
import { PHASE_STEPS, stepIndexOf } from "../meta";

type StepState = "done" | "active" | "pending" | "skipped" | "failed" | "stopped";

function CheckMark() {
  const reduce = useReducedMotion();
  return (
    <svg viewBox="0 0 24 24" className="size-3.5" fill="none" aria-hidden>
      <motion.path
        d="M5 12.5l4.2 4.2L19 7"
        stroke="currentColor"
        strokeWidth={2.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: reduce ? 1 : 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: reduce ? 0 : 0.35, ease: EASE_OUT }}
      />
    </svg>
  );
}

/** 阶段步进条：当前阶段脉冲光环（layoutId 平滑移动）；完成时打勾并填充连接线 */
export function PhaseStepper({ task, className }: { task: DocTaskVO; className?: string }) {
  const current = stepIndexOf(task);
  const failed = task.status === "FAILED";
  const stopped = task.status === "CANCELLED" || task.status === "CANCELLING";
  const live = !failed && !stopped && task.status !== "COMPLETED";

  const stateOf = (i: number): StepState => {
    if (i === 2 && !task.confirmTerms && current > 2) return "skipped";
    if (i < current) return "done";
    if (i === current) return failed ? "failed" : stopped ? "stopped" : task.status === "COMPLETED" ? "done" : "active";
    if (task.status === "COMPLETED") return "done";
    return "pending";
  };

  return (
    <ol className={cn("flex min-w-0 items-center", className)} aria-label="执行阶段">
      {PHASE_STEPS.map((step, i) => {
        const st = stateOf(i);
        const filled = st === "done" || st === "skipped";
        return (
          <li key={step.key} className={cn("flex items-center", i < PHASE_STEPS.length - 1 && "flex-1")}>
            <div className="flex items-center gap-2">
              <span className="relative flex size-6 shrink-0 items-center justify-center">
                {st === "active" && live && (
                  <motion.span
                    layoutId="phase-halo"
                    transition={SPRING_LAYOUT}
                    className="absolute -inset-1 rounded-full ring-2 ring-brand/30"
                  >
                    <span className="absolute inset-0 animate-pulse-ring rounded-full bg-brand/30 motion-reduce:hidden" />
                  </motion.span>
                )}
                <span
                  className={cn(
                    "relative flex size-6 items-center justify-center rounded-full border text-[11px] font-semibold transition-colors duration-300",
                    st === "done" && "border-success/30 bg-success-soft text-success",
                    st === "active" && "border-transparent bg-brand-gradient text-brand-foreground shadow-brand",
                    st === "pending" && "border-dashed bg-background text-muted-foreground/70",
                    st === "skipped" && "bg-muted text-muted-foreground/70",
                    st === "failed" && "border-danger/40 bg-danger-soft text-danger",
                    st === "stopped" && "border-warning/40 bg-warning-soft text-warning",
                  )}
                >
                  {st === "done" ? (
                    <CheckMark />
                  ) : st === "skipped" ? (
                    <MinusIcon className="size-3" />
                  ) : st === "failed" ? (
                    <XIcon className="size-3.5" />
                  ) : st === "stopped" ? (
                    <SquareIcon className="size-2.5" />
                  ) : (
                    i + 1
                  )}
                </span>
              </span>
              <span
                className={cn(
                  "hidden text-xs whitespace-nowrap transition-colors lg:inline",
                  st === "active" ? "font-medium text-brand" : st === "pending" || st === "skipped" ? "text-muted-foreground" : "text-foreground",
                  st === "failed" && "text-danger",
                  st === "stopped" && "text-warning",
                )}
              >
                {step.label}
                {st === "skipped" && <span className="ml-1 text-[10px]">自动</span>}
              </span>
            </div>
            {i < PHASE_STEPS.length - 1 && (
              <span className="relative mx-2 h-0.5 min-w-3 flex-1 overflow-hidden rounded-full bg-border">
                <motion.span
                  className="absolute inset-0 origin-left rounded-full bg-linear-to-r from-success/80 to-brand/70"
                  initial={false}
                  animate={{ scaleX: filled && stateOf(i + 1) !== "pending" ? 1 : filled ? 0.5 : 0 }}
                  transition={{ duration: DURATION.number, ease: EASE_OUT }}
                />
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
