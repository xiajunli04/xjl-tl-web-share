"use client";

import { useState } from "react";
import Link from "next/link";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowRightIcon,
  FilterIcon,
  HistoryIcon,
  LanguagesIcon,
  MessagesSquareIcon,
  SearchIcon,
  StarIcon,
  TimerIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ConfirmDialog } from "@/components/feedback/confirm-dialog";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorState } from "@/components/feedback/error-state";
import { ListSkeleton } from "@/components/feedback/skeletons";
import { FilterChip, NativeSelect, Pagination } from "@/components/layout/common";
import { formatMs } from "@/components/agent/node-meta";
import { DURATION, EASE_OUT, staggerDelay } from "@/components/motion";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useLanguages } from "@/hooks/use-options";
import { historyApi, HISTORY_QUERY_KEY, type HistoryQuery, type TranslationSummaryVO } from "@/lib/api/history";
import type { PageResult } from "@/lib/api/types";
import { toastError } from "@/lib/errors";
import { langName, pathLabel } from "@/lib/languages";
import { formatTime, toIso } from "@/lib/validators";
import { cn } from "@/lib/utils";
import { HistoryDetailSheet } from "./history-detail-sheet";

interface Filters {
  sourceLang: string;
  targetLang: string;
  favorite: boolean;
  startTime: string;
  endTime: string;
}
const EMPTY: Filters = { sourceLang: "", targetLang: "", favorite: false, startTime: "", endTime: "" };

export function relativeTime(s: string) {
  const d = new Date(s).getTime();
  const diff = (Date.now() - d) / 1000;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return formatTime(s);
}

function FilterPopover({ value, onApply }: { value: Filters; onApply: (f: Filters) => void }) {
  const languages = useLanguages();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const count = Object.entries(value).filter(([, v]) => !!v).length;
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setDraft(value);
      }}
    >
      <PopoverTrigger render={<Button variant="outline" className="h-9" />}>
        <FilterIcon />
        筛选
        {count > 0 && (
          <span className="flex size-4.5 items-center justify-center rounded-full bg-brand-gradient text-[10px] font-semibold text-brand-foreground">
            {count}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-4 p-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="h-src" className="text-xs text-muted-foreground">源语言</Label>
            <NativeSelect id="h-src" className="h-9" value={draft.sourceLang} onChange={(e) => setDraft({ ...draft, sourceLang: e.target.value })}>
              <option value="">全部</option>
              {languages.map((l) => (
                <option key={l.code} value={l.code}>{l.name}</option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="h-tgt" className="text-xs text-muted-foreground">目标语言</Label>
            <NativeSelect id="h-tgt" className="h-9" value={draft.targetLang} onChange={(e) => setDraft({ ...draft, targetLang: e.target.value })}>
              <option value="">全部</option>
              {languages.map((l) => (
                <option key={l.code} value={l.code}>{l.name}</option>
              ))}
            </NativeSelect>
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label className="text-xs text-muted-foreground">时间范围</Label>
          <Input type="datetime-local" aria-label="开始时间" value={draft.startTime} onChange={(e) => setDraft({ ...draft, startTime: e.target.value })} />
          <Input type="datetime-local" aria-label="结束时间" value={draft.endTime} onChange={(e) => setDraft({ ...draft, endTime: e.target.value })} />
        </div>
        <label className="flex items-center justify-between text-sm">
          只看收藏
          <Switch checked={draft.favorite} onCheckedChange={(c) => setDraft({ ...draft, favorite: c })} />
        </label>
        <div className="flex justify-end gap-2 border-t pt-3">
          <Button variant="ghost" size="sm" onClick={() => setDraft(EMPTY)}>
            清空
          </Button>
          <Button
            size="sm"
            onClick={() => {
              onApply(draft);
              setOpen(false);
            }}
          >
            应用
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function HistoryRow({
  r,
  index,
  onOpen,
  onFavorite,
  onDelete,
}: {
  r: TranslationSummaryVO;
  index: number;
  onOpen: () => void;
  onFavorite: () => void;
  onDelete: () => void;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.li
      layout={reduce ? false : "position"}
      initial={{ opacity: 0, y: reduce ? 0 : 6 }}
      animate={{ opacity: 1, y: 0, transition: { duration: DURATION.page, ease: EASE_OUT, delay: staggerDelay(index) } }}
      exit={{ opacity: 0, x: reduce ? 0 : -16, transition: { duration: 0.2 } }}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onOpen()}
        className="group flex cursor-pointer items-start gap-4 rounded-xl border bg-card p-4 shadow-card transition-all outline-none hover:border-brand/30 hover:shadow-popover focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <div className="min-w-0 flex-1">
          <div className="grid gap-1 md:grid-cols-2 md:gap-6">
            <p className="line-clamp-2 text-sm text-foreground">{r.sourcePreview}</p>
            <p className="line-clamp-2 text-sm text-muted-foreground">{r.targetPreview}</p>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5">
              {langName(r.sourceLang)}
              <ArrowRightIcon className="size-3" />
              {langName(r.targetLang)}
            </span>
            <span
              className={cn(
                "rounded-md px-1.5 py-0.5",
                r.path === "standard"
                  ? "bg-brand-soft text-brand"
                  : r.path === "revise"
                    ? "bg-warning-soft text-warning"
                    : "bg-info-soft text-info",
              )}
            >
              {pathLabel(r.path)}
            </span>
            {r.sessionId != null && (
              <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5" title={r.reviseInstruction ? `修订要求：${r.reviseInstruction}` : undefined}>
                <MessagesSquareIcon className="size-3" />
                会话{r.revisionOf != null ? " · 修订" : ""}
                {r.clarification ? " · 追问" : ""}
              </span>
            )}
            {r.reviewScore !== null && (
              <span
                className={cn(
                  "rounded-md px-1.5 py-0.5 font-medium tabular-nums",
                  r.reviewScore >= 85 ? "bg-success-soft text-success" : "bg-warning-soft text-warning",
                )}
              >
                {r.reviewScore} 分
              </span>
            )}
            <span className="inline-flex items-center gap-1 tabular-nums">
              <TimerIcon className="size-3" />
              {formatMs(r.latencyMs)}
            </span>
            <span className="ml-auto">{relativeTime(r.createdAt)}</span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={r.favorite ? "取消收藏" : "收藏"}
            aria-pressed={r.favorite}
            onClick={(e) => {
              e.stopPropagation();
              onFavorite();
            }}
          >
            <motion.span
              key={String(r.favorite)}
              initial={{ scale: reduce ? 1 : 0.5 }}
              animate={{ scale: 1 }}
              transition={{ type: "spring", stiffness: 500, damping: 15 }}
              className="inline-flex"
            >
              <StarIcon className={cn(r.favorite ? "fill-warning text-warning" : "text-muted-foreground")} />
            </motion.span>
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="删除"
            className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            <Trash2Icon />
          </Button>
        </div>
      </div>
    </motion.li>
  );
}

/** 文本翻译历史：列表 + 筛选弹层 + 侧滑详情 */
export function TextHistory({ initialOpenId = null }: { initialOpenId?: number | null }) {
  const qc = useQueryClient();
  const [keyword, setKeyword] = useState("");
  const kw = useDebouncedValue(keyword.trim(), 350);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [pageNum, setPageNum] = useState(1);
  const [openId, setOpenId] = useState<number | null>(initialOpenId);
  const [toDelete, setToDelete] = useState<number | null>(null);
  const pageSize = 10;

  const query: HistoryQuery = {
    pageNum,
    pageSize,
    keyword: kw || undefined,
    sourceLang: filters.sourceLang || undefined,
    targetLang: filters.targetLang || undefined,
    favorite: filters.favorite || undefined,
    startTime: toIso(filters.startTime),
    endTime: toIso(filters.endTime),
  };
  const listKey = [...HISTORY_QUERY_KEY, "list", query];
  const list = useQuery({
    queryKey: listKey,
    queryFn: () => historyApi.page(query),
    placeholderData: keepPreviousData,
  });

  const favorite = useMutation({
    mutationFn: (p: { id: number; favorite: boolean }) => historyApi.favorite(p.id, p.favorite),
    onMutate: async (p) => {
      // 乐观更新：列表与详情同时切换
      qc.setQueriesData<PageResult<TranslationSummaryVO>>({ queryKey: [...HISTORY_QUERY_KEY, "list"] }, (old) =>
        old ? { ...old, records: old.records.map((r) => (r.id === p.id ? { ...r, favorite: p.favorite } : r)) } : old,
      );
      qc.setQueryData([...HISTORY_QUERY_KEY, "detail", p.id], (old: object | undefined) =>
        old ? { ...old, favorite: p.favorite } : old,
      );
    },
    onSuccess: (_d, p) => toast.success(p.favorite ? "已收藏" : "已取消收藏"),
    onError: (e) => {
      toastError(e);
      void qc.invalidateQueries({ queryKey: HISTORY_QUERY_KEY });
    },
    onSettled: () => {
      if (filters.favorite) void qc.invalidateQueries({ queryKey: [...HISTORY_QUERY_KEY, "list"] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: number) => historyApi.remove(id),
    onSuccess: (_d, id) => {
      toast.success("记录已删除");
      qc.setQueriesData<PageResult<TranslationSummaryVO>>({ queryKey: [...HISTORY_QUERY_KEY, "list"] }, (old) =>
        old ? { ...old, total: old.total - 1, records: old.records.filter((r) => r.id !== id) } : old,
      );
      setToDelete(null);
      if (openId === id) setOpenId(null);
      setTimeout(() => void qc.invalidateQueries({ queryKey: HISTORY_QUERY_KEY }), 400);
    },
    onError: toastError,
  });

  const chips: { key: keyof Filters; label: string }[] = [];
  if (filters.sourceLang) chips.push({ key: "sourceLang", label: `源：${langName(filters.sourceLang)}` });
  if (filters.targetLang) chips.push({ key: "targetLang", label: `目标：${langName(filters.targetLang)}` });
  if (filters.favorite) chips.push({ key: "favorite", label: "只看收藏" });
  if (filters.startTime) chips.push({ key: "startTime", label: `起：${formatTime(toIso(filters.startTime))}` });
  if (filters.endTime) chips.push({ key: "endTime", label: `止：${formatTime(toIso(filters.endTime))}` });
  const filtered = !!kw || chips.length > 0;
  const records = list.data?.records ?? [];

  return (
    <>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-60 flex-1 sm:max-w-sm">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={keyword}
            onChange={(e) => {
              setKeyword(e.target.value);
              setPageNum(1);
            }}
            placeholder="搜索原文或译文"
            className="h-9 pl-9"
          />
        </div>
        <FilterPopover
          value={filters}
          onApply={(f) => {
            setFilters(f);
            setPageNum(1);
          }}
        />
        <AnimatePresence>
          {chips.map((c) => (
            <FilterChip
              key={c.key}
              label={c.label}
              onRemove={() => setFilters({ ...filters, [c.key]: c.key === "favorite" ? false : "" })}
            />
          ))}
        </AnimatePresence>
      </div>

      {list.isLoading ? (
        <ListSkeleton rows={5} />
      ) : list.isError ? (
        <div className="rounded-xl border bg-card shadow-card">
          <ErrorState error={list.error} onRetry={() => list.refetch()} retrying={list.isFetching} />
        </div>
      ) : !records.length ? (
        <div className="rounded-xl border bg-card shadow-card">
          {filtered ? (
            <EmptyState
              icon={SearchIcon}
              title="没有符合条件的记录"
              description="换个关键词，或清除筛选条件再试。"
              action={
                <Button
                  variant="outline"
                  onClick={() => {
                    setKeyword("");
                    setFilters(EMPTY);
                  }}
                >
                  清除筛选
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={HistoryIcon}
              title="还没有翻译记录"
              description="在工作台完成一次翻译后，记录会出现在这里，并可回放 Agent 的每一步。"
              action={
                <Button render={<Link href="/translate" />}>
                  <LanguagesIcon />
                  去翻译
                </Button>
              }
            />
          )}
        </div>
      ) : (
        <>
          <ul className={cn("space-y-2 transition-opacity", list.isFetching && "opacity-70")}>
            <AnimatePresence initial={false} mode="popLayout">
              {records.map((r, i) => (
                <HistoryRow
                  key={r.id}
                  r={r}
                  index={i}
                  onOpen={() => setOpenId(r.id)}
                  onFavorite={() => favorite.mutate({ id: r.id, favorite: !r.favorite })}
                  onDelete={() => setToDelete(r.id)}
                />
              ))}
            </AnimatePresence>
          </ul>
          <Pagination
            className="mt-4"
            pageNum={pageNum}
            pageSize={pageSize}
            total={list.data?.total ?? 0}
            onChange={setPageNum}
          />
        </>
      )}

      <HistoryDetailSheet
        id={openId}
        onOpenChange={(o) => !o && setOpenId(null)}
        onToggleFavorite={(id, fav) => favorite.mutate({ id, favorite: fav })}
        onDelete={(id) => setToDelete(id)}
      />
      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="删除翻译记录"
        description="删除后该记录将不再出现在历史中。"
        confirmText="删除"
        pending={remove.isPending}
        onConfirm={() => toDelete !== null && remove.mutate(toDelete)}
      />
    </>
  );
}
