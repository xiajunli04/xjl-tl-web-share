"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import {
  BrainCircuitIcon,
  DatabaseIcon,
  PauseIcon,
  PlayIcon,
  RotateCwIcon,
  ServerCogIcon,
  ServerIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/feedback/error-state";
import { PageContainer, PageHeader } from "@/components/layout/common";
import { StaggerItem, StaggerList } from "@/components/motion/stagger";
import { DURATION } from "@/components/motion/tokens";
import { systemApi } from "@/lib/api/logs";
import type { ComponentName } from "@/lib/api/types";
import { cn } from "@/lib/utils";

const INTERVAL = 30_000;

const COMPONENTS: { name: ComponentName; label: string; desc: string; icon: LucideIcon }[] = [
  { name: "spring", label: "管理服务", desc: "Spring Boot", icon: ServerIcon },
  { name: "postgres", label: "数据库", desc: "PostgreSQL", icon: DatabaseIcon },
  { name: "redis", label: "缓存", desc: "Redis", icon: ZapIcon },
  { name: "ai-service", label: "AI 服务", desc: "Python · FastAPI", icon: BrainCircuitIcon },
];

/** 自动刷新倒计时环 */
function Countdown({ updatedAt, paused }: { updatedAt: number; paused: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [paused]);
  const left = Math.max(0, INTERVAL - (now - updatedAt));
  const r = 9;
  const c = 2 * Math.PI * r;
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
      <svg viewBox="0 0 24 24" className="size-5 -rotate-90" aria-hidden>
        <circle cx="12" cy="12" r={r} className="fill-none stroke-muted" strokeWidth="2.5" />
        <circle
          cx="12"
          cy="12"
          r={r}
          className="fill-none stroke-brand transition-[stroke-dashoffset] duration-300 ease-linear"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={paused ? c : c * (1 - left / INTERVAL)}
        />
      </svg>
      {paused ? "已暂停自动刷新" : `${Math.ceil(left / 1000)} 秒后刷新`}
    </span>
  );
}

/** 系统状态：状态卡片（呼吸灯）+ 自动刷新倒计时 */
export default function SystemStatusPage() {
  const [paused, setPaused] = useState(false);
  const q = useQuery({
    queryKey: ["system-status"],
    queryFn: systemApi.status,
    retry: false,
    refetchInterval: paused ? false : INTERVAL,
    refetchIntervalInBackground: false,
  });
  const upCount = q.data?.items.filter((i) => i.status === "UP").length ?? 0;

  return (
    <PageContainer>
      <PageHeader
        title="系统状态"
        description="各依赖组件的健康状况，每 30 秒自动检测一次"
        icon={ServerCogIcon}
        actions={
          <>
            {q.dataUpdatedAt > 0 && <Countdown updatedAt={q.dataUpdatedAt} paused={paused} />}
            <Button variant="ghost" size="icon-sm" aria-label={paused ? "继续自动刷新" : "暂停自动刷新"} onClick={() => setPaused((p) => !p)}>
              {paused ? <PlayIcon /> : <PauseIcon />}
            </Button>
            <Button variant="outline" disabled={q.isFetching} onClick={() => q.refetch()}>
              <RotateCwIcon className={cn(q.isFetching && "animate-spin")} />
              立即刷新
            </Button>
          </>
        }
      />

      {q.isError && !q.data ? (
        <div className="rounded-xl border bg-card shadow-card">
          <ErrorState error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} />
        </div>
      ) : (
        <>
          <div className="mb-4 flex items-center gap-3 rounded-xl border bg-card px-4 py-3 shadow-card">
            {q.isLoading ? (
              <Skeleton className="h-5 w-48" />
            ) : (
              <>
                <span
                  className={cn(
                    "size-2.5 animate-breathe rounded-full",
                    upCount === COMPONENTS.length ? "bg-success text-success" : "bg-warning text-warning",
                  )}
                />
                <AnimatePresence mode="wait">
                  <motion.span
                    key={upCount}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="text-sm"
                  >
                    {upCount === COMPONENTS.length
                      ? "所有组件运行正常"
                      : `${COMPONENTS.length - upCount} 个组件异常，请检查`}
                  </motion.span>
                </AnimatePresence>
                {q.dataUpdatedAt > 0 && (
                  <span className="ml-auto text-xs text-muted-foreground">
                    上次检测 {new Date(q.dataUpdatedAt).toLocaleTimeString("zh-CN", { hour12: false })}
                  </span>
                )}
              </>
            )}
          </div>
          <StaggerList className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {COMPONENTS.map((c, i) => {
              const item = q.data?.items.find((x) => x.name === c.name);
              const up = item?.status === "UP";
              const Icon = c.icon;
              return (
                <StaggerItem
                  key={c.name}
                  index={i}
                  className={cn(
                    "relative overflow-hidden rounded-xl border bg-card p-5 shadow-card transition-colors duration-500",
                    item && !up && "border-danger/40 bg-danger-soft",
                  )}
                >
                  <div className="flex items-start justify-between">
                    <span
                      className={cn(
                        "flex size-10 items-center justify-center rounded-xl transition-colors duration-500",
                        !item ? "bg-muted text-muted-foreground" : up ? "bg-success-soft text-success" : "bg-danger text-danger-foreground",
                      )}
                    >
                      <Icon className="size-5" />
                    </span>
                    {item ? (
                      <motion.span
                        layout
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold transition-colors duration-500",
                          up ? "bg-success-soft text-success" : "bg-danger-soft text-danger",
                        )}
                      >
                        <span className={cn("size-2 rounded-full", up ? "animate-breathe bg-success" : "bg-danger")} />
                        <AnimatePresence mode="wait" initial={false}>
                          <motion.span
                            key={item.status}
                            initial={{ opacity: 0, y: 4 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -4 }}
                            transition={{ duration: DURATION.fast }}
                          >
                            {item.status}
                          </motion.span>
                        </AnimatePresence>
                      </motion.span>
                    ) : (
                      <Skeleton className="h-6 w-14 rounded-full" />
                    )}
                  </div>
                  <div className="mt-4 text-sm font-semibold">{c.label}</div>
                  <div className="text-xs text-muted-foreground">{c.desc}</div>
                  <div className="mt-3 min-h-8 text-xs break-all text-muted-foreground">
                    {item ? item.detail || "—" : q.isLoading ? <Skeleton className="h-3 w-3/4" /> : "未知"}
                  </div>
                </StaggerItem>
              );
            })}
          </StaggerList>
        </>
      )}
    </PageContainer>
  );
}
