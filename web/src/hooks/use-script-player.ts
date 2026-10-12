"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useReducedMotion } from "motion/react";
import { duration, stateAt, type Step } from "@/lib/landing/script";

const noop = () => () => {};

export interface ScriptPlayer<S> {
  state: S;
  /** 已播放到的毫秒数 */
  time: number;
  done: boolean;
  playing: boolean;
  restart: () => void;
}

/**
 * 首页脚本播放器（add-ai-avatar-and-landing D8）：rAF 推进时间线。
 * - active=false（离开视口）时暂停，回到视口后继续
 * - autoplay=false 时等待 restart() 才开始
 * - reduced-motion：直接显示终态
 * - steps 变化（切换样例 / 分支）时从头播放
 */
export function useScriptPlayer<S>(
  steps: readonly Step<S>[],
  initial: S | (() => S),
  { active = true, autoplay = true }: { active?: boolean; autoplay?: boolean } = {},
): ScriptPlayer<S> {
  // reduced-motion 只在 hydration 之后生效：服务端与首次客户端渲染都从初始态开始，避免 hydration 不匹配
  const mounted = useSyncExternalStore(noop, () => true, () => false);
  const reduce = useReducedMotion() && mounted;
  const total = duration(steps);
  const [time, setTime] = useState(0);
  const [started, setStarted] = useState(autoplay);
  const [prevSteps, setPrevSteps] = useState(steps);
  const [base] = useState(initial);

  // 换脚本时从头开始（渲染期比较，避免 effect 中 setState）
  if (prevSteps !== steps) {
    setPrevSteps(steps);
    setTime(0);
    setStarted(true);
  }

  const shownTime = reduce ? total : time;
  const done = shownTime >= total;
  const playing = started && active && !done && !reduce;

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      setTime((t) => Math.min(total, t + dt));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, total]);

  const restart = useCallback(() => {
    setTime(0);
    setStarted(true);
  }, []);

  return { state: stateAt(steps, base, shownTime), time: shownTime, done, playing, restart };
}
