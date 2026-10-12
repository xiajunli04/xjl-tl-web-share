"use client";

import { MotionConfig } from "motion/react";

/**
 * reducedMotion="user"：系统开启"减少动效"时，motion 组件自动禁用位移 / 缩放 / 布局动画，
 * 只保留透明度与颜色过渡；各组件仍通过 useReducedMotion() 显式选择降级参数。
 */
export function MotionProvider({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
