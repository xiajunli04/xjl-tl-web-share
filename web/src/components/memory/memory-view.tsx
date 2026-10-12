"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useInfiniteQuery, useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowRightIcon,
  BrainCircuitIcon,
  ClockIcon,
  ExternalLinkIcon,
  FileTextIcon,
  LanguagesIcon,
  MousePointerClickIcon,
  SearchIcon,
  TargetIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/feedback/confirm-dialog";
import { CopyButton } from "@/components/feedback/copy-button";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorState } from "@/components/feedback/error-state";
import { NativeSelect } from "@/components/layout/common";
import { NumberTicker } from "@/components/motion/number-ticker";
import { DURATION, EASE_OUT } from "@/components/motion/tokens";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useLanguages } from "@/hooks/use-options";
import { TM_QUERY_KEY, tmApi, type TmEntry } from "@/lib/api/tm";
import type { PageResult } from "@/lib/api/types";
import { toastError } from "@/lib/errors";
import { langName } from "@/lib/languages";
import { originInfo } from "@/lib/tm-match";
import { formatTime } from "@/lib/validators";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 30;

function relative(iso: string | null | undefined) {
  if (!iso) return "从未";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86_400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86_400 * 30) return `${Math.floor(s / 86_400)} 天前`;
  return new Date(t).toLocaleDateString("zh-CN");
}

function OriginBadge({ origin }: { origin: string }) {
  const doc = origin === "document";
  const Icon = doc ? FileTextIcon : LanguagesIcon;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium",
        doc ? "bg-info-soft text-info" : "bg-brand-soft text-brand",
      )}
    >
      <Icon className="size-3" />
      {doc ? "文档" : "工作台"}
    </span>
  );
}

/** 列表行：删除时高度收起（收起完成后再从缓存移除） */
function Row({
  e,
  active,
  removing,
  onSelect,
  onRemoved,
}: {
  e: TmEntry;
  active: boolean;
  removing: boolean;
  onSelect: () => void;
  onRemoved: () => void;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={false}
      animate={removing ? { height: 0, opacity: 0 } : { height: "auto", opacity: 1 }}
      transition={{ duration: reduce ? DURATION.fast : DURATION.page, ease: EASE_OUT }}
      onAnimationComplete={() => removing && onRemoved()}
      className="overflow-hidden"
    >
      <div className="px-2 py-1">
        <button
          type="button"
          onClick={onSelect}
          aria-current={active ? "true" : undefined}
          className={cn(
            "relative w-full rounded-lg px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
            active ? "text-foreground" : "hover:bg-muted/60",
          )}
        >
          {active && (
            <motion.span
              layoutId="tm-active"
              className="absolute inset-0 rounded-lg bg-brand-soft ring-1 ring-brand/25"
              transition={{ type: "spring", stiffness: 500, damping: 40 }}
            />
          )}
          <span className="relative block">
            <span className="line-clamp-1 text-sm">{e.sourceText}</span>
            <span className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{e.targetText}</span>
            <span className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <OriginBadge origin={e.origin} />
              <span className="inline-flex items-center gap-0.5">
                {langName(e.sourceLang)}
                <ArrowRightIcon className="size-2.5" />
                {langName(e.targetLang)}
              </span>
              <span className="ml-auto inline-flex items-center gap-0.5 tabular-nums">
                <TargetIcon className="size-3" />
                {e.hitCount}
              </span>
            </span>
          </span>
        </button>
      </div>
    </motion.div>
  );
}

function Detail({ e, onDelete }: { e: TmEntry; onDelete: () => void }) {
  const origin = originInfo(e.origin, e.originRef);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b px-5">
        <OriginBadge origin={e.origin} />
        <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
          {langName(e.sourceLang)}
          <ArrowRightIcon className="size-3" />
          {langName(e.targetLang)}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">#{e.id}</span>
        <Button variant="ghost" size="sm" className="ml-auto text-destructive hover:text-destructive" onClick={onDelete}>
          <Trash2Icon />
          删除
        </Button>
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
        <section className="rounded-xl border bg-card shadow-card">
          <div className="flex items-center justify-between border-b px-4 py-2 text-xs text-muted-foreground">
            原文 · {langName(e.sourceLang)}
            <CopyButton text={e.sourceText} size="icon-xs" label="复制原文" />
          </div>
          <p className="px-4 py-3 text-sm leading-7 break-words whitespace-pre-wrap">{e.sourceText}</p>
        </section>
        <section className="rounded-xl border bg-card shadow-card">
          <div className="flex items-center justify-between border-b px-4 py-2 text-xs text-muted-foreground">
            译文 · {langName(e.targetLang)}
            <CopyButton text={e.targetText} size="icon-xs" label="复制译文" />
          </div>
          <p className="px-4 py-3 text-sm leading-7 break-words whitespace-pre-wrap">{e.targetText}</p>
        </section>
        <section className="grid grid-cols-2 gap-2">
          <div className="rounded-xl border bg-card p-3">
            <div className="text-[11px] text-muted-foreground">命中次数</div>
            <NumberTicker value={e.hitCount} className="mt-0.5 block text-2xl font-semibold tracking-tight" />
          </div>
          <div className="rounded-xl border bg-card p-3">
            <div className="text-[11px] text-muted-foreground">最近命中</div>
            <div className="mt-1.5 text-sm font-medium">{relative(e.lastHitAt)}</div>
            {e.lastHitAt && <div className="text-[11px] text-muted-foreground">{formatTime(e.lastHitAt)}</div>}
          </div>
        </section>
        <section className="rounded-xl border bg-card p-3">
          <div className="mb-2 text-[11px] text-muted-foreground">来源</div>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm">{origin.label}</span>
            {origin.href && (
              <Button variant="outline" size="sm" nativeButton={false} render={<Link href={origin.href} />}>
                <ExternalLinkIcon />
                {origin.kind === "document" ? "定位到段落" : "查看记录"}
              </Button>
            )}
          </div>
        </section>
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <ClockIcon className="size-3" />
          创建于 {formatTime(e.createdAt)} · 更新于 {formatTime(e.updatedAt)}
        </p>
      </div>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-1 p-2" aria-busy="true" aria-label="加载中">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="space-y-2 rounded-lg px-3 py-2.5">
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-3 w-3/5" />
          <Skeleton className="h-3 w-24" />
        </div>
      ))}
    </div>
  );
}

/** 翻译记忆页：主从布局（左：筛选 + 检索 + 虚拟列表；右：详情） */
export function MemoryView() {
  const qc = useQueryClient();
  const languages = useLanguages();
  const wide = useMediaQuery("(min-width: 1024px)");
  const [keyword, setKeyword] = useState("");
  const kw = useDebouncedValue(keyword.trim(), 300);
  const [sourceLang, setSourceLang] = useState("");
  const [targetLang, setTargetLang] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [toDelete, setToDelete] = useState<TmEntry | null>(null);
  const [removing, setRemoving] = useState<Set<number>>(() => new Set());
  const parentRef = useRef<HTMLDivElement>(null);

  const filters = { keyword: kw || undefined, sourceLang: sourceLang || undefined, targetLang: targetLang || undefined };
  const listKey = [...TM_QUERY_KEY, "list", filters] as const;
  const q = useInfiniteQuery({
    queryKey: listKey,
    queryFn: ({ pageParam }) => tmApi.page({ pageNum: pageParam, pageSize: PAGE_SIZE, ...filters }),
    initialPageParam: 1,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + (p.records?.length ?? 0), 0);
      return loaded < (last.total ?? 0) && (last.records?.length ?? 0) > 0 ? (last.pageNum ?? pages.length) + 1 : undefined;
    },
  });
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.records ?? []) ?? [], [q.data]);
  const total = q.data?.pages[0]?.total ?? 0;
  const selected = rows.find((r) => r.id === selectedId) ?? null;

  // React Compiler 不对 useVirtualizer 做记忆化（其返回值包含可变方法）
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 84,
    overscan: 6,
    getItemKey: (i) => rows[i]?.id ?? i,
  });
  const items = virtualizer.getVirtualItems();
  const lastIndex = items.at(-1)?.index ?? -1;

  // 滚动接近末尾时加载下一页
  useEffect(() => {
    if (lastIndex >= rows.length - 5 && q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
  }, [lastIndex, rows.length, q]);

  const remove = useMutation({
    mutationFn: (id: number) => tmApi.remove(id),
    onSuccess: (_d, id) => {
      toast.success("已从翻译记忆中删除");
      setToDelete(null);
      // 选中下一条，列表项高度收起后再从缓存移除
      const idx = rows.findIndex((r) => r.id === id);
      const next = rows[idx + 1] ?? rows[idx - 1] ?? null;
      setSelectedId(next ? next.id : null);
      if (!wide) setSheetOpen(false);
      setRemoving((s) => new Set(s).add(id));
    },
    onError: toastError,
  });

  const dropFromCache = (id: number) => {
    qc.setQueryData<InfiniteData<PageResult<TmEntry>>>(listKey, (old) =>
      old
        ? {
            ...old,
            pages: old.pages.map((p) => ({ ...p, total: Math.max(0, p.total - 1), records: p.records.filter((r) => r.id !== id) })),
          }
        : old,
    );
    setRemoving((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
  };

  const select = (id: number) => {
    setSelectedId(id);
    if (!wide) setSheetOpen(true);
  };

  const filtered = !!kw || !!sourceLang || !!targetLang;
  const clear = () => {
    setKeyword("");
    setSourceLang("");
    setTargetLang("");
  };

  const detail = (
    <AnimatePresence mode="wait" initial={false}>
      {selected ? (
        <motion.div
          key={selected.id}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: DURATION.fast }}
          className="h-full"
        >
          <Detail e={selected} onDelete={() => setToDelete(selected)} />
        </motion.div>
      ) : (
        <motion.div key="none" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex h-full items-center justify-center">
          <EmptyState
            compact
            icon={MousePointerClickIcon}
            title={rows.length ? "选择一条记忆查看详情" : "暂无详情"}
            description={rows.length ? "左侧列表支持按语言对筛选与关键词检索。" : undefined}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 md:p-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border bg-card text-brand shadow-card">
          <BrainCircuitIcon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            翻译记忆
            {q.data && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground tabular-nums">
                <NumberTicker value={total} /> 条
              </span>
            )}
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">你确认过的译文会作为参考，在之后翻译相似句子时自动检索</p>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 overflow-hidden rounded-xl border bg-card shadow-card lg:grid-cols-[minmax(320px,400px)_1fr] lg:divide-x">
        {/* 主：筛选 + 检索 + 虚拟列表 */}
        <div className="flex min-h-[60vh] flex-col lg:min-h-0">
          <div className="shrink-0 space-y-2 border-b p-3">
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="检索原文或译文"
                aria-label="检索翻译记忆"
                className="h-9 pr-8 pl-8"
              />
              {keyword && (
                <button
                  type="button"
                  aria-label="清除关键词"
                  onClick={() => setKeyword("")}
                  className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                >
                  <XIcon className="size-3.5" />
                </button>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <NativeSelect aria-label="源语言" className="h-8 min-w-0 flex-1" value={sourceLang} onChange={(e) => setSourceLang(e.target.value)}>
                <option value="">全部源语言</option>
                {languages.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.name}
                  </option>
                ))}
              </NativeSelect>
              <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <NativeSelect aria-label="目标语言" className="h-8 min-w-0 flex-1" value={targetLang} onChange={(e) => setTargetLang(e.target.value)}>
                <option value="">全部目标语言</option>
                {languages.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>

          {q.isLoading ? (
            <ListSkeleton />
          ) : q.isError ? (
            <ErrorState error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} />
          ) : !rows.length ? (
            filtered ? (
              <EmptyState
                compact
                icon={SearchIcon}
                title="没有符合条件的记忆"
                description="换个关键词，或清除语言对筛选再试。"
                action={
                  <Button variant="outline" size="sm" onClick={clear}>
                    清除筛选
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={BrainCircuitIcon}
                title="翻译记忆还是空的"
                description="在工作台点击「存入记忆」，或编辑文档段落后自动积累。"
                action={
                  <Button size="sm" nativeButton={false} render={<Link href="/translate" />}>
                    <LanguagesIcon />
                    去工作台
                  </Button>
                }
              />
            )
          ) : (
            <div
              ref={parentRef}
              className={cn("scrollbar-thin relative min-h-0 flex-1 overflow-y-auto py-1 transition-opacity", q.isFetching && !q.isFetchingNextPage && "opacity-70")}
            >
              <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                {items.map((vi) => {
                  const e = rows[vi.index];
                  if (!e) return null;
                  return (
                    <div
                      key={vi.key}
                      data-index={vi.index}
                      ref={virtualizer.measureElement}
                      className="absolute top-0 left-0 w-full"
                      style={{ transform: `translateY(${vi.start}px)` }}
                    >
                      <Row
                        e={e}
                        active={e.id === selectedId}
                        removing={removing.has(e.id)}
                        onSelect={() => select(e.id)}
                        onRemoved={() => dropFromCache(e.id)}
                      />
                    </div>
                  );
                })}
              </div>
              {q.isFetchingNextPage && (
                <div className="flex justify-center py-2 text-[11px] text-muted-foreground">加载更多…</div>
              )}
            </div>
          )}
        </div>

        {/* 从：详情（主从切换时交叉淡化） */}
        {wide && <div className="hidden min-h-0 bg-surface/40 lg:block">{detail}</div>}
      </div>

      {!wide && (
        <Sheet open={sheetOpen && !!selected} onOpenChange={setSheetOpen}>
          <SheetContent className="sm:max-w-lg">
            <SheetTitle className="sr-only">记忆详情</SheetTitle>
            {detail}
          </SheetContent>
        </Sheet>
      )}

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="删除记忆条目"
        description="删除后，之后的翻译将不再检索到这条译文。"
        confirmText="删除"
        pending={remove.isPending}
        onConfirm={() => toDelete && remove.mutate(toDelete.id)}
      />
    </div>
  );
}
