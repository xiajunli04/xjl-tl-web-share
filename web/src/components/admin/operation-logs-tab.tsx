"use client";

import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AnimatePresence } from "motion/react";
import { ScrollTextIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CopyButton } from "@/components/feedback/copy-button";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorState } from "@/components/feedback/error-state";
import { TableSkeleton } from "@/components/feedback/skeletons";
import { FilterChip, Pagination, Surface } from "@/components/layout/common";
import { StaggerRow } from "@/components/motion/stagger";
import { logApi, type OperationLogQuery } from "@/lib/api/logs";
import type { OperationLogVO } from "@/lib/api/types";
import { formatTime, toIso } from "@/lib/validators";
import { cn } from "@/lib/utils";
import { FilterField, FilterPopover } from "./filter-popover";
import { SearchInput } from "./search-input";

const EMPTY = { module: "", startTime: "", endTime: "" };

function CodeBadge({ code }: { code: string }) {
  const ok = code === "00000";
  return (
    <span
      className={cn(
        "rounded-md px-1.5 py-0.5 font-mono text-[11px] font-medium",
        ok ? "bg-success-soft text-success" : "bg-danger-soft text-danger",
      )}
    >
      {code}
    </span>
  );
}

function MethodBadge({ method }: { method: string }) {
  return (
    <span className="inline-flex min-w-11 justify-center rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] font-semibold text-muted-foreground">
      {method}
    </span>
  );
}

/** 参数尽量格式化为 JSON */
function prettyParams(p: string | null) {
  if (!p) return null;
  try {
    return JSON.stringify(JSON.parse(p), null, 2);
  } catch {
    return p;
  }
}

/** 操作日志标签页：参数详情在侧滑面板中查看 */
export function OperationLogsTab() {
  const [username, setUsername] = useState("");
  const [filters, setFilters] = useState(EMPTY);
  const [draft, setDraft] = useState(EMPTY);
  const [query, setQuery] = useState<OperationLogQuery>({ pageNum: 1, pageSize: 10 });
  const [detail, setDetail] = useState<OperationLogVO | null>(null);

  const list = useQuery({
    queryKey: ["logs-operation", query],
    queryFn: () => logApi.operation(query),
    placeholderData: keepPreviousData,
  });

  const apply = (f: typeof EMPTY) => {
    setFilters(f);
    setQuery({
      pageNum: 1,
      pageSize: query.pageSize,
      username: username.trim() || undefined,
      module: f.module.trim() || undefined,
      startTime: toIso(f.startTime),
      endTime: toIso(f.endTime),
    });
  };

  const chips: { key: keyof typeof EMPTY; label: string }[] = [];
  if (filters.module) chips.push({ key: "module", label: `模块：${filters.module}` });
  if (filters.startTime) chips.push({ key: "startTime", label: `起：${formatTime(toIso(filters.startTime))}` });
  if (filters.endTime) chips.push({ key: "endTime", label: `止：${formatTime(toIso(filters.endTime))}` });
  const records = list.data?.records ?? [];
  const params = prettyParams(detail?.params ?? null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={username} onChange={setUsername} onSubmit={() => apply(filters)} placeholder="按用户名搜索，回车确认" />
        <FilterPopover count={chips.length} onOpen={() => setDraft(filters)} onClear={() => setDraft(EMPTY)} onApply={() => apply(draft)}>
          <FilterField label="模块">
            <Input value={draft.module} placeholder="例如：用户管理" onChange={(e) => setDraft({ ...draft, module: e.target.value })} />
          </FilterField>
          <FilterField label="时间范围">
            <Input type="datetime-local" aria-label="开始时间" value={draft.startTime} onChange={(e) => setDraft({ ...draft, startTime: e.target.value })} />
            <Input type="datetime-local" aria-label="结束时间" value={draft.endTime} onChange={(e) => setDraft({ ...draft, endTime: e.target.value })} />
          </FilterField>
        </FilterPopover>
        <AnimatePresence>
          {chips.map((c) => (
            <FilterChip key={c.key} label={c.label} onRemove={() => apply({ ...filters, [c.key]: "" })} />
          ))}
        </AnimatePresence>
      </div>

      <Surface>
        {list.isLoading ? (
          <TableSkeleton rows={8} cols={6} />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} retrying={list.isFetching} />
        ) : !records.length ? (
          <EmptyState compact icon={ScrollTextIcon} title="暂无操作日志" description="管理员的写操作会记录在这里。" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead className="pl-4">时间</TableHead>
                <TableHead>操作人</TableHead>
                <TableHead>模块 / 操作</TableHead>
                <TableHead>请求</TableHead>
                <TableHead>结果码</TableHead>
                <TableHead className="pr-4 text-right">耗时</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.map((r, i) => (
                <StaggerRow
                  key={r.id}
                  index={i}
                  onClick={() => setDetail(r)}
                  className="cursor-pointer border-b transition-colors hover:bg-muted/40"
                >
                  <TableCell className="pl-4 whitespace-nowrap text-muted-foreground tabular-nums">{formatTime(r.createdAt)}</TableCell>
                  <TableCell className="font-medium">{r.username}</TableCell>
                  <TableCell>
                    <span className="text-muted-foreground">{r.module}</span> · {r.action}
                  </TableCell>
                  <TableCell className="max-w-72">
                    <span className="flex items-center gap-2">
                      <MethodBadge method={r.method} />
                      <span className="truncate font-mono text-xs">{r.path}</span>
                    </span>
                  </TableCell>
                  <TableCell>
                    <CodeBadge code={r.resultCode} />
                  </TableCell>
                  <TableCell className="pr-4 text-right text-muted-foreground tabular-nums">{r.durationMs} ms</TableCell>
                </StaggerRow>
              ))}
            </TableBody>
          </Table>
        )}
        {list.data && list.data.total > 0 && (
          <Pagination
            className="border-t px-4 py-2.5"
            pageNum={query.pageNum}
            pageSize={query.pageSize}
            total={list.data.total}
            onChange={(p) => setQuery({ ...query, pageNum: p })}
          />
        )}
      </Surface>

      <Sheet open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <SheetContent className="sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>
              {detail?.module} · {detail?.action}
            </SheetTitle>
            <SheetDescription>
              {detail && `${detail.username} · ${formatTime(detail.createdAt)}`}
            </SheetDescription>
          </SheetHeader>
          {detail && (
            <SheetBody className="space-y-5">
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-lg border p-3">
                  <div className="text-[11px] text-muted-foreground">结果码</div>
                  <div className="mt-1">
                    <CodeBadge code={detail.resultCode} />
                  </div>
                </div>
                <div className="rounded-lg border p-3">
                  <div className="text-[11px] text-muted-foreground">耗时</div>
                  <div className="mt-1 text-sm font-medium tabular-nums">{detail.durationMs} ms</div>
                </div>
                <div className="rounded-lg border p-3">
                  <div className="text-[11px] text-muted-foreground">IP</div>
                  <div className="mt-1 font-mono text-sm">{detail.ip}</div>
                </div>
              </div>
              <div>
                <div className="mb-1.5 text-xs font-medium text-muted-foreground">请求</div>
                <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
                  <MethodBadge method={detail.method} />
                  <span className="font-mono text-xs break-all">{detail.path}</span>
                </div>
              </div>
              <div>
                <div className="mb-1.5 flex items-center justify-between text-xs font-medium text-muted-foreground">
                  traceId
                </div>
                <div className="flex items-center justify-between gap-2 rounded-lg border px-3 py-1.5">
                  <span className="font-mono text-xs">{detail.traceId}</span>
                  <CopyButton text={detail.traceId} size="icon-xs" label="复制 traceId" />
                </div>
              </div>
              <div>
                <div className="mb-1.5 flex items-center justify-between text-xs font-medium text-muted-foreground">
                  请求参数
                  {params && <CopyButton text={params} size="icon-xs" label="复制参数" />}
                </div>
                {params ? (
                  <pre className="scrollbar-thin max-h-[50vh] overflow-auto rounded-lg bg-muted/60 p-3 font-mono text-xs leading-relaxed">
                    {params}
                  </pre>
                ) : (
                  <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">无参数</p>
                )}
              </div>
            </SheetBody>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
