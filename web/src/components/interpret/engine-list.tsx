"use client";

import { motion, useReducedMotion } from "motion/react";
import { BadgeCheckIcon, CheckIcon, InfoIcon, KeyRoundIcon, CpuIcon, ZapIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/feedback/error-state";
import { DURATION, EASE_OUT, SPRING_LAYOUT, staggerDelay } from "@/components/motion";
import type { EngineInfo } from "@/lib/api/speech";
import { cn } from "@/lib/utils";
import { TESTED_ENGINES } from "./meta";

function Badge({ tone, icon: Icon, children }: { tone: string; icon?: typeof CheckIcon; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex h-5 items-center gap-1 rounded-full px-1.5 text-[10px] font-medium whitespace-nowrap", tone)}>
      {Icon && <Icon className="size-3" />}
      {children}
    </span>
  );
}

/** 引擎徽章：本地免密钥 / 已配置 / 需配置 / 已实测 / 端到端 */
export function EngineBadges({ engine }: { engine: EngineInfo }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {!engine.available ? (
        <Badge tone="bg-warning-soft text-warning" icon={KeyRoundIcon}>需配置</Badge>
      ) : engine.kind === "builtin" ? (
        <Badge tone="bg-success-soft text-success" icon={CpuIcon}>本地免密钥</Badge>
      ) : (
        <Badge tone="bg-info-soft text-info" icon={CheckIcon}>已配置</Badge>
      )}
      {TESTED_ENGINES.has(engine.id) && <Badge tone="bg-brand-soft text-brand" icon={BadgeCheckIcon}>已实测</Badge>}
      {engine.s2s && <Badge tone="bg-muted text-muted-foreground" icon={ZapIcon}>端到端</Badge>}
    </span>
  );
}

/** 引擎选择列表：显示厂商、语种数与徽章；不可用置灰并在悬停时说明原因 */
export function EngineList({
  engines,
  value,
  onChange,
  loading,
  error,
  onRetry,
}: {
  engines: EngineInfo[];
  value: string;
  onChange: (id: string) => void;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
}) {
  const reduce = useReducedMotion();
  if (loading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-16 rounded-xl" />
        ))}
      </div>
    );
  }
  if (error) return <ErrorState title="引擎列表加载失败" error={error} onRetry={onRetry} />;

  return (
    <div role="radiogroup" aria-label="同传引擎" className="space-y-2">
      {engines.map((e, i) => {
        const active = e.id === value;
        const row = (
          <motion.button
            type="button"
            role="radio"
            aria-checked={active}
            aria-disabled={!e.available}
            initial={{ opacity: 0, y: reduce ? 0 : 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: DURATION.page, ease: EASE_OUT, delay: staggerDelay(i) }}
            onClick={() => e.available && onChange(e.id)}
            className={cn(
              "relative flex w-full items-center gap-3 rounded-xl border bg-card px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
              e.available ? "hover:bg-muted/50" : "cursor-not-allowed opacity-55",
              active && "border-transparent",
            )}
          >
            {active && (
              <motion.span
                layoutId="engine-active"
                transition={SPRING_LAYOUT}
                className="absolute inset-0 rounded-xl bg-brand-soft ring-1 ring-brand/40"
              />
            )}
            <span
              className={cn(
                "relative flex size-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold",
                active ? "bg-brand-gradient text-brand-foreground shadow-brand" : "bg-muted text-muted-foreground",
              )}
            >
              {e.vendor.slice(0, 1)}
            </span>
            <span className="relative min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-medium">{e.name}</span>
                <EngineBadges engine={e} />
              </span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                {e.vendor} · {e.languages.length} 种语言
                {e.autoConverse ? " · 支持自动对话" : e.s2s ? " · 对话仅按键" : ""}
                {!e.available && e.reason && <span className="text-warning"> · {e.reason}</span>}
                {e.available && e.constraint && <span> · {e.constraint}</span>}
              </span>
            </span>
            <span
              className={cn(
                "relative flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors",
                active ? "border-transparent bg-brand-gradient text-brand-foreground" : "border-input",
              )}
            >
              {active && <CheckIcon className="size-3" />}
            </span>
          </motion.button>
        );
        if (e.available) return <div key={e.id}>{row}</div>;
        return (
          <Tooltip key={e.id}>
            <TooltipTrigger render={<div />}>{row}</TooltipTrigger>
            <TooltipContent className="max-w-64">
              <InfoIcon className="size-3.5" />
              {e.reason ?? "该引擎当前不可用"}，请联系管理员在「模型配置」中添加对应的实时同传配置
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
