"use client";

import { motion, useReducedMotion, type HTMLMotionProps } from "motion/react";
import { DURATION, EASE_OUT, FADE_ONLY } from "@/components/motion/tokens";
import { cn } from "@/lib/utils";

/**
 * 进入视口时淡入并上移 12px（只触发一次）。
 * 初始位移用常量（服务端与客户端一致）；reduced-motion 下由全局 MotionConfig reducedMotion="user" 禁用位移，只保留透明度。
 */
export function Reveal({ delay = 0, className, children, ...props }: HTMLMotionProps<"div"> & { delay?: number }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={reduce ? { ...FADE_ONLY, delay } : { duration: DURATION.page, ease: EASE_OUT, delay }}
      className={className}
      {...props}
    >
      {children}
    </motion.div>
  );
}

/** 分区标题：眉标 + 标题 + 说明（标题不做从透明开始的动画，由外层 Reveal 控制） */
export function SectionHeading({
  eyebrow,
  title,
  desc,
  center,
  className,
}: {
  eyebrow: string;
  title: React.ReactNode;
  desc?: React.ReactNode;
  center?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("max-w-2xl", center && "mx-auto text-center", className)}>
      <div className="mb-3 inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs font-medium text-brand shadow-card">
        {eyebrow}
      </div>
      <h2 className="text-2xl font-semibold tracking-tight text-balance md:text-3xl">{title}</h2>
      {desc && <p className="mt-3 text-sm leading-relaxed text-muted-foreground text-pretty md:text-base">{desc}</p>}
    </div>
  );
}
