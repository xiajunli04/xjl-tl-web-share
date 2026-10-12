"use client";

import { motion, useReducedMotion } from "motion/react";
import { DURATION, EASE_OUT, FADE_ONLY, PAGE_OFFSET_Y } from "./tokens";
import { cn } from "@/lib/utils";

/** 路由切换：透明度 0→1，y 8px→0，220ms，缓动 [0.22,1,0.36,1] */
export function PageTransition({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      data-slot="page-transition"
      className={cn("flex min-h-0 flex-1 flex-col", className)}
      initial={{ opacity: 0, y: reduce ? 0 : PAGE_OFFSET_Y }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? FADE_ONLY : { duration: DURATION.page, ease: EASE_OUT }}
    >
      {children}
    </motion.div>
  );
}
