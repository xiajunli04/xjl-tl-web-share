"use client";

import { motion, useReducedMotion, type HTMLMotionProps, type Variants } from "motion/react";
import { DURATION, EASE_OUT, FADE_ONLY, STAGGER_MAX, STAGGER_STEP } from "./tokens";

/** 根据序号计算错峰延迟：每项 40ms，超过 12 项不再增加 */
export function staggerDelay(index: number) {
  return Math.min(index, STAGGER_MAX) * STAGGER_STEP;
}

function useItemVariants(): Variants {
  const reduce = useReducedMotion();
  return {
    hidden: { opacity: 0, y: reduce ? 0 : 6 },
    show: (i: number) => ({
      opacity: 1,
      y: 0,
      transition: reduce
        ? { ...FADE_ONLY, delay: staggerDelay(i) }
        : { duration: DURATION.page, ease: EASE_OUT, delay: staggerDelay(i) },
    }),
    exit: { opacity: 0, transition: { duration: DURATION.fast } },
  };
}

/** 列表容器 */
export function StaggerList({ children, ...props }: HTMLMotionProps<"div">) {
  return (
    <motion.div initial="hidden" animate="show" {...props}>
      {children}
    </motion.div>
  );
}

/** 列表项；index 用于计算错峰延迟（超过 12 项后不再递增） */
export function StaggerItem({
  index = 0,
  children,
  ...props
}: HTMLMotionProps<"div"> & { index?: number }) {
  const variants = useItemVariants();
  return (
    <motion.div
      variants={variants}
      custom={index}
      initial="hidden"
      animate="show"
      exit="exit"
      {...props}
    >
      {children}
    </motion.div>
  );
}

/** 表格行版本（tbody 内使用） */
export function StaggerRow({
  index = 0,
  children,
  ...props
}: HTMLMotionProps<"tr"> & { index?: number }) {
  const variants = useItemVariants();
  return (
    <motion.tr
      variants={variants}
      custom={index}
      initial="hidden"
      animate="show"
      exit="exit"
      {...props}
    >
      {children}
    </motion.tr>
  );
}
