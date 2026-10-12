import type { Transition } from "motion/react";

/** 统一动效参数（design.md「动效规范」表） */
export const EASE_OUT: [number, number, number, number] = [0.22, 1, 0.36, 1];

export const DURATION = {
  /** 状态切换（徽标 / 开关） */
  fast: 0.15,
  /** 路由切换 */
  page: 0.22,
  /** 数值变化 */
  number: 0.4,
} as const;

/** 浮层 / 抽屉 */
export const SPRING_SHEET: Transition = { type: "spring", stiffness: 380, damping: 34 };

/** 指示条、分段控件滑块等布局动画 */
export const SPRING_LAYOUT: Transition = { type: "spring", stiffness: 500, damping: 40 };

/** 列表进场：每项间隔 40ms，最多 12 项参与错峰 */
export const STAGGER_STEP = 0.04;
export const STAGGER_MAX = 12;

export const PAGE_OFFSET_Y = 8;

/** 减少动效时统一使用的透明度过渡 */
export const FADE_ONLY: Transition = { duration: DURATION.fast, ease: "linear" };
