"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  CheckIcon,
  CircleHelpIcon,
  LanguagesIcon,
  MinusIcon,
  RotateCcwIcon,
  RouteIcon,
  ScanSearchIcon,
  ShieldCheckIcon,
  WandSparklesIcon,
  type LucideIcon,
} from "lucide-react";
import { Caret } from "@/components/interpret/live-bits";
import { DURATION, EASE_OUT, SPRING_SHEET } from "@/components/motion/tokens";
import { STAGES, type StageKey, type TraceState } from "@/lib/landing/script";
import { cn } from "@/lib/utils";
import { NarrationButton } from "./narration-button";

const STAGE_META: Record<StageKey, { label: string; icon: LucideIcon }> = {
  analyze: { label: "分析", icon: ScanSearchIcon },
  plan: { label: "规划", icon: RouteIcon },
  translate: { label: "翻译", icon: LanguagesIcon },
  review: { label: "评审", icon: ShieldCheckIcon },
  refine: { label: "修正", icon: WandSparklesIcon },
};

/** "回放演示"角标：首页演示均为预录回放 */
export function ReplayBadge({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground", className)}>
      <span className="size-1 rounded-full bg-muted-foreground/60" />
      回放演示
    </span>
  );
}

/** 阶段芯片：pending 灰、active 品牌色脉冲、done 勾、skipped 横线 */
function StageChip({ k, status }: { k: StageKey; status: TraceState["stages"][StageKey] }) {
  const reduce = useReducedMotion();
  const meta = STAGE_META[k];
  const Icon = status === "done" ? CheckIcon : status === "skipped" ? MinusIcon : meta.icon;
  return (
    <motion.span
      animate={{ scale: status === "active" && !reduce ? 1.06 : 1 }}
      transition={{ type: "spring", stiffness: 420, damping: 24 }}
      className={cn(
        "relative inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors duration-300",
        status === "pending" && "border-dashed text-muted-foreground",
        status === "active" && "border-brand/40 bg-brand-soft text-brand",
        status === "done" && "border-success/30 bg-success-soft text-success",
        status === "skipped" && "text-muted-foreground",
      )}
    >
      {status === "active" && !reduce && <span className="absolute inset-0 animate-pulse-ring rounded-full bg-brand/20" />}
      <Icon className="relative size-3.5" />
      <span className="relative">{meta.label}</span>
    </motion.span>
  );
}

/**
 * Agent 轨迹卡：原文 → 五个阶段芯片 → 阶段说明 → 命中标签 → 流式译文；
 * 出现追问时从底部弹出选项卡，访客点选后由调用方切换到对应分支。
 */
export function TraceCard({
  source,
  sourceLabel = "原文",
  targetLabel = "译文",
  sourceNote,
  sourceAudio,
  targetAudio,
  state,
  done,
  onReplay,
  onAnswer,
  compact,
  className,
}: {
  source: string;
  sourceLabel?: string;
  targetLabel?: string;
  sourceNote?: string;
  sourceAudio?: string;
  targetAudio?: string;
  state: TraceState;
  done: boolean;
  onReplay?: () => void;
  onAnswer?: (index: number) => void;
  compact?: boolean;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const translating = state.stages.translate === "active";
  const lastNote = [...STAGES].reverse().find((k) => state.notes[k]);
  return (
    <div className={cn("relative overflow-hidden rounded-2xl border bg-card shadow-popover", className)}>
      <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-2.5">
        <span className="flex gap-1">
          <span className="size-2.5 rounded-full bg-danger/50" />
          <span className="size-2.5 rounded-full bg-warning/50" />
          <span className="size-2.5 rounded-full bg-success/50" />
        </span>
        <span className="ml-1 text-xs font-medium text-muted-foreground">翻译 Agent</span>
        <ReplayBadge className="ml-auto" />
        {onReplay && (
          <button
            type="button"
            onClick={onReplay}
            disabled={!done}
            aria-label="重播"
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-0"
          >
            <RotateCcwIcon className="size-3" />
            重播
          </button>
        )}
      </div>
      <div className={cn("space-y-4 p-4", !compact && "md:p-5")}>
        <div>
          <div className="mb-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
            <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{sourceLabel}</span>
            {sourceAudio && <NarrationButton key={sourceAudio} src={sourceAudio} label="听原文" />}
          </div>
          <p className="text-sm leading-relaxed whitespace-pre-line">{source}</p>
          {sourceNote && <p className="mt-2 text-xs text-muted-foreground">{sourceNote}</p>}
        </div>
        <div className="flex flex-wrap gap-1.5" aria-label="Agent 阶段">
          {STAGES.map((k) => (
            <StageChip key={k} k={k} status={state.stages[k]} />
          ))}
        </div>
        <div className="min-h-5 text-xs text-muted-foreground">
          <AnimatePresence mode="popLayout" initial={false}>
            {lastNote && (
              <motion.span
                key={lastNote + state.notes[lastNote]}
                initial={{ opacity: 0, y: reduce ? 0 : 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: reduce ? 0 : -6 }}
                transition={{ duration: DURATION.fast, ease: EASE_OUT }}
                className="inline-block"
              >
                <span className="font-medium text-foreground">{STAGE_META[lastNote].label}</span> · {state.notes[lastNote]}
              </motion.span>
            )}
          </AnimatePresence>
        </div>
        {state.chips.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <AnimatePresence initial={false}>
              {state.chips.map((c) => (
                <motion.span
                  key={c}
                  initial={{ opacity: 0, scale: reduce ? 1 : 0.85 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ type: "spring", stiffness: 420, damping: 26 }}
                  className="rounded-md bg-info-soft px-2 py-0.5 text-[11px] font-medium text-info"
                >
                  {c}
                </motion.span>
              ))}
            </AnimatePresence>
          </div>
        )}
        <div className="rounded-xl bg-brand-soft/50 px-3.5 py-3">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
            <span className="text-[11px] font-medium tracking-wide text-brand uppercase">{targetLabel}</span>
            {targetAudio && done && <NarrationButton key={targetAudio} src={targetAudio} label="听译文" />}
          </div>
          <p className={cn("min-h-6 leading-relaxed font-medium whitespace-pre-line", compact ? "text-sm" : "text-base")}>
            {state.output || <span className="text-sm font-normal text-muted-foreground">{state.question ? "等你确认后再翻译…" : "…"}</span>}
            {translating && <Caret />}
          </p>
        </div>
      </div>
      <AnimatePresence>
        {state.question && (
          <motion.div
            initial={{ y: reduce ? 0 : "100%", opacity: reduce ? 0 : 1 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: reduce ? 0 : "100%", opacity: 0 }}
            transition={reduce ? { duration: DURATION.fast } : SPRING_SHEET}
            className="absolute inset-x-0 bottom-0 border-t bg-card/95 p-4 shadow-popover backdrop-blur"
            role="dialog"
            aria-label="Agent 追问"
          >
            <div className="mb-3 flex items-center gap-2 text-sm font-medium">
              <CircleHelpIcon className="size-4 text-warning" />
              {state.question.prompt}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {state.question.options.map((o, i) => (
                <motion.button
                  key={o}
                  type="button"
                  whileHover={reduce ? undefined : { y: -2 }}
                  onClick={() => onAnswer?.(i)}
                  className="rounded-xl border bg-background px-3 py-2.5 text-left text-sm transition-colors outline-none hover:border-brand/40 hover:bg-brand-soft focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {o}
                </motion.button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
