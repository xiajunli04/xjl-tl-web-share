"use client";

import { useEffect } from "react";
import { AnimatePresence, motion, useMotionValue, useReducedMotion, useSpring, useTransform } from "motion/react";
import { ArrowDownIcon, MicIcon, MicOffIcon, PauseIcon, TimerIcon } from "lucide-react";
import { NumberTicker } from "@/components/motion/number-ticker";
import { DURATION, EASE_OUT } from "@/components/motion/tokens";
import { stageStatus, type StageStatus } from "@/lib/interpret/reducer";
import { cn } from "@/lib/utils";
import { useInterpretStore } from "@/stores/interpret-store";
import { STATUS_META, avatarTone, initials, langShort } from "./meta";

/**
 * 麦克风电平光球：随 RMS 电平缩放（spring），说话时外环扩散。
 * 电平通过 store.subscribe 直接写入 motion value，不触发 React 重渲染。
 * reduced-motion：改为静态电平条。
 */
export function LevelOrb({ size = "md", className }: { size?: "sm" | "md" | "lg"; className?: string }) {
  const reduce = useReducedMotion();
  const level = useMotionValue(useInterpretStore.getState().level);
  const spring = useSpring(level, { stiffness: 320, damping: 22, mass: 0.6 });
  const scale = useTransform(spring, (v) => 1 + v * 0.42);
  const glow = useTransform(spring, (v) => 0.25 + v * 0.75);
  const speaking = useInterpretStore((s) => s.level > 0.42 && !s.muted && !s.gated);
  const muted = useInterpretStore((s) => s.muted);
  const gated = useInterpretStore((s) => s.gated);

  useEffect(() => useInterpretStore.subscribe((s) => level.set(s.level)), [level]);

  const dim = size === "sm" ? "size-9" : size === "lg" ? "size-16" : "size-12";
  const Icon = muted ? MicOffIcon : gated ? PauseIcon : MicIcon;

  if (reduce) {
    return (
      <div className={cn("flex items-center gap-2", className)} aria-label="麦克风电平">
        <span className={cn("flex items-center justify-center rounded-full bg-brand-gradient text-brand-foreground", size === "sm" ? "size-8" : "size-10", (muted || gated) && "opacity-50")}>
          <Icon className="size-4" />
        </span>
        <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
          <motion.span className="block h-full origin-left rounded-full bg-brand" style={{ scaleX: level }} />
        </span>
      </div>
    );
  }

  return (
    <div className={cn("relative flex shrink-0 items-center justify-center", dim, className)} aria-label="麦克风电平">
      {speaking && (
        <>
          <span className="absolute inset-0 animate-pulse-ring rounded-full bg-brand/35" />
          <span className="absolute inset-0 animate-pulse-ring rounded-full bg-brand/20 [animation-delay:0.5s]" />
        </>
      )}
      <motion.span
        style={{ scale, opacity: glow }}
        className="absolute inset-0 rounded-full bg-brand-gradient blur-md"
        aria-hidden
      />
      <motion.span
        style={{ scale }}
        className={cn(
          "relative flex size-full items-center justify-center rounded-full bg-brand-gradient text-brand-foreground shadow-brand transition-opacity",
          (muted || gated) && "opacity-55",
        )}
      >
        <Icon className={size === "sm" ? "size-4" : "size-5"} />
      </motion.span>
    </div>
  );
}

/** 状态胶囊：聆听 / 识别 / 翻译 / 播报 / 已暂停 */
export function StatusPill({ lang, className }: { lang?: string | null; className?: string }) {
  const reduce = useReducedMotion();
  const status: StageStatus = useInterpretStore((s) =>
    stageStatus(s.live, { playing: s.playing, muted: s.muted, lang: lang ?? null }),
  );
  const meta = STATUS_META[status];
  return (
    <span className={cn("relative inline-flex h-7 min-w-18 items-center justify-center overflow-hidden rounded-full px-3 text-xs font-medium transition-colors", meta.tone, className)} aria-live="polite">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={status}
          initial={{ opacity: 0, y: reduce ? 0 : 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reduce ? 0 : -8 }}
          transition={{ duration: DURATION.fast, ease: EASE_OUT }}
          className="inline-flex items-center gap-1.5"
        >
          <span className={cn("size-1.5 rounded-full", meta.dot, status !== "paused" && "animate-breathe motion-safe-only")} />
          {meta.label}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/** 延迟胶囊：最近一句 e2e，如 "2.4 s" */
export function LatencyPill({ className }: { className?: string }) {
  const ms = useInterpretStore((s) => s.live.lastE2eMs);
  return (
    <span
      className={cn("inline-flex h-7 items-center gap-1.5 rounded-full border bg-card px-3 text-xs text-muted-foreground tabular-nums", className)}
      title="最近一句：说话结束 → 首段译音"
    >
      <TimerIcon className="size-3.5" />
      {ms === null ? <span>--</span> : <NumberTicker value={ms / 1000} decimals={1} suffix=" s" className="font-medium text-foreground" />}
    </span>
  );
}

/** 成员头像（会议室） */
export function Avatar({
  id,
  name,
  lang,
  speaking,
  size = "md",
  className,
}: {
  id: string;
  name: string;
  lang?: string;
  speaking?: boolean;
  size?: "sm" | "md";
  className?: string;
}) {
  const reduce = useReducedMotion();
  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      {speaking && !reduce && <span className="absolute inset-0 animate-pulse-ring rounded-full bg-success/40" />}
      <span
        className={cn(
          "relative flex items-center justify-center rounded-full font-semibold ring-2 ring-background transition-shadow",
          size === "sm" ? "size-7 text-[11px]" : "size-10 text-sm",
          avatarTone(id),
          speaking && "ring-success",
        )}
      >
        {initials(name)}
      </span>
      {lang && (
        <span className="absolute -right-1 -bottom-1 flex h-4 min-w-4 items-center justify-center rounded-full border bg-card px-1 text-[9px] font-semibold text-foreground shadow-card">
          {langShort(lang)}
        </span>
      )}
    </span>
  );
}

/** 流式文本末尾的光标 */
export function Caret() {
  return <span aria-hidden className="ml-0.5 inline-block h-[0.95em] w-[2px] translate-y-[2px] animate-caret rounded-full bg-brand" />;
}

/** "新消息"胶囊：用户上翻历史时有新语句到达（improve-speech-endpointing-and-live-ux D9），点击回到底部 */
export function NewMessagesPill({ count, onClick, className }: { count: number; onClick: () => void; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <AnimatePresence>
      {count > 0 && (
        <motion.button
          type="button"
          onClick={onClick}
          initial={{ opacity: 0, y: reduce ? 0 : 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reduce ? 0 : 8 }}
          transition={reduce ? { duration: DURATION.fast } : { type: "spring", stiffness: 460, damping: 30 }}
          className={cn(
            "absolute bottom-3 left-1/2 z-10 inline-flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border bg-card/95 px-3 text-xs font-medium shadow-card backdrop-blur transition-colors hover:bg-muted",
            className,
          )}
        >
          <ArrowDownIcon className="size-3.5 text-brand" />
          新消息 · <span className="tabular-nums">{count}</span>
        </motion.button>
      )}
    </AnimatePresence>
  );
}
