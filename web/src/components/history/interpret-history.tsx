"use client";

import { useState } from "react";
import Link from "next/link";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  AudioLinesIcon,
  BotIcon,
  ClockIcon,
  EarIcon,
  GaugeIcon,
  MessagesSquareIcon,
  SearchIcon,
  StarIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Segmented } from "@/components/ui/segmented";
import { ConfirmDialog } from "@/components/feedback/confirm-dialog";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorState } from "@/components/feedback/error-state";
import { ListSkeleton } from "@/components/feedback/skeletons";
import { Pagination } from "@/components/layout/common";
import { DURATION, EASE_OUT, staggerDelay } from "@/components/motion";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import {
  INTERPRET_HISTORY_QUERY_KEY,
  INTERPRET_MODE_LABEL,
  formatDuration,
  interpretHistoryApi,
  type InterpretHistoryQuery,
  type InterpretMode,
  type InterpretSessionVO,
} from "@/lib/api/interpret-history";
import type { PageResult } from "@/lib/api/types";
import { toastError } from "@/lib/errors";
import { langName } from "@/lib/languages";
import { cn } from "@/lib/utils";
import { relativeTime } from "./history-view";
import { InterpretHistorySheet } from "./interpret-history-sheet";

export const MODE_STYLE: Record<InterpretMode, { icon: React.ComponentType<{ className?: string }>; cls: string }> = {
  LISTEN: { icon: EarIcon, cls: "bg-info-soft text-info ring-info/20" },
  CONVERSE: { icon: MessagesSquareIcon, cls: "bg-brand-soft text-brand ring-brand/20" },
  ROOM: { icon: UsersIcon, cls: "bg-success-soft text-success ring-success/20" },
  CHAT: { icon: BotIcon, cls: "bg-warning-soft text-warning ring-warning/20" },
};

const ENGINE_NAME: Record<string, string> = {
  cascade: "平台级联",
  "qwen-livetranslate": "千问同传",
  "doubao-ast": "豆包同传",
  "gemini-live-translate": "Gemini 同传",
  "openai-realtime": "OpenAI 同传",
};
export const engineName = (id: string) => ENGINE_NAME[id] ?? id;

type ModeFilter = "ALL" | InterpretMode;

function SessionCard({
  s,
  index,
  onOpen,
  onFavorite,
  onDelete,
}: {
  s: InterpretSessionVO;
  index: number;
  onOpen: () => void;
  onFavorite: () => void;
  onDelete: () => void;
}) {
  const reduce = useReducedMotion();
  const style = MODE_STYLE[s.mode];
  const langs = s.stats?.languages?.length ? s.stats.languages : s.languages;
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
        <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl ring-1", style.cls)}>
          <style.icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{s.title ?? INTERPRET_MODE_LABEL[s.mode]}</span>
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{INTERPRET_MODE_LABEL[s.mode]}</span>
            {s.status === "ACTIVE" && (
              <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-1.5 py-0.5 text-[11px] text-success">
                <span className="size-1.5 animate-breathe rounded-full bg-success text-success" />
                进行中
              </span>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {langs.map((l) => (
              <span key={l} className="rounded-md border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {langName(l)}
              </span>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
            <span className="inline-flex items-center gap-1">
              <ClockIcon className="size-3.5" />
              {formatDuration(s.durationMs)}
            </span>
            <span className="inline-flex items-center gap-1">
              <AudioLinesIcon className="size-3.5" />
              {s.stats?.utterances ?? 0} 句
            </span>
            {s.stats?.avgE2eMs != null && (
              <span className="inline-flex items-center gap-1">
                <GaugeIcon className="size-3.5" />
                平均 {(s.stats.avgE2eMs / 1000).toFixed(1)} s
              </span>
            )}
            {s.mode === "ROOM" && s.stats?.participants != null && (
              <span className="inline-flex items-center gap-1">
                <UsersIcon className="size-3.5" />
                {s.stats.participants} 人
              </span>
            )}
            <span>{engineName(s.engine)}</span>
            <span className="ml-auto">{relativeTime(s.startedAt)}</span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={s.favorite ? "取消收藏" : "收藏"}
            aria-pressed={s.favorite}
            onClick={(e) => {
              e.stopPropagation();
              onFavorite();
            }}
          >
            <motion.span
              key={String(s.favorite)}
              initial={{ scale: reduce ? 1 : 0.5 }}
              animate={{ scale: 1 }}
              transition={{ type: "spring", stiffness: 500, damping: 15 }}
              className="inline-flex"
            >
              <StarIcon className={cn(s.favorite ? "fill-warning text-warning" : "text-muted-foreground")} />
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

/** 同传会话历史：列表 + 模式筛选 + 侧滑详情（双语转写） */
export function InterpretHistory() {
  const qc = useQueryClient();
  const [keyword, setKeyword] = useState("");
  const kw = useDebouncedValue(keyword.trim(), 350);
  const [mode, setMode] = useState<ModeFilter>("ALL");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [pageNum, setPageNum] = useState(1);
  const [openId, setOpenId] = useState<number | null>(null);
  const [toDelete, setToDelete] = useState<number | null>(null);
  const pageSize = 10;

  const query: InterpretHistoryQuery = {
    pageNum,
    pageSize,
    keyword: kw || undefined,
    mode: mode === "ALL" ? undefined : mode,
    favorite: favoriteOnly || undefined,
  };
  const list = useQuery({
    queryKey: [...INTERPRET_HISTORY_QUERY_KEY, "list", query],
    queryFn: () => interpretHistoryApi.page(query),
    placeholderData: keepPreviousData,
  });

  const favorite = useMutation({
    mutationFn: (p: { id: number; favorite: boolean }) => interpretHistoryApi.favorite(p.id, p.favorite),
    onMutate: (p) => {
      qc.setQueriesData<PageResult<InterpretSessionVO>>({ queryKey: [...INTERPRET_HISTORY_QUERY_KEY, "list"] }, (old) =>
        old ? { ...old, records: old.records.map((r) => (r.id === p.id ? { ...r, favorite: p.favorite } : r)) } : old,
      );
      qc.setQueryData([...INTERPRET_HISTORY_QUERY_KEY, "detail", p.id], (old: object | undefined) => (old ? { ...old, favorite: p.favorite } : old));
    },
    onSuccess: (_d, p) => toast.success(p.favorite ? "已收藏" : "已取消收藏"),
    onError: (e) => {
      toastError(e);
      void qc.invalidateQueries({ queryKey: INTERPRET_HISTORY_QUERY_KEY });
    },
  });
  const remove = useMutation({
    mutationFn: (id: number) => interpretHistoryApi.remove(id),
    onSuccess: (_d, id) => {
      toast.success("会话记录已删除");
      qc.setQueriesData<PageResult<InterpretSessionVO>>({ queryKey: [...INTERPRET_HISTORY_QUERY_KEY, "list"] }, (old) =>
        old ? { ...old, total: old.total - 1, records: old.records.filter((r) => r.id !== id) } : old,
      );
      setToDelete(null);
      if (openId === id) setOpenId(null);
      setTimeout(() => void qc.invalidateQueries({ queryKey: [...INTERPRET_HISTORY_QUERY_KEY, "list"] }), 400);
    },
    onError: toastError,
  });

  const records = list.data?.records ?? [];
  const filtered = !!kw || mode !== "ALL" || favoriteOnly;

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
            placeholder="搜索标题或转写内容"
            className="h-9 pl-9"
          />
        </div>
        <Segmented<ModeFilter>
          ariaLabel="同传模式"
          value={mode}
          onChange={(v) => {
            setMode(v);
            setPageNum(1);
          }}
          options={[
            { value: "ALL", label: "全部" },
            { value: "LISTEN", label: "收听" },
            { value: "CONVERSE", label: "对话" },
            { value: "ROOM", label: "会议室" },
            { value: "CHAT", label: "AI 对话" },
          ]}
        />
        <label className="flex h-9 items-center gap-2 rounded-lg border px-3 text-sm">
          只看收藏
          <Switch
            checked={favoriteOnly}
            onCheckedChange={(c) => {
              setFavoriteOnly(c);
              setPageNum(1);
            }}
          />
        </label>
      </div>

      {list.isLoading ? (
        <ListSkeleton rows={4} />
      ) : list.isError ? (
        <div className="rounded-xl border bg-card shadow-card">
          <ErrorState error={list.error} onRetry={() => list.refetch()} retrying={list.isFetching} />
        </div>
      ) : !records.length ? (
        <div className="rounded-xl border bg-card shadow-card">
          {filtered ? (
            <EmptyState
              icon={SearchIcon}
              title="没有符合条件的同传记录"
              description="换个关键词，或清除筛选条件再试。"
              action={
                <Button
                  variant="outline"
                  onClick={() => {
                    setKeyword("");
                    setMode("ALL");
                    setFavoriteOnly(false);
                  }}
                >
                  清除筛选
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={AudioLinesIcon}
              title="还没有同传记录"
              description="在同声传译中完成一次收听、对话或会议，结束后双语转写会保存在这里。"
              action={
                <Button render={<Link href="/interpret" />}>
                  <AudioLinesIcon />
                  去同声传译
                </Button>
              }
            />
          )}
        </div>
      ) : (
        <>
          <ul className={cn("space-y-2 transition-opacity", list.isFetching && "opacity-70")}>
            <AnimatePresence initial={false} mode="popLayout">
              {records.map((s, i) => (
                <SessionCard
                  key={s.id}
                  s={s}
                  index={i}
                  onOpen={() => setOpenId(s.id)}
                  onFavorite={() => favorite.mutate({ id: s.id, favorite: !s.favorite })}
                  onDelete={() => setToDelete(s.id)}
                />
              ))}
            </AnimatePresence>
          </ul>
          <Pagination className="mt-4" pageNum={pageNum} pageSize={pageSize} total={list.data?.total ?? 0} onChange={setPageNum} />
        </>
      )}

      <InterpretHistorySheet
        id={openId}
        onOpenChange={(o) => !o && setOpenId(null)}
        onToggleFavorite={(id, fav) => favorite.mutate({ id, favorite: fav })}
        onDelete={(id) => setToDelete(id)}
      />
      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="删除同传记录"
        description="删除后该会话的转写将不再出现在历史中。"
        confirmText="删除"
        pending={remove.isPending}
        onConfirm={() => toDelete !== null && remove.mutate(toDelete)}
      />
    </>
  );
}
