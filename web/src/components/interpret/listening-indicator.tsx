"use client";

import { useEffect } from "react";
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform, type MotionValue } from "motion/react";
import { MicIcon } from "lucide-react";
import { DURATION, EASE_OUT } from "@/components/motion";
import { isDisplayable, latestUserUtterance } from "@/lib/interpret/reducer";
import { cn } from "@/lib/utils";
import { useInterpretStore } from "@/stores/interpret-store";

/** 与麦克风光球的说话态一致（约 −40 dBFS） */
const SPEAKING_LEVEL = 0.42;
/** 一句刚定稿后电平仍在衰减：这段时间内不只凭电平显示"正在听"（避免闪一下） */
const SETTLE_MS = 1000;

/**
 * 本机是否应显示"正在听"：正在说话或有未定稿的语句，但这句还没有可显示的文字（有文字时由气泡本身显示进度）。
 */
export function useLocalListening(): boolean {
  return useInterpretStore((s) => {
    if (s.phase !== "live" || s.muted || s.gated || s.listenOnly) return false;
    const last = latestUserUtterance(s.live, s.join?.participantId);
    if (last && !last.sourceFinal) return !isDisplayable(last);
    if (last && Date.now() - last.updatedAt < SETTLE_MS) return false;
    return s.level > SPEAKING_LEVEL;
  });
}

/**
 * "正在听…"指示（improve-speech-endpointing-and-live-ux D9）：已开口但还没有可显示的文字时代替空白气泡出现在消息流底部。
 * mic=true 时声波条随本机电平起伏（store.subscribe 直接写 motion value，不触发重渲染）；会议室他人说话时为固定节奏。
 * 由调用方包在 AnimatePresence 中控制进出。
 */
export function ListeningIndicator({
  label = "正在听…",
  mic = true,
  align = "end",
  className,
}: {
  label?: string;
  mic?: boolean;
  align?: "start" | "end" | "center";
  className?: string;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      layout={reduce ? false : "position"}
      initial={{ opacity: 0, y: reduce ? 0 : 8, scale: reduce ? 1 : 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: reduce ? 1 : 0.96 }}
      transition={{ duration: DURATION.page, ease: EASE_OUT }}
      className={cn("flex", align === "end" ? "justify-end" : align === "center" ? "justify-center" : "justify-start", className)}
      role="status"
      aria-live="polite"
    >
      <span className="inline-flex h-8 items-center gap-2 rounded-full border bg-card/90 px-3 text-xs text-muted-foreground shadow-card backdrop-blur">
        <MicIcon className="size-3.5 text-brand" />
        {mic ? <MicBars /> : <PulseBars />}
        {label}
      </span>
    </motion.div>
  );
}

function MicBars() {
  const reduce = useReducedMotion();
  const level = useMotionValue(useInterpretStore.getState().level);
  const spring = useSpring(level, { stiffness: 380, damping: 26 });
  useEffect(() => useInterpretStore.subscribe((s) => level.set(s.level)), [level]);
  if (reduce) return <span className="h-2 w-6 rounded-full bg-brand/40" aria-hidden />;
  return (
    <span className="inline-flex h-3.5 items-center gap-0.5" aria-hidden>
      {[0.55, 1, 0.75, 0.9, 0.6].map((k, i) => (
        <Bar key={i} level={spring} k={k} />
      ))}
    </span>
  );
}

function Bar({ level, k }: { level: MotionValue<number>; k: number }) {
  const scaleY = useTransform(level, (v) => 0.25 + Math.min(1, v * 1.4) * 0.75 * k);
  return <motion.span style={{ scaleY }} className="h-3.5 w-0.5 rounded-full bg-brand" />;
}

function PulseBars() {
  const reduce = useReducedMotion();
  if (reduce) return <span className="h-2 w-5 rounded-full bg-success/40" aria-hidden />;
  return (
    <span className="inline-flex h-3.5 items-center gap-0.5" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <motion.span
          key={i}
          className="h-3.5 w-0.5 rounded-full bg-success"
          animate={{ scaleY: [0.3, 1, 0.45, 0.8, 0.3] }}
          transition={{ duration: 1, repeat: Infinity, ease: "easeInOut", delay: i * 0.12 }}
        />
      ))}
    </span>
  );
}
