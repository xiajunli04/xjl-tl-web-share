"use client";

import { useState } from "react";
import Link from "next/link";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowRightIcon, ImageIcon, ImageOffIcon, ScanTextIcon, SearchIcon, StarIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/feedback/confirm-dialog";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorState } from "@/components/feedback/error-state";
import { CardGridSkeleton } from "@/components/feedback/skeletons";
import { NativeSelect, Pagination } from "@/components/layout/common";
import { DURATION, EASE_OUT, staggerDelay } from "@/components/motion";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useLanguages } from "@/hooks/use-options";
import { IMAGE_QUERY_KEY, imageApi, type ImageQuery, type ImageTranslationItem } from "@/lib/api/image";
import type { PageResult } from "@/lib/api/types";
import { toastError } from "@/lib/errors";
import { langName } from "@/lib/languages";
import { cn } from "@/lib/utils";
import { relativeTime } from "./history-view";
import { ImageHistorySheet } from "./image-history-sheet";

export const ENGINE_LABEL: Record<string, string> = { vision: "视觉识别", "qwen-mt-image": "千问译图" };

/** 原图 blob URL（带 JWT 的 fetch；按记录缓存，供缩略图与详情查看器共用） */
export function useRecordImage(id: number | null, kind: "image" | "result-image" = "image", enabled = true) {
  return useQuery({
    queryKey: [...IMAGE_QUERY_KEY, kind, id],
    queryFn: async () => URL.createObjectURL(await (kind === "image" ? imageApi.image(id!) : imageApi.resultImage(id!))),
    enabled: id !== null && enabled,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: false,
  });
}

function Thumb({ id }: { id: number }) {
  const q = useRecordImage(id);
  if (q.isLoading) return <Skeleton className="size-full rounded-none" />;
  if (!q.data)
    return (
      <span className="flex size-full items-center justify-center text-muted-foreground">
        <ImageOffIcon className="size-6" />
      </span>
    );
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={q.data} alt="" className="size-full object-cover transition-transform duration-500 group-hover:scale-105" />;
}

function ImageCard({
  r,
  index,
  onOpen,
  onFavorite,
  onDelete,
}: {
  r: ImageTranslationItem;
  index: number;
  onOpen: () => void;
  onFavorite: () => void;
  onDelete: () => void;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.li
      layout={reduce ? false : "position"}
      initial={{ opacity: 0, y: reduce ? 0 : 8 }}
      animate={{ opacity: 1, y: 0, transition: { duration: DURATION.page, ease: EASE_OUT, delay: staggerDelay(index) } }}
      exit={{ opacity: 0, scale: reduce ? 1 : 0.96, transition: { duration: 0.2 } }}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onOpen()}
        className="group flex h-full cursor-pointer flex-col overflow-hidden rounded-xl border bg-card shadow-card transition-all outline-none hover:-translate-y-0.5 hover:border-brand/30 hover:shadow-popover focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:hover:translate-y-0"
      >
        <div className="relative h-40 overflow-hidden bg-muted">
          <Thumb id={r.id} />
          <span className="absolute top-2 left-2 inline-flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-0.5 text-[11px] text-white backdrop-blur-sm">
            <ScanTextIcon className="size-3" />
            {ENGINE_LABEL[r.engine] ?? r.engine}
          </span>
          <div className="absolute top-1.5 right-1.5 flex gap-1">
            <Button
              variant="secondary"
              size="icon-sm"
              aria-label={r.favorite ? "取消收藏" : "收藏"}
              aria-pressed={r.favorite}
              className="bg-background/80 backdrop-blur-sm"
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
              variant="secondary"
              size="icon-sm"
              aria-label="删除"
              className="bg-background/80 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
            >
              <Trash2Icon />
            </Button>
          </div>
        </div>
        <div className="flex flex-1 flex-col gap-2 p-3">
          <p className="line-clamp-2 min-h-10 text-sm">{r.preview ?? (
            <span className="text-muted-foreground">{r.hasResultImage ? "整图译文（保留原图版式）" : "未识别到文字"}</span>
          )}</p>
          <div className="mt-auto flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5">
              {r.detectedLang ? langName(r.detectedLang) : r.sourceLang === "auto" ? "自动" : langName(r.sourceLang)}
              <ArrowRightIcon className="size-3" />
              {langName(r.targetLang)}
            </span>
            {r.blockCount > 0 && <span>{r.blockCount} 块</span>}
            <span className="ml-auto">{relativeTime(r.createdAt)}</span>
          </div>
        </div>
      </div>
    </motion.li>
  );
}

/** 图片翻译历史：缩略图卡片网格 + 筛选 + 侧滑详情 */
export function ImageHistory() {
  const qc = useQueryClient();
  const languages = useLanguages();
  const [keyword, setKeyword] = useState("");
  const kw = useDebouncedValue(keyword.trim(), 350);
  const [targetLang, setTargetLang] = useState("");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [pageNum, setPageNum] = useState(1);
  const [openId, setOpenId] = useState<number | null>(null);
  const [toDelete, setToDelete] = useState<number | null>(null);
  const pageSize = 12;

  const query: ImageQuery = { pageNum, pageSize, keyword: kw || undefined, targetLang: targetLang || undefined, favorite: favoriteOnly || undefined };
  const list = useQuery({
    queryKey: [...IMAGE_QUERY_KEY, "list", query],
    queryFn: () => imageApi.page(query),
    placeholderData: keepPreviousData,
  });

  const favorite = useMutation({
    mutationFn: (p: { id: number; favorite: boolean }) => imageApi.favorite(p.id, p.favorite),
    onMutate: (p) => {
      qc.setQueriesData<PageResult<ImageTranslationItem>>({ queryKey: [...IMAGE_QUERY_KEY, "list"] }, (old) =>
        old ? { ...old, records: old.records.map((r) => (r.id === p.id ? { ...r, favorite: p.favorite } : r)) } : old,
      );
      qc.setQueryData([...IMAGE_QUERY_KEY, "detail", p.id], (old: object | undefined) => (old ? { ...old, favorite: p.favorite } : old));
    },
    onSuccess: (_d, p) => toast.success(p.favorite ? "已收藏" : "已取消收藏"),
    onError: (e) => {
      toastError(e);
      void qc.invalidateQueries({ queryKey: IMAGE_QUERY_KEY });
    },
  });
  const remove = useMutation({
    mutationFn: (id: number) => imageApi.remove(id),
    onSuccess: (_d, id) => {
      toast.success("记录已删除");
      qc.setQueriesData<PageResult<ImageTranslationItem>>({ queryKey: [...IMAGE_QUERY_KEY, "list"] }, (old) =>
        old ? { ...old, total: old.total - 1, records: old.records.filter((r) => r.id !== id) } : old,
      );
      setToDelete(null);
      if (openId === id) setOpenId(null);
      setTimeout(() => void qc.invalidateQueries({ queryKey: [...IMAGE_QUERY_KEY, "list"] }), 400);
    },
    onError: toastError,
  });

  const records = list.data?.records ?? [];
  const filtered = !!kw || !!targetLang || favoriteOnly;

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
            placeholder="搜索图中原文或译文"
            className="h-9 pl-9"
          />
        </div>
        <NativeSelect
          aria-label="目标语言"
          className="h-9 w-36"
          value={targetLang}
          onChange={(e) => {
            setTargetLang(e.target.value);
            setPageNum(1);
          }}
        >
          <option value="">全部目标语言</option>
          {languages.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name}
            </option>
          ))}
        </NativeSelect>
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
        <CardGridSkeleton count={6} />
      ) : list.isError ? (
        <div className="rounded-xl border bg-card shadow-card">
          <ErrorState error={list.error} onRetry={() => list.refetch()} retrying={list.isFetching} />
        </div>
      ) : !records.length ? (
        <div className="rounded-xl border bg-card shadow-card">
          {filtered ? (
            <EmptyState
              icon={SearchIcon}
              title="没有符合条件的图片记录"
              description="换个关键词，或清除筛选条件再试。"
              action={
                <Button
                  variant="outline"
                  onClick={() => {
                    setKeyword("");
                    setTargetLang("");
                    setFavoriteOnly(false);
                  }}
                >
                  清除筛选
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={ImageIcon}
              title="还没有图片翻译记录"
              description="上传、拍照或粘贴一张图片，译文会直接覆盖在原图上，记录会保存在这里。"
              action={
                <Button render={<Link href="/image" />}>
                  <ImageIcon />
                  去翻译图片
                </Button>
              }
            />
          )}
        </div>
      ) : (
        <>
          <ul className={cn("grid gap-3 transition-opacity sm:grid-cols-2 lg:grid-cols-3", list.isFetching && "opacity-70")}>
            <AnimatePresence initial={false} mode="popLayout">
              {records.map((r, i) => (
                <ImageCard
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
          <Pagination className="mt-4" pageNum={pageNum} pageSize={pageSize} total={list.data?.total ?? 0} onChange={setPageNum} />
        </>
      )}

      <ImageHistorySheet
        id={openId}
        onOpenChange={(o) => !o && setOpenId(null)}
        onToggleFavorite={(id, fav) => favorite.mutate({ id, favorite: fav })}
        onDelete={(id) => setToDelete(id)}
      />
      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="删除图片翻译记录"
        description="删除后记录不再出现在历史中，原图与结果图会在后台清理。"
        confirmText="删除"
        pending={remove.isPending}
        onConfirm={() => toDelete !== null && remove.mutate(toDelete)}
      />
    </>
  );
}
