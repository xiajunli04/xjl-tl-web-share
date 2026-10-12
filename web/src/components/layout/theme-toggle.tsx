"use client";

import { useSyncExternalStore } from "react";
import { motion } from "motion/react";
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SPRING_LAYOUT } from "@/components/motion/tokens";
import { cn } from "@/lib/utils";

const OPTIONS = [
  { value: "light", label: "亮色", icon: SunIcon },
  { value: "dark", label: "暗色", icon: MoonIcon },
  { value: "system", label: "跟随系统", icon: MonitorIcon },
] as const;

const noop = () => () => {};

/** 切换主题时短暂开启全局颜色过渡 */
function withTransition(fn: () => void) {
  const root = document.documentElement;
  root.classList.add("theme-transition");
  fn();
  window.setTimeout(() => root.classList.remove("theme-transition"), 320);
}

/** 亮 / 暗 / 跟随系统 三段切换，选中态滑块使用布局动画 */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(noop, () => true, () => false);
  const current = mounted ? (theme ?? "system") : null;

  return (
    <div
      role="radiogroup"
      aria-label="主题"
      className={cn("relative flex items-center gap-0.5 rounded-full border bg-muted/60 p-0.5", className)}
    >
      {OPTIONS.map((o) => {
        const active = current === o.value;
        const Icon = o.icon;
        return (
          <Tooltip key={o.value}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={o.label}
                  onClick={() => withTransition(() => setTheme(o.value))}
                  className={cn(
                    "relative flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
                    active && "text-foreground",
                  )}
                />
              }
            >
              {active && (
                <motion.span
                  layoutId="theme-toggle-pill"
                  className="absolute inset-0 rounded-full bg-background shadow-card ring-1 ring-foreground/5"
                  transition={SPRING_LAYOUT}
                />
              )}
              <Icon className="relative size-3.5" />
            </TooltipTrigger>
            <TooltipContent side="bottom">{o.label}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
