"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence } from "motion/react";
import { FileTextIcon, FileUpIcon, FlaskConicalIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { ConfirmDialog } from "@/components/feedback/confirm-dialog";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorState } from "@/components/feedback/error-state";
import { CardGridSkeleton } from "@/components/feedback/skeletons";
import { NumberTicker } from "@/components/motion/number-ticker";
import { StaggerList } from "@/components/motion/stagger";
import { PageContainer, PageHeader } from "@/components/layout/common";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { docApi, isTerminal, type DocTaskSummaryVO } from "@/lib/api/documents";
import { toastError } from "@/lib/errors";
import { MOCK_API } from "@/lib/mock/flags";
import { cn } from "@/lib/utils";
import { NewTaskDialog } from "./new-task-dialog";
import { STATUS_GROUPS, formatChars, type StatusGroup } from "./meta";
import { TaskCard } from "./task-card";

/** 同时打开实时订阅的卡片上限（其余运行中任务依靠轮询刷新） */
const LIVE_LIMIT = 4;

function Stat({ label, value, suffix, tone }: { label: string; value: number; suffix?: string; tone?: string }) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3 shadow-card">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn("mt-1 flex items-baseline gap-1 text-xl font-semibold", tone)}>
        <NumberTicker value={value} />
        {suffix && <span className="text-xs font-normal text-muted-foreground">{suffix}</span>}
      </div>
    </div>
  );
}

/** 文档翻译 · 任务中心 */
export function DocumentsView() {
  const qc = useQueryClient();
  const [group, setGroup] = useState<StatusGroup>("all");
  const [keyword, setKeyword] = useState("");
  const kw = useDebouncedValue(keyword.trim(), 300);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [toCancel, setToCancel] = useState<DocTaskSummaryVO | null>(null);
  const [toDelete, setToDelete] = useState<DocTaskSummaryVO | null>(null);

  // 状态分组在前端完成（一个分组对应多个状态），服务端只按标题关键词筛选
  const list = useQuery({
    queryKey: ["doc-tasks", "list", kw],
    queryFn: () => docApi.page({ pageNum: 1, pageSize: 100, keyword: kw || undefined }),
    refetchInterval: (q) =>
      q.state.data?.records.some((t) => !isTerminal(t.status) && t.status !== "AWAITING_CONFIRM") ? 8000 : false,
  });
  const records = useMemo(() => list.data?.records ?? [], [list.data]);
  const counts = useMemo(
    () => Object.fromEntries(STATUS_GROUPS.map((g) => [g.value, records.filter((t) => g.match(t.status)).length])),
    [records],
  );
  const filtered = records.filter((t) => STATUS_GROUPS.find((g) => g.value === group)!.match(t.status));
  const liveIds = new Set(
    records
      .filter((t) => !isTerminal(t.status) && t.status !== "AWAITING_CONFIRM")
      .slice(0, LIVE_LIMIT)
      .map((t) => t.id),
  );
  const charsDone = records.filter((t) => t.status === "COMPLETED").reduce((n, t) => n + t.charCount, 0);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["doc-tasks"] });
  const cancel = useMutation({
    mutationFn: (id: number) => docApi.cancel(id),
    onSuccess: () => {
      toast.success("已发送取消请求");
      setToCancel(null);
      void invalidate();
    },
    onError: toastError,
  });
  const retry = useMutation({
    mutationFn: (id: number) => docApi.retry(id),
    onSuccess: () => {
      toast.success("任务已继续，已完成的分块不会重复翻译");
      void invalidate();
    },
    onError: toastError,
  });
  const remove = useMutation({
    mutationFn: (id: number) => docApi.remove(id),
    onSuccess: () => {
      toast.success("任务已删除");
      setToDelete(null);
      void invalidate();
    },
    onError: toastError,
  });

  const hasFilter = !!kw || group !== "all";

  return (
    <PageContainer wide>
      <PageHeader
        icon={FileTextIcon}
        title="文档翻译"
        description="上传 Markdown 或纯文本，Agent 按篇章分块翻译，保持术语与专名全文一致"
        actions={
          <>
            {MOCK_API && (
              <span className="hidden items-center gap-1 rounded-full bg-warning-soft px-2 py-1 text-[11px] text-warning md:inline-flex">
                <FlaskConicalIcon className="size-3" />
                离线演示数据
              </span>
            )}
            <Button onClick={() => setDialogOpen(true)}>
              <PlusIcon />
              新建任务
            </Button>
          </>
        }
      />

      {records.length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="全部任务" value={records.length} />
          <Stat label="进行中" value={counts.active ?? 0} tone="text-brand" />
          <Stat label="待确认术语" value={counts.awaiting ?? 0} tone={counts.awaiting ? "text-warning" : undefined} />
          <Stat label="已完成字数" value={charsDone >= 10_000 ? Math.round(charsDone / 1000) / 10 : charsDone} suffix={charsDone >= 10_000 ? "万字" : "字"} tone="text-success" />
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border bg-card p-2 shadow-card">
        <div className="scrollbar-thin max-w-full overflow-x-auto">
          <Segmented<StatusGroup>
            ariaLabel="按状态筛选"
            size="sm"
            value={group}
            onChange={setGroup}
            options={STATUS_GROUPS.map((g) => ({
              value: g.value,
              label: (
                <>
                  {g.label}
                  {list.data && (
                    <span className="rounded-full bg-foreground/5 px-1.5 text-[10px] tabular-nums">{counts[g.value] ?? 0}</span>
                  )}
                </>
              ),
            }))}
          />
        </div>
        <div className="relative ml-auto w-full sm:w-64">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索任务标题"
            className="h-8 pr-8 pl-8"
            aria-label="搜索任务标题"
          />
          {keyword && (
            <button
              type="button"
              aria-label="清空搜索"
              onClick={() => setKeyword("")}
              className="absolute top-1/2 right-2 flex size-5 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <XIcon className="size-3" />
            </button>
          )}
        </div>
      </div>

      {list.isLoading ? (
        <CardGridSkeleton count={6} />
      ) : list.isError ? (
        <div className="rounded-xl border bg-card shadow-card">
          <ErrorState error={list.error} onRetry={() => list.refetch()} retrying={list.isFetching} />
        </div>
      ) : !filtered.length ? (
        <div className="rounded-xl border border-dashed bg-card/50">
          {hasFilter ? (
            <EmptyState
              compact
              icon={SearchIcon}
              title="没有符合条件的任务"
              description="换个关键词或状态试试"
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setKeyword("");
                    setGroup("all");
                  }}
                >
                  清除筛选
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={FileUpIcon}
              title="还没有文档任务"
              description={
                <>
                  支持 .md / .markdown / .txt，单篇不超过 5 万字符
                  <br />
                  Agent 先通读全文、抽取术语，再分块翻译并统一译法
                </>
              }
              action={
                <Button onClick={() => setDialogOpen(true)}>
                  <FileUpIcon />
                  上传第一篇文档
                </Button>
              }
            />
          )}
        </div>
      ) : (
        <StaggerList className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <AnimatePresence initial={false}>
            {filtered.map((t, i) => (
              <TaskCard
                key={t.id}
                task={t}
                index={i}
                live={liveIds.has(t.id)}
                onCancel={setToCancel}
                onRetry={(x) => retry.mutate(x.id)}
                onDelete={setToDelete}
              />
            ))}
          </AnimatePresence>
        </StaggerList>
      )}

      <NewTaskDialog open={dialogOpen} onOpenChange={setDialogOpen} />
      <ConfirmDialog
        open={!!toCancel}
        onOpenChange={(o) => !o && setToCancel(null)}
        title="取消任务"
        description={`确定取消「${toCancel?.title}」吗？已完成的分块会保留，之后可以继续执行。`}
        confirmText="取消任务"
        pending={cancel.isPending}
        onConfirm={() => toCancel && cancel.mutate(toCancel.id)}
      />
      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="删除任务"
        description={
          toDelete && !isTerminal(toDelete.status)
            ? `「${toDelete.title}」仍在执行，删除前会先取消。删除后不可恢复。`
            : `确定删除「${toDelete?.title}」吗？译文与一致性报告将一并删除（${formatChars(toDelete?.charCount ?? 0)}）。`
        }
        confirmText="删除"
        pending={remove.isPending}
        onConfirm={() => toDelete && remove.mutate(toDelete.id)}
      />
    </PageContainer>
  );
}
