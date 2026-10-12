"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BookMarkedIcon,
  ChevronDownIcon,
  DownloadIcon,
  FileUpIcon,
  GlobeIcon,
  LockIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/feedback/confirm-dialog";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorState } from "@/components/feedback/error-state";
import { ListSkeleton } from "@/components/feedback/skeletons";
import { StaggerItem } from "@/components/motion/stagger";
import { SPRING_LAYOUT } from "@/components/motion/tokens";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useMediaQuery } from "@/hooks/use-media-query";
import { glossaryApi, type GlossaryVO } from "@/lib/api/glossaries";
import { saveBlob } from "@/lib/download";
import { toastError } from "@/lib/errors";
import { langName } from "@/lib/languages";
import { formatTime } from "@/lib/validators";
import { cn } from "@/lib/utils";
import { GlossaryFormSheet } from "./glossary-form-sheet";
import { ImportDialog } from "./import-dialog";
import { TermTable } from "./term-table";

function LangPair({ s, t, className }: { s: string; t: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground", className)}>
      {langName(s)}
      <ArrowRightIcon className="size-3" />
      {langName(t)}
    </span>
  );
}

function GlossaryCard({
  g,
  active,
  index,
  onSelect,
}: {
  g: GlossaryVO;
  active: boolean;
  index: number;
  onSelect: () => void;
}) {
  return (
    <StaggerItem index={index}>
      <button
        type="button"
        onClick={onSelect}
        aria-current={active}
        className={cn(
          "relative w-full rounded-xl border p-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          active ? "border-brand/40" : "bg-card hover:bg-muted/40",
        )}
      >
        {active && (
          <motion.span
            layoutId="glossary-active"
            className="absolute inset-0 rounded-xl bg-brand-soft ring-1 ring-brand/30"
            transition={SPRING_LAYOUT}
          />
        )}
        <span className="relative block">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{g.name}</span>
            {!g.editable && <LockIcon className="size-3 shrink-0 text-muted-foreground" aria-label="只读" />}
            <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{g.termCount} 条</span>
          </span>
          <span className="mt-2 flex flex-wrap items-center gap-1.5">
            <LangPair s={g.sourceLang} t={g.targetLang} />
            {g.domain && (
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{g.domain}</span>
            )}
          </span>
        </span>
      </button>
    </StaggerItem>
  );
}

function Group({
  title,
  icon: Icon,
  items,
  selectedId,
  onSelect,
  offset,
}: {
  title: string;
  icon: typeof LockIcon;
  items: GlossaryVO[];
  selectedId?: number;
  onSelect: (id: number) => void;
  offset: number;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-1 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        aria-expanded={open}
      >
        <ChevronDownIcon className={cn("size-3.5 transition-transform", !open && "-rotate-90")} />
        <Icon className="size-3.5" />
        {title}
        <span className="ml-auto tabular-nums">{items.length}</span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="space-y-1.5 pt-1 pb-3">
              {items.length ? (
                items.map((g, i) => (
                  <GlossaryCard key={g.id} g={g} index={offset + i} active={g.id === selectedId} onSelect={() => onSelect(g.id)} />
                ))
              ) : (
                <p className="px-2 py-2 text-xs text-muted-foreground">暂无</p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

/** 术语库：主从布局（左侧卡片分组 → 右侧术语表） */
export function GlossariesView() {
  const qc = useQueryClient();
  const [keyword, setKeyword] = useState("");
  const kw = useDebouncedValue(keyword.trim(), 300);
  const [picked, setPicked] = useState<number | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<GlossaryVO | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [toDelete, setToDelete] = useState<GlossaryVO | null>(null);
  const [exporting, setExporting] = useState(false);
  // 窄屏（<1024px）为主从切换：列表 → 详情（带返回），宽屏为左右分栏
  const wide = useMediaQuery("(min-width: 1024px)");
  const [detailOpen, setDetailOpen] = useState(false);
  const showList = wide || !detailOpen;
  const showDetail = wide || detailOpen;
  const pick = (id: number) => {
    setPicked(id);
    setDetailOpen(true);
  };

  const list = useQuery({
    queryKey: ["glossaries", "list", kw],
    queryFn: () => glossaryApi.page({ pageNum: 1, pageSize: 100, keyword: kw || undefined }),
  });
  const records = list.data?.records ?? [];
  const mine = records.filter((g) => g.scope === "PRIVATE");
  const pub = records.filter((g) => g.scope === "PUBLIC");
  // 未手动选择时默认选中第一个
  const selected = records.find((g) => g.id === picked) ?? records[0] ?? null;

  const remove = useMutation({
    mutationFn: (id: number) => glossaryApi.remove(id),
    onSuccess: () => {
      toast.success("术语库已删除");
      setToDelete(null);
      setPicked(null);
      setDetailOpen(false);
      void qc.invalidateQueries({ queryKey: ["glossaries"] });
    },
    onError: toastError,
  });

  const exportCsv = async (g: GlossaryVO) => {
    setExporting(true);
    try {
      const { blob, filename } = await glossaryApi.exportTerms(g.id);
      saveBlob(blob, filename ?? `${g.name}.csv`);
      toast.success("已导出 CSV");
    } catch (e) {
      toastError(e);
    } finally {
      setExporting(false);
    }
  };

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-360 flex-1 gap-4 p-3 md:p-5">
      {/* 主：术语库列表 */}
      {showList && (
        <aside className="flex w-full shrink-0 flex-col overflow-hidden rounded-xl border bg-card shadow-card lg:w-80">
          <div className="flex items-center gap-2 border-b p-3">
            <div className="relative flex-1">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="搜索术语库"
                className="h-8 pl-8"
              />
            </div>
            <Button size="sm" onClick={openCreate}>
              <PlusIcon />
              新建
            </Button>
          </div>
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-3">
            {list.isLoading ? (
              <ListSkeleton rows={4} />
            ) : list.isError ? (
              <ErrorState compact error={list.error} onRetry={() => list.refetch()} retrying={list.isFetching} />
            ) : !records.length ? (
              kw ? (
                <EmptyState compact icon={SearchIcon} title="没有匹配的术语库" />
              ) : (
                <EmptyState
                  icon={BookMarkedIcon}
                  title="还没有术语库"
                  description="建立术语库后，Agent 会在翻译时强制使用其中的译法。"
                  action={
                    <Button onClick={openCreate}>
                      <PlusIcon />
                      新建术语库
                    </Button>
                  }
                />
              )
            ) : (
              <>
                <Group title="我的术语库" icon={LockIcon} items={mine} selectedId={selected?.id} onSelect={pick} offset={0} />
                <Group title="公共术语库" icon={GlobeIcon} items={pub} selectedId={selected?.id} onSelect={pick} offset={mine.length} />
              </>
            )}
          </div>
        </aside>
      )}

      {/* 从：术语表 */}
      {showDetail && (
        <motion.section
          key={wide ? "split" : "detail"}
          initial={wide ? false : { opacity: 0, x: 24 }}
          animate={{ opacity: 1, x: 0 }}
          transition={SPRING_LAYOUT}
          className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card shadow-card"
        >
          {!wide && (
            <div className="flex h-11 shrink-0 items-center border-b px-2">
              <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setDetailOpen(false)}>
                <ArrowLeftIcon />
                全部术语库
              </Button>
            </div>
          )}
          {selected ? (
            <AnimatePresence mode="wait">
              <motion.div
                key={selected.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="flex min-h-0 flex-1 flex-col"
              >
                <header className="flex flex-wrap items-start gap-3 border-b px-4 py-4 sm:px-5">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
                    <BookMarkedIcon className="size-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h2 className="flex items-center gap-2 text-base font-semibold">
                      <span className="truncate">{selected.name}</span>
                      {selected.scope === "PUBLIC" ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-info-soft px-2 py-0.5 text-[11px] font-normal text-info">
                          <GlobeIcon className="size-3" />
                          公共
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-normal text-muted-foreground">
                          <LockIcon className="size-3" />
                          个人
                        </span>
                      )}
                    </h2>
                    <p className="mt-0.5 truncate text-sm text-muted-foreground">{selected.description || "暂无描述"}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <LangPair s={selected.sourceLang} t={selected.targetLang} />
                      {selected.domain && <span>领域：{selected.domain}</span>}
                      <span>· {selected.termCount} 条术语</span>
                      <span>· 创建者 {selected.ownerName}</span>
                      <span>· 更新于 {formatTime(selected.updatedAt)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {selected.editable && (
                      <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
                        <FileUpIcon />
                        导入
                      </Button>
                    )}
                    <Button variant="outline" size="sm" disabled={exporting} onClick={() => exportCsv(selected)}>
                      <DownloadIcon />
                      导出
                    </Button>
                    {selected.editable && (
                      <DropdownMenu>
                        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="更多操作" />}>
                          <MoreHorizontalIcon />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-36">
                          <DropdownMenuItem
                            onClick={() => {
                              setEditing(selected);
                              setFormOpen(true);
                            }}
                          >
                            <PencilIcon />
                            编辑信息
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onClick={() => setToDelete(selected)}>
                            <Trash2Icon />
                            删除术语库
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </header>
                <TermTable glossary={selected} onImport={() => setImportOpen(true)} />
              </motion.div>
            </AnimatePresence>
          ) : list.isLoading ? (
            <div className="p-6">
              <ListSkeleton rows={3} />
            </div>
          ) : (
            <EmptyState
              className="flex-1"
              icon={BookMarkedIcon}
              title="选择一个术语库"
              description="在左侧选择术语库以查看和编辑术语。"
            />
          )}
        </motion.section>
      )}

      <GlossaryFormSheet
        open={formOpen}
        onOpenChange={setFormOpen}
        editing={editing}
        onSaved={(g) => setPicked(g.id)}
      />
      {selected && <ImportDialog glossary={selected} open={importOpen} onOpenChange={setImportOpen} />}
      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="删除术语库"
        description={`确定删除「${toDelete?.name}」吗？其中的 ${toDelete?.termCount ?? 0} 条术语将一并不可用。`}
        confirmText="删除"
        pending={remove.isPending}
        onConfirm={() => toDelete && remove.mutate(toDelete.id)}
      />
    </div>
  );
}
