"use client";

import { motion, useReducedMotion, type HTMLMotionProps } from "motion/react";
import { DURATION, EASE_OUT, FADE_ONLY } from "./tokens";

/** 通用淡入（可选轻微上移），减少动效时只保留透明度 */
export function FadeIn({
  delay = 0,
  y = 6,
  children,
  ...props
}: HTMLMotionProps<"div"> & { delay?: number; y?: number }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={{ opacity: 0, y: reduce ? 0 : y }}
      animate={{ opacity: 1, y: 0 }}
      transition={
        reduce ? { ...FADE_ONLY, delay } : { duration: DURATION.page, ease: EASE_OUT, delay }
      }
      {...props}
    >
      {children}
    </motion.div>
  );
}
