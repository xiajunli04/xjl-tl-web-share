"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { motion, useReducedMotion } from "motion/react";
import {
  AlertTriangleIcon,
  ArrowUpRightIcon,
  BookOpenCheckIcon,
  MoreHorizontalIcon,
  RotateCwIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StaggerItem } from "@/components/motion/stagger";
import { docApi, isTerminal, type DocEvent, type DocTaskSummaryVO } from "@/lib/api/documents";
import { isAbortError } from "@/lib/sse";
import { cn } from "@/lib/utils";
import { LangPair, ProgressBar, ProgressRing, StatusBadge, StrategyBadge } from "./bits";
import { STATUS_META, canCancel, canRetry, formatChars, phaseLabel, relativeTime } from "./meta";

/** 把事件合入列表项（只关心进度与状态） */
function applyLive(t: DocTaskSummaryVO, e: DocEvent): DocTaskSummaryVO {
  switch (e.event) {
    case "snapshot":
    case "completed": {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { summary, consistencyReport, stats, ...rest } = e.data;
      return { ...t, ...rest };
    }
    case "phase":
      return { ...t, status: e.data.status, phase: e.data.phase };
    case "parsed":
      return { ...t, progressTotal: e.data.progressTotal, detectedLang: e.data.detectedLang };
    case "awaiting_confirm":
      return { ...t, status: "AWAITING_CONFIRM", phase: "awaiting_confirm" };
    case "chunk_done":
      return {
        ...t,
        progressDone: Math.max(t.progressDone, e.data.progressDone),
        progressTotal: e.data.progressTotal || t.progressTotal,
      };
    case "failed":
      return { ...t, status: "FAILED", errorCode: e.data.code, errorMessage: e.data.message, retryable: e.data.retryable };
    case "cancelled":
      return { ...t, status: "CANCELLED" };
    default:
      return t;
  }
}

/** 运行中任务的实时进度：订阅事件流，终结后刷新列表 */
function useLiveTask(task: DocTaskSummaryVO, enabled: boolean) {
  const qc = useQueryClient();
  const key = `${task.id}:${enabled}`;
  const [live, setLive] = useState<{ key: string; value: DocTaskSummaryVO } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();
    let current = task;
    docApi
      .subscribe(task.id, {
        signal: ctrl.signal,
        isDone: () => isTerminal(current.status),
        onEvent: (e) => {
          current = applyLive(current, e);
          setLive({ key: `${task.id}:true`, value: current });
          if (isTerminal(current.status)) {
            ctrl.abort();
            void qc.invalidateQueries({ queryKey: ["doc-tasks"] });
          }
        },
      })
      .catch((err) => {
        if (!isAbortError(err)) void qc.invalidateQueries({ queryKey: ["doc-tasks"] });
      });
    return () => ctrl.abort();
    // 只在任务 id / 是否订阅变化时重建订阅
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, enabled, qc]);
  // 订阅期间以事件合成的值为准；服务端数据已终结或订阅关闭后以列表数据为准
  return live && live.key === key && !isTerminal(task.status) ? live.value : task;
}

export function TaskCard({
  task: initial,
  index,
  live,
  onCancel,
  onRetry,
  onDelete,
}: {
  task: DocTaskSummaryVO;
  index: number;
  live: boolean;
  onCancel: (t: DocTaskSummaryVO) => void;
  onRetry: (t: DocTaskSummaryVO) => void;
  onDelete: (t: DocTaskSummaryVO) => void;
}) {
  const t = useLiveTask(initial, live);
  const reduce = useReducedMotion();
  const meta = STATUS_META[t.status];
  const ratio = t.progressTotal ? t.progressDone / t.progressTotal : t.status === "COMPLETED" ? 1 : 0;
  const ringTone =
    t.status === "COMPLETED" ? "success" : t.status === "FAILED" ? "danger" : t.status === "CANCELLED" ? "muted" : meta.tone;
  const href = `/documents/${t.id}`;

  return (
    <StaggerItem index={index} layout={!reduce} className="h-full">
      <motion.div
        whileHover={reduce ? undefined : { y: -2 }}
        transition={{ type: "spring", stiffness: 400, damping: 30 }}
        className="group relative flex h-full flex-col rounded-xl border bg-card p-4 shadow-card transition-shadow hover:shadow-popover"
      >
        <Link href={href} className="absolute inset-0 z-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring/50" aria-label={`打开「${t.title}」`} />
        <div className="pointer-events-none relative flex items-start gap-3.5">
          <ProgressRing value={ratio} tone={ringTone} size={58} />
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-2">
              <h3 className="line-clamp-2 flex-1 text-sm leading-snug font-semibold break-all" title={t.title}>{t.title}</h3>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <LangPair source={t.sourceLang} target={t.targetLang} detected={t.detectedLang} />
              <StrategyBadge strategy={t.strategy} />
              <span className="text-[11px] text-muted-foreground">{formatChars(t.charCount)}</span>
            </div>
          </div>
          <div className="pointer-events-auto relative z-10 -mt-1 -mr-1">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="更多操作"
                    className="text-muted-foreground opacity-70 group-hover:opacity-100 aria-expanded:opacity-100"
                  />
                }
              >
                <MoreHorizontalIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuItem render={<Link href={href} />}>
                  <ArrowUpRightIcon />
                  打开工作区
                </DropdownMenuItem>
                {canCancel(t.status) && (
                  <DropdownMenuItem onClick={() => onCancel(t)}>
                    <SquareIcon />
                    取消任务
                  </DropdownMenuItem>
                )}
                {canRetry(t) && (
                  <DropdownMenuItem onClick={() => onRetry(t)}>
                    <RotateCwIcon />
                    继续执行
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => onDelete(t)}>
                  <Trash2Icon />
                  删除
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="pointer-events-none relative mt-4 flex items-center gap-2">
          <StatusBadge status={t.status} />
          <span className="truncate text-xs text-muted-foreground">{phaseLabel(t)}</span>
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {relativeTime(t.finishedAt ?? t.startedAt ?? t.createdAt)}
          </span>
        </div>

        <div className="pointer-events-none relative mt-3">
          {t.status === "FAILED" ? (
            <p className="flex items-center gap-1.5 truncate text-xs text-danger">
              <AlertTriangleIcon className="size-3.5 shrink-0" />
              <span className="truncate">
                {t.errorCode} · {t.errorMessage ?? "执行失败"}
              </span>
            </p>
          ) : t.status === "AWAITING_CONFIRM" ? (
            <p className="flex items-center gap-1.5 text-xs text-warning">
              <BookOpenCheckIcon className="size-3.5" />
              候选术语已就绪，进入工作区确认后继续翻译
            </p>
          ) : (
            <div className="flex items-center gap-2.5">
              <ProgressBar value={ratio} tone={ringTone} className="flex-1" />
              <span className={cn("shrink-0 text-[11px] text-muted-foreground tabular-nums")}>
                {t.progressTotal ? `${t.progressDone}/${t.progressTotal} 块` : "待解析"}
              </span>
            </div>
          )}
        </div>
      </motion.div>
    </StaggerItem>
  );
}
