"use client";

import { useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeftIcon,
  BookOpenCheckIcon,
  BrainCircuitIcon,
  CoinsIcon,
  FlaskConicalIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PanelRightOpenIcon,
  RotateCwIcon,
  SquareIcon,
  TimerIcon,
  WifiOffIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ConfirmDialog } from "@/components/feedback/confirm-dialog";
import { NumberTicker } from "@/components/motion/number-ticker";
import { useDocTaskSelector } from "@/hooks/use-doc-task";
import { useElapsed } from "@/hooks/use-elapsed";
import { docApi, type DocTaskVO } from "@/lib/api/documents";
import { TM_QUERY_KEY } from "@/lib/api/tm";
import { useQueryClient } from "@tanstack/react-query";
import { toastError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { LangPair, ProgressBar, StatusBadge, StrategyBadge } from "../bits";
import { canCancel, canRetry, formatDuration, presetLabel, presetOf } from "../meta";
import { useWorkspace } from "./context";
import { ExportMenu } from "./export-menu";
import { PhaseStepper } from "./phase-stepper";

function Elapsed({ task }: { task: DocTaskVO }) {
  const start = task.startedAt ? new Date(task.startedAt).getTime() : undefined;
  const end = task.finishedAt ? new Date(task.finishedAt).getTime() : undefined;
  const running = !task.finishedAt && !!task.startedAt && task.status !== "AWAITING_CONFIRM";
  const elapsed = useElapsed(start, end, running);
  return <span className="tabular-nums">{task.latencyMs && !running ? formatDuration(task.latencyMs) : start ? formatDuration(elapsed) : "-"}</span>;
}

/** 工作区顶栏：标题、语言对、策略、阶段步进条、分块进度、用量、导出与取消 / 继续 */
export function TopBar({ task, panelOpen, onTogglePanel }: { task: DocTaskVO; panelOpen: boolean; onTogglePanel: () => void }) {
  const ws = useWorkspace();
  const conn = useDocTaskSelector(ws.store, (s) => s.conn);
  const parsed = useDocTaskSelector(ws.store, (s) => !!s.segments?.length);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmMemory, setConfirmMemory] = useState(false);
  const [writing, setWriting] = useState(false);
  const qc = useQueryClient();
  // 将写入翻译记忆的段数：可翻译且已有译文
  const memoryCount = useDocTaskSelector(ws.store, (s) => s.segments?.filter((x) => x.translatable && !!x.target).length ?? 0);
  const [busy, setBusy] = useState(false);
  const preset = presetOf(task.options, task.strategy);
  const ratio = task.progressTotal ? task.progressDone / task.progressTotal : task.status === "COMPLETED" ? 1 : 0;
  const tokens = (task.promptTokens ?? 0) + (task.completionTokens ?? 0);
  const tone = task.status === "COMPLETED" ? "success" : task.status === "FAILED" ? "danger" : task.status === "CANCELLED" ? "muted" : "brand";

  const cancel = async () => {
    setBusy(true);
    try {
      await docApi.cancel(task.id);
      ws.store.getState().patchTask({ status: "CANCELLING" });
      setConfirmCancel(false);
      toast.success("正在取消任务…");
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const writeMemory = async () => {
    setWriting(true);
    try {
      const r = await docApi.writeMemory(task.id);
      setConfirmMemory(false);
      toast.success(`已写入 ${r?.written ?? memoryCount} 条翻译记忆`, { description: "之后翻译相似内容时会作为参考译法" });
      void qc.invalidateQueries({ queryKey: TM_QUERY_KEY });
    } catch (e) {
      toastError(e);
    } finally {
      setWriting(false);
    }
  };

  const retry = async () => {
    setBusy(true);
    try {
      await docApi.retry(task.id);
      ws.store.getState().patchTask({ status: "PENDING", errorCode: null, errorMessage: null, retryable: null, finishedAt: null });
      ws.store.getState().restart();
      toast.success("任务已继续，已完成的分块不会重复翻译");
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <header className="rounded-xl border bg-card shadow-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="返回任务中心" nativeButton={false} render={<Link href="/documents" />} />}>
            <ArrowLeftIcon />
          </TooltipTrigger>
          <TooltipContent>返回任务中心</TooltipContent>
        </Tooltip>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-base font-semibold tracking-tight">{task.title}</h1>
            <StatusBadge status={task.status} />
            <AnimatePresence>
              {conn === "reconnecting" && (
                <motion.span
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0 }}
                  className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 text-[11px] text-warning"
                >
                  <WifiOffIcon className="size-3" />
                  连接中断，正在重连
                </motion.span>
              )}
            </AnimatePresence>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <LangPair source={task.sourceLang} target={task.targetLang} detected={task.detectedLang} />
            <StrategyBadge strategy={task.strategy} />
            <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
              <FlaskConicalIcon className="size-3" />
              {presetLabel(preset, "自定义实验配置")}
            </span>
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground uppercase">{task.format}</span>
          </div>
        </div>

        <AnimatePresence>
          {task.status === "AWAITING_CONFIRM" && (
            <motion.button
              type="button"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              onClick={() => {
                ws.select(null);
                ws.setTab("terms");
                if (!panelOpen) onTogglePanel();
              }}
              className="inline-flex h-8 items-center gap-1.5 rounded-full bg-warning-soft px-3 text-xs font-medium text-warning ring-1 ring-warning/30"
            >
              <span className="size-1.5 animate-breathe rounded-full bg-warning motion-reduce:animate-none" />
              <BookOpenCheckIcon className="size-3.5" />
              待确认术语
            </motion.button>
          )}
        </AnimatePresence>

        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex items-center gap-1" />}>
              <CoinsIcon className="size-3.5" />
              <NumberTicker value={tokens} className="tabular-nums" />
            </TooltipTrigger>
            <TooltipContent>
              Token 用量：输入 {task.promptTokens ?? 0} · 输出 {task.completionTokens ?? 0}
            </TooltipContent>
          </Tooltip>
          <span className="hidden items-center gap-1 sm:inline-flex">
            <TimerIcon className="size-3.5" />
            <Elapsed task={task} />
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <ExportMenu id={task.id} title={task.title} targetLang={task.targetLang} disabled={!parsed} partial={task.status !== "COMPLETED"} />
          {canCancel(task.status) && (
            <Button variant="outline" size="sm" onClick={() => setConfirmCancel(true)} disabled={busy}>
              <SquareIcon />
              取消
            </Button>
          )}
          {task.status === "CANCELLING" && (
            <Button variant="outline" size="sm" disabled>
              <Loader2Icon className="animate-spin" />
              正在取消
            </Button>
          )}
          {canRetry(task) && (
            <Button size="sm" onClick={retry} disabled={busy}>
              {busy ? <Loader2Icon className="animate-spin" /> : <RotateCwIcon />}
              继续执行
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="更多操作" />}>
              <MoreHorizontalIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuGroup>
                <DropdownMenuLabel>更多</DropdownMenuLabel>
                <DropdownMenuItem
                  disabled={task.status !== "COMPLETED" || !memoryCount}
                  onClick={() => setConfirmMemory(true)}
                  className="items-start gap-2.5 py-2"
                >
                  <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-brand-soft text-brand">
                    <BrainCircuitIcon className="size-3.5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm">写入翻译记忆</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {task.status === "COMPLETED" ? "把全部译文存为之后翻译的参考" : "任务完成后可用"}
                    </span>
                  </span>
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant={panelOpen ? "secondary" : "ghost"}
                  size="icon-sm"
                  aria-label={panelOpen ? "收起侧栏" : "展开侧栏"}
                  aria-pressed={panelOpen}
                  onClick={onTogglePanel}
                />
              }
            >
              <PanelRightOpenIcon />
            </TooltipTrigger>
            <TooltipContent>{panelOpen ? "收起侧栏" : "展开侧栏"}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t px-4 py-2.5">
        <PhaseStepper task={task} className="min-w-[280px] flex-[2]" />
        <div className="flex min-w-[220px] flex-1 items-center gap-3">
          <span className="shrink-0 text-xs text-muted-foreground">分块</span>
          <ProgressBar value={ratio} tone={tone} className="flex-1" />
          <span className={cn("shrink-0 text-xs font-medium tabular-nums")}>
            <NumberTicker value={task.progressDone} />
            <span className="text-muted-foreground">/{task.progressTotal || "–"}</span>
          </span>
          <span className="w-10 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
            <NumberTicker value={Math.round(ratio * 100)} suffix="%" />
          </span>
        </div>
      </div>

      <ConfirmDialog
        open={confirmMemory}
        onOpenChange={setConfirmMemory}
        title="写入翻译记忆"
        description={
          <>
            将把本任务 <b className="font-semibold text-foreground tabular-nums">{memoryCount}</b> 个已有译文的段落写入你的翻译记忆；原文相同的条目会以本次译文覆盖。
          </>
        }
        confirmText={`写入 ${memoryCount} 段`}
        destructive={false}
        pending={writing}
        onConfirm={writeMemory}
      />
      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="取消任务"
        description="已完成的分块会保留；取消后可随时从断点继续执行。"
        confirmText="取消任务"
        pending={busy}
        onConfirm={cancel}
      />
    </header>
  );
}
