"use client";

import { useEffect, useRef } from "react";
import { animate, useReducedMotion } from "motion/react";
import { DURATION, EASE_OUT } from "./tokens";

/** 数值变化：400ms 从旧值滚动到新值；减少动效时直接显示最终值 */
export function NumberTicker({
  value,
  decimals = 0,
  suffix = "",
  className,
}: {
  value: number;
  decimals?: number;
  suffix?: string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const from = useRef(0);
  const reduce = useReducedMotion();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const format = (n: number) => n.toFixed(decimals) + suffix;
    if (reduce) {
      el.textContent = format(value);
      from.current = value;
      return;
    }
    const controls = animate(from.current, value, {
      duration: DURATION.number,
      ease: EASE_OUT,
      onUpdate: (v) => {
        el.textContent = format(v);
      },
    });
    from.current = value;
    return () => controls.stop();
  }, [value, decimals, suffix, reduce]);

  return (
    <span ref={ref} className={className} style={{ fontVariantNumeric: "tabular-nums" }}>
      {(0).toFixed(decimals) + suffix}
    </span>
  );
}
