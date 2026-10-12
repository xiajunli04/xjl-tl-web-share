"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangleIcon, ArrowLeftIcon, CircleStopIcon, RotateCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/feedback/error-state";
import { DURATION, EASE_OUT } from "@/components/motion/tokens";
import { useDocTask, useDocTaskSelector } from "@/hooks/use-doc-task";
import { useMediaQuery } from "@/hooks/use-media-query";
import type { DocStatus } from "@/lib/api/documents";
import { ApiError } from "@/lib/http";
import { WorkspaceContext, type SideTab, type WorkspaceCtx } from "./context";
import { SegmentList } from "./segment-list";
import { SidePanel, SidePanelBody } from "./side-panel";
import { TopBar } from "./top-bar";

function WorkspaceSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 md:p-5" aria-busy="true" aria-label="加载中">
      <div className="space-y-3 rounded-xl border bg-card p-4 shadow-card">
        <div className="flex items-center gap-3">
          <Skeleton className="size-7 rounded-lg" />
          <Skeleton className="h-5 w-64" />
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="ml-auto h-7 w-24" />
        </div>
        <Skeleton className="h-6 w-full" />
      </div>
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="flex-1 space-y-4 rounded-xl border bg-card p-5 shadow-card">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="grid grid-cols-2 gap-6">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          ))}
        </div>
        <div className="hidden w-96 space-y-3 rounded-xl border bg-card p-4 shadow-card xl:block">
          <Skeleton className="h-8" />
          <Skeleton className="h-28" />
          <Skeleton className="h-20" />
        </div>
      </div>
    </div>
  );
}

function StatusBanner({ status, code, message, retryable }: { status: DocStatus; code: string | null; message: string | null; retryable: boolean | null }) {
  const show = status === "FAILED" || status === "CANCELLED";
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          key={status}
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: DURATION.page, ease: EASE_OUT }}
          className="overflow-hidden"
        >
          {status === "FAILED" ? (
            <div role="alert" className="flex items-start gap-3 rounded-xl border border-danger/30 bg-danger-soft px-4 py-3">
              <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-danger" />
              <div className="min-w-0 flex-1 text-sm">
                <div className="font-medium text-danger">任务执行失败</div>
                <div className="mt-0.5 text-foreground/80">
                  {code && <span className="mr-2 rounded bg-background/60 px-1.5 py-px font-mono text-xs">{code}</span>}
                  {message ?? "未知错误"}
                </div>
              </div>
              <span className="hidden shrink-0 self-center text-xs text-muted-foreground md:inline">
                {retryable === false ? "该错误不可重试" : "点击右上角「继续执行」从断点恢复，已完成的分块不会重复调用模型"}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-3 rounded-xl border bg-muted/50 px-4 py-3 text-sm">
              <CircleStopIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="font-medium">任务已取消</span>
              <span className="text-muted-foreground">已完成的分块已保留，可随时继续执行</span>
              <RotateCwIcon className="ml-auto hidden size-3.5 text-muted-foreground md:block" />
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** 文档任务工作区：顶栏 + 双栏对照虚拟列表 + 可收起侧栏 */
export function DocWorkspace({ id, initialSeq = null }: { id: number; initialSeq?: number | null }) {
  const store = useDocTask(id);
  const task = useDocTaskSelector(store, (s) => s.task);
  const error = useDocTaskSelector(store, (s) => s.error);
  const wide = useMediaQuery("(min-width: 1280px)");

  const [selectedSeq, setSelectedSeq] = useState<number | null>(initialSeq);
  const [editingSeq, setEditingSeq] = useState<number | null>(null);
  const [flash, setFlash] = useState<{ seq: number; nonce: number } | null>(null);
  const [tab, setTab] = useState<SideTab>("overview");
  const [follow, setFollow] = useState(true);
  const [panelOpen, setPanelOpen] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);

  // 状态变化时调整侧栏：进入待确认 → 自动切到「术语」；确认后 → 回到「概览」
  const status = task?.status;
  const [prevStatus, setPrevStatus] = useState<DocStatus | undefined>(undefined);
  if (status !== prevStatus) {
    setPrevStatus(status);
    if (status === "AWAITING_CONFIRM") {
      setTab("terms");
      setSelectedSeq(null);
      setPanelOpen(true);
    } else if (prevStatus === "AWAITING_CONFIRM") {
      setTab("overview");
    } else if (status === "CONSISTENCY" && prevStatus === "TRANSLATING") {
      setTab("consistency");
    }
  }

  // ?seq= 跳转：段落加载后定位一次（关闭自动跟随，闪烁高亮）
  const segmentsReady = useDocTaskSelector(store, (s) => !!s.segments?.length);
  const [located, setLocated] = useState(initialSeq === null);
  if (!located && segmentsReady && initialSeq !== null) {
    setLocated(true);
    setFollow(false);
    setFlash({ seq: initialSeq, nonce: -1 });
  }

  const select = useCallback(
    (seq: number | null) => {
      setSelectedSeq(seq);
      if (seq !== null && !wide) setSheetOpen(true);
    },
    [wide],
  );
  const locate = useCallback((seq: number) => {
    setFollow(false);
    setFlash({ seq, nonce: Date.now() });
  }, []);

  const ctx = useMemo<WorkspaceCtx>(
    () => ({ id, store, selectedSeq, select, locate, flash, editingSeq, setEditingSeq, tab, setTab, follow, setFollow }),
    [id, store, selectedSeq, select, locate, flash, editingSeq, tab, follow],
  );

  if (!task) {
    if (error) {
      const notFound = error instanceof ApiError && error.code === "A0404";
      return (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="w-full max-w-md rounded-xl border bg-card shadow-card">
            <ErrorState
              error={error}
              title={notFound ? "任务不存在或已被删除" : "无法加载任务"}
              onRetry={notFound ? undefined : () => store.getState().restart()}
            />
            <div className="flex justify-center pb-6">
              <Button variant="outline" size="sm" nativeButton={false} render={<Link href="/documents" />}>
                <ArrowLeftIcon />
                返回任务中心
              </Button>
            </div>
          </div>
        </div>
      );
    }
    return <WorkspaceSkeleton />;
  }

  const awaitingWide = task.status === "AWAITING_CONFIRM" && tab === "terms";
  const togglePanel = () => (wide ? setPanelOpen((o) => !o) : setSheetOpen(true));

  return (
    <WorkspaceContext.Provider value={ctx}>
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 md:p-5">
        <TopBar task={task} panelOpen={wide ? panelOpen : sheetOpen} onTogglePanel={togglePanel} />
        <StatusBanner status={task.status} code={task.errorCode} message={task.errorMessage} retryable={task.retryable} />
        <div className="flex min-h-0 flex-1 gap-3">
          <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card shadow-card" aria-label="原文与译文对照">
            <SegmentList />
          </section>
          {wide ? (
            <SidePanel open={panelOpen} wide={awaitingWide}>
              <SidePanelBody task={task} onClose={() => setPanelOpen(false)} />
            </SidePanel>
          ) : (
            <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
              <SheetContent className="bg-surface sm:max-w-md">
                <SheetTitle className="sr-only">任务侧栏</SheetTitle>
                <SidePanelBody task={task} />
              </SheetContent>
            </Sheet>
          )}
        </div>
      </div>
    </WorkspaceContext.Provider>
  );
}
