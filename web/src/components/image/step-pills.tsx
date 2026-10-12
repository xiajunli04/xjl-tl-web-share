"use client";

import { Fragment } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { CheckIcon, ChevronRightIcon, Loader2Icon, XIcon } from "lucide-react";
import { formatMs } from "@/components/agent/node-meta";
import { DURATION, EASE_OUT } from "@/components/motion/tokens";
import { STEP_LABEL, stepsOf, type ImageRunState } from "@/lib/image-run";
import { cn } from "@/lib/utils";

/** 步骤胶囊：识别 → 术语 → 翻译 → 渲染（qwen-mt-image 只有翻译 → 渲染） */
export function StepPills({ run, className }: { run: ImageRunState; className?: string }) {
  const reduce = useReducedMotion();
  const steps = stepsOf(run.engine);
  return (
    <ol className={cn("flex flex-wrap items-center gap-1.5", className)} aria-label="处理步骤">
      {steps.map((n, i) => {
        const s = run.steps[n];
        const running = s.status === "running";
        const done = s.status === "done";
        const error = s.status === "error";
        return (
          <Fragment key={n}>
            {i > 0 && <ChevronRightIcon className="size-3.5 text-muted-foreground/50" aria-hidden />}
            <motion.li
              layout={!reduce}
              title={s.summary}
              className={cn(
                "relative inline-flex h-7 items-center gap-1.5 overflow-hidden rounded-full border px-2.5 text-xs font-medium transition-colors duration-300",
                running && "border-brand/40 bg-brand-soft text-brand",
                done && "border-success/30 bg-success-soft text-success",
                error && "border-danger/30 bg-danger-soft text-danger",
                (s.status === "pending" || s.status === "skipped") && "border-border bg-card text-muted-foreground",
              )}
            >
              {running && !reduce && (
                <span className="absolute inset-0 -translate-x-full animate-shimmer bg-linear-to-r from-transparent via-brand/15 to-transparent" />
              )}
              <span className="relative inline-flex size-3.5 items-center justify-center">
                <AnimatePresence mode="wait" initial={false}>
                  {running ? (
                    <motion.span key="run" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                      <Loader2Icon className="size-3.5 animate-spin" />
                    </motion.span>
                  ) : done ? (
                    <motion.span
                      key="done"
                      initial={{ opacity: 0, scale: reduce ? 1 : 0.4 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ type: "spring", stiffness: 500, damping: 20 }}
                    >
                      <CheckIcon className="size-3.5" />
                    </motion.span>
                  ) : error ? (
                    <XIcon className="size-3.5" />
                  ) : (
                    <span className="size-1.5 rounded-full bg-current opacity-50" />
                  )}
                </AnimatePresence>
              </span>
              <span className="relative">{STEP_LABEL[n]}</span>
              <AnimatePresence initial={false}>
                {done && s.latencyMs != null && (
                  <motion.span
                    initial={{ opacity: 0, width: 0 }}
                    animate={{ opacity: 1, width: "auto" }}
                    transition={{ duration: DURATION.page, ease: EASE_OUT }}
                    className="relative font-normal whitespace-nowrap tabular-nums opacity-70"
                  >
                    {formatMs(s.latencyMs)}
                  </motion.span>
                )}
              </AnimatePresence>
            </motion.li>
          </Fragment>
        );
      })}
    </ol>
  );
}
