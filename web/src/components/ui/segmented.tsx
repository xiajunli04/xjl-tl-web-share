"use client";

import { useId } from "react";
import { motion } from "motion/react";
import { SPRING_LAYOUT } from "@/components/motion/tokens";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
  title?: string;
}

/** 分段控件：选中滑块使用布局动画（减少动效时由 MotionConfig 自动关闭位移） */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = "default",
  className,
  ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly SegmentedOption<T>[];
  size?: "sm" | "default";
  className?: string;
  ariaLabel?: string;
}) {
  const id = useId();
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        "relative inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5",
        size === "sm" ? "h-8" : "h-9",
        className,
      )}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cn(
              "relative flex h-full flex-1 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              size === "sm" && "px-2.5 text-xs",
              active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {active && (
              <motion.span
                layoutId={`seg-${id}`}
                className="absolute inset-0 rounded-md bg-background shadow-card ring-1 ring-foreground/5 dark:bg-input/50"
                transition={SPRING_LAYOUT}
              />
            )}
            <span className="relative flex items-center gap-1.5">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
