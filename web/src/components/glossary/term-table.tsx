"use client";

import { useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import {
  CaseSensitiveIcon,
  CheckIcon,
  FileUpIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  TypeIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ConfirmDialog } from "@/components/feedback/confirm-dialog";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorState } from "@/components/feedback/error-state";
import { TableSkeleton } from "@/components/feedback/skeletons";
import { Pagination } from "@/components/layout/common";
import { staggerDelay } from "@/components/motion/stagger";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { ApiError } from "@/lib/http";
import { glossaryApi, type GlossaryVO, type TermSaveRequest, type TermVO } from "@/lib/api/glossaries";
import { toastError } from "@/lib/errors";
import { formatTime } from "@/lib/validators";
import { cn } from "@/lib/utils";

interface Draft {
  sourceTerm: string;
  targetTerm: string;
  note: string;
  caseSensitive: boolean;
}

const EMPTY: Draft = { sourceTerm: "", targetTerm: "", note: "", caseSensitive: false };

/** 行内编辑行：Enter 保存、Esc 取消 */
function EditRow({
  initial,
  onSave,
  onCancel,
  saving,
  error,
}: {
  initial: Draft;
  onSave: (d: Draft) => void;
  onCancel: () => void;
  saving: boolean;
  error?: string;
}) {
  const [d, setD] = useState(initial);
  const valid = d.sourceTerm.trim() && d.targetTerm.trim();
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && valid) onSave(d);
    if (e.key === "Escape") onCancel();
  };
  return (
    <motion.tr
      layout
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="bg-brand-soft/60"
    >
      <td className="px-3 py-2 align-top">
        <Input
          autoFocus
          aria-label="源术语"
          aria-invalid={!!error}
          value={d.sourceTerm}
          maxLength={200}
          onChange={(e) => setD({ ...d, sourceTerm: e.target.value })}
          onKeyDown={onKey}
          placeholder="源术语"
          className="h-8 bg-background"
        />
        {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      </td>
      <td className="px-3 py-2 align-top">
        <Input
          aria-label="目标术语"
          value={d.targetTerm}
          maxLength={200}
          onChange={(e) => setD({ ...d, targetTerm: e.target.value })}
          onKeyDown={onKey}
          placeholder="目标术语"
          className="h-8 bg-background"
        />
      </td>
      <td className="px-3 py-2 align-top">
        <Input
          aria-label="备注"
          value={d.note}
          maxLength={255}
          onChange={(e) => setD({ ...d, note: e.target.value })}
          onKeyDown={onKey}
          placeholder="备注（可选）"
          className="h-8 bg-background"
        />
      </td>
      <td className="px-3 py-2 align-top">
        <div className="flex h-8 items-center">
          <Switch
            aria-label="区分大小写"
            checked={d.caseSensitive}
            onCheckedChange={(c) => setD({ ...d, caseSensitive: c })}
          />
        </div>
      </td>
      <td className="hidden px-3 py-2 lg:table-cell" />
      <td className="px-3 py-2 text-right align-top whitespace-nowrap">
        <Button size="icon-sm" aria-label="保存" disabled={!valid || saving} onClick={() => onSave(d)}>
          <CheckIcon />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="取消" className="ml-1" onClick={onCancel}>
          <XIcon />
        </Button>
      </td>
    </motion.tr>
  );
}

/** 术语表：搜索、行内新增 / 编辑、删除、分页 */
export function TermTable({ glossary, onImport }: { glossary: GlossaryVO; onImport: () => void }) {
  const qc = useQueryClient();
  const [keyword, setKeyword] = useState("");
  const kw = useDebouncedValue(keyword.trim(), 300);
  const [pageNum, setPageNum] = useState(1);
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [fieldError, setFieldError] = useState<string>();
  const [toDelete, setToDelete] = useState<TermVO | null>(null);
  const pageSize = 20;

  const list = useQuery({
    queryKey: ["glossaries", glossary.id, "terms", { kw, pageNum }],
    queryFn: () => glossaryApi.terms(glossary.id, { pageNum, pageSize, keyword: kw || undefined }),
    placeholderData: keepPreviousData,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["glossaries"] });

  const save = useMutation({
    mutationFn: (p: { id: number | "new"; d: Draft }) => {
      const body: TermSaveRequest = {
        sourceTerm: p.d.sourceTerm.trim(),
        targetTerm: p.d.targetTerm.trim(),
        note: p.d.note.trim() || undefined,
        caseSensitive: p.d.caseSensitive,
      };
      return p.id === "new"
        ? glossaryApi.createTerm(glossary.id, body)
        : glossaryApi.updateTerm(glossary.id, p.id, body);
    },
    onSuccess: (_r, p) => {
      toast.success(p.id === "new" ? "术语已添加" : "术语已更新");
      setEditing(null);
      setFieldError(undefined);
      void invalidate();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === "A0112") setFieldError("该源术语已存在（不区分大小写）");
      else toastError(e);
    },
  });

  const remove = useMutation({
    mutationFn: (id: number) => glossaryApi.removeTerm(glossary.id, id),
    onSuccess: () => {
      toast.success("术语已删除");
      setToDelete(null);
      void invalidate();
    },
    onError: toastError,
  });

  const startEdit = (id: number | "new") => {
    setFieldError(undefined);
    setEditing(id);
  };

  const rows = list.data?.records ?? [];
  const empty = !list.isLoading && !list.isError && !rows.length && editing !== "new";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <div className="relative w-full max-w-xs">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={keyword}
            onChange={(e) => {
              setKeyword(e.target.value);
              setPageNum(1);
            }}
            placeholder="搜索源术语或目标术语"
            className="h-8 pl-8"
          />
        </div>
        {glossary.editable && (
          <Button size="sm" className="ml-auto" onClick={() => startEdit("new")} disabled={editing === "new"}>
            <PlusIcon />
            添加术语
          </Button>
        )}
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-auto">
        {list.isLoading ? (
          <TableSkeleton rows={8} cols={5} />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} retrying={list.isFetching} />
        ) : empty ? (
          kw ? (
            <EmptyState compact icon={SearchIcon} title="没有匹配的术语" description={`未找到包含「${kw}」的术语`} />
          ) : (
            <EmptyState
              icon={TypeIcon}
              title="这个术语库还没有术语"
              description={glossary.editable ? "逐条添加，或从 CSV 批量导入。" : "公共术语库由管理员维护。"}
              action={
                glossary.editable && (
                  <>
                    <Button onClick={() => startEdit("new")}>
                      <PlusIcon />
                      添加术语
                    </Button>
                    <Button variant="outline" onClick={onImport}>
                      <FileUpIcon />
                      导入 CSV
                    </Button>
                  </>
                )
              }
            />
          )
        ) : (
          <table className="w-full min-w-xl text-sm">
            <thead className="sticky top-0 z-10 bg-card/95 text-xs text-muted-foreground backdrop-blur">
              <tr className="border-b">
                <th className="w-[26%] px-3 py-2.5 text-left font-medium">源术语</th>
                <th className="w-[26%] px-3 py-2.5 text-left font-medium">目标术语</th>
                <th className="px-3 py-2.5 text-left font-medium">备注</th>
                <th className="w-24 px-3 py-2.5 text-left font-medium">大小写</th>
                <th className="hidden w-44 px-3 py-2.5 text-left font-medium lg:table-cell">更新时间</th>
                <th className="w-24 px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y">
              <AnimatePresence initial={false}>
                {editing === "new" && (
                  <EditRow
                    key="new"
                    initial={EMPTY}
                    saving={save.isPending}
                    error={fieldError}
                    onSave={(d) => save.mutate({ id: "new", d })}
                    onCancel={() => setEditing(null)}
                  />
                )}
              </AnimatePresence>
              {rows.map((t, i) =>
                editing === t.id ? (
                  <EditRow
                    key={t.id}
                    initial={{ sourceTerm: t.sourceTerm, targetTerm: t.targetTerm, note: t.note ?? "", caseSensitive: t.caseSensitive }}
                    saving={save.isPending}
                    error={fieldError}
                    onSave={(d) => save.mutate({ id: t.id, d })}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <motion.tr
                    key={t.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: staggerDelay(i), duration: 0.2 }}
                    className="group transition-colors hover:bg-muted/40"
                    onDoubleClick={() => glossary.editable && startEdit(t.id)}
                  >
                    <td className="px-3 py-2.5 font-medium">{t.sourceTerm}</td>
                    <td className="px-3 py-2.5 text-brand">{t.targetTerm}</td>
                    <td className="max-w-64 truncate px-3 py-2.5 text-muted-foreground" title={t.note ?? ""}>
                      {t.note || "—"}
                    </td>
                    <td className="px-3 py-2.5">
                      {t.caseSensitive ? (
                        <span className="inline-flex items-center gap-1 rounded-md bg-info-soft px-1.5 py-0.5 text-[11px] whitespace-nowrap text-info">
                          <CaseSensitiveIcon className="size-3.5" />
                          区分
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">不区分</span>
                      )}
                    </td>
                    <td className="hidden px-3 py-2.5 text-xs whitespace-nowrap text-muted-foreground lg:table-cell">
                      {formatTime(t.updatedAt)}
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      {glossary.editable && (
                        <span className={cn("inline-flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100")}>
                          <Tooltip>
                            <TooltipTrigger
                              render={<Button size="icon-sm" variant="ghost" aria-label="编辑" onClick={() => startEdit(t.id)} />}
                            >
                              <PencilIcon />
                            </TooltipTrigger>
                            <TooltipContent>编辑（双击行）</TooltipContent>
                          </Tooltip>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label="删除"
                            className="text-destructive"
                            onClick={() => setToDelete(t)}
                          >
                            <Trash2Icon />
                          </Button>
                        </span>
                      )}
                    </td>
                  </motion.tr>
                ),
              )}
            </tbody>
          </table>
        )}
      </div>

      {list.data && list.data.total > 0 && (
        <Pagination
          className="border-t px-4 py-2.5"
          pageNum={pageNum}
          pageSize={pageSize}
          total={list.data.total}
          onChange={setPageNum}
        />
      )}

      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="删除术语"
        description={`确定删除「${toDelete?.sourceTerm} → ${toDelete?.targetTerm}」吗？`}
        confirmText="删除"
        pending={remove.isPending}
        onConfirm={() => toDelete && remove.mutate(toDelete.id)}
      />
    </div>
  );
}
