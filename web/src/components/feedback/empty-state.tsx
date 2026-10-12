"use client";

import type { LucideIcon } from "lucide-react";
import { FadeIn } from "@/components/motion/fade-in";
import { cn } from "@/lib/utils";

/** 抽象插画：叠放的卡片 + 品牌色图标徽记，颜色全部来自令牌 */
function Illustration({ icon: Icon }: { icon?: LucideIcon }) {
  return (
    <div className="relative mx-auto mb-5 h-24 w-32">
      <svg viewBox="0 0 128 96" className="absolute inset-0 h-full w-full" aria-hidden>
        <rect x="22" y="18" width="84" height="60" rx="12" className="fill-muted stroke-border" />
        <rect x="14" y="26" width="84" height="60" rx="12" className="fill-card stroke-border" />
        <rect x="26" y="42" width="44" height="6" rx="3" className="fill-muted-foreground/25" />
        <rect x="26" y="54" width="60" height="6" rx="3" className="fill-muted-foreground/15" />
        <rect x="26" y="66" width="32" height="6" rx="3" className="fill-muted-foreground/15" />
        <circle cx="104" cy="22" r="3" className="fill-brand/40" />
        <circle cx="114" cy="36" r="2" className="fill-brand/25" />
        <circle cx="8" cy="18" r="2" className="fill-brand/25" />
      </svg>
      {Icon && (
        <div className="absolute -right-1 bottom-0 flex size-10 items-center justify-center rounded-xl bg-brand-gradient text-brand-foreground shadow-brand">
          <Icon className="size-5" />
        </div>
      )}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  compact,
}: {
  icon?: LucideIcon;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <FadeIn
      className={cn(
        "flex flex-col items-center justify-center px-6 text-center",
        compact ? "py-8" : "py-14",
        className,
      )}
    >
      {!compact && <Illustration icon={icon} />}
      {compact && icon && (() => {
        const Icon = icon;
        return (
          <div className="mb-3 flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <Icon className="size-5" />
          </div>
        );
      })()}
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {description && (
        <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}
      {action && <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div>}
    </FadeIn>
  );
}
