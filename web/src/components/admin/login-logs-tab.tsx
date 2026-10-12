"use client";

import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AnimatePresence } from "motion/react";
import { CheckCircle2Icon, LogInIcon, MonitorSmartphoneIcon, XCircleIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Table, TableBody, TableHead, TableHeader, TableRow, TableCell } from "@/components/ui/table";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorState } from "@/components/feedback/error-state";
import { TableSkeleton } from "@/components/feedback/skeletons";
import { FilterChip, Pagination, Surface } from "@/components/layout/common";
import { StaggerRow } from "@/components/motion/stagger";
import { logApi, type LoginLogQuery } from "@/lib/api/logs";
import type { LoginLogVO } from "@/lib/api/types";
import { formatTime, toIso } from "@/lib/validators";
import { cn } from "@/lib/utils";
import { FilterField, FilterPopover } from "./filter-popover";
import { SearchInput } from "./search-input";

type Result = "" | "true" | "false";
const EMPTY = { success: "" as Result, startTime: "", endTime: "" };

function ResultBadge({ success }: { success: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        success ? "bg-success-soft text-success" : "bg-danger-soft text-danger",
      )}
    >
      {success ? <CheckCircle2Icon className="size-3" /> : <XCircleIcon className="size-3" />}
      {success ? "成功" : "失败"}
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_1fr] gap-3 py-2.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-all">{children}</span>
    </div>
  );
}

/** 登录日志标签页：工具条（用户名 + 筛选弹层）+ 表格 + 侧滑详情 */
export function LoginLogsTab() {
  const [username, setUsername] = useState("");
  const [filters, setFilters] = useState(EMPTY);
  const [draft, setDraft] = useState(EMPTY);
  const [query, setQuery] = useState<LoginLogQuery>({ pageNum: 1, pageSize: 10 });
  const [detail, setDetail] = useState<LoginLogVO | null>(null);

  const list = useQuery({
    queryKey: ["logs-login", query],
    queryFn: () => logApi.login(query),
    placeholderData: keepPreviousData,
  });

  const apply = (f: typeof EMPTY, name = username) => {
    setFilters(f);
    setQuery({
      pageNum: 1,
      pageSize: query.pageSize,
      username: name.trim() || undefined,
      success: f.success === "" ? undefined : f.success === "true",
      startTime: toIso(f.startTime),
      endTime: toIso(f.endTime),
    });
  };

  const chips: { key: keyof typeof EMPTY; label: string }[] = [];
  if (filters.success) chips.push({ key: "success", label: filters.success === "true" ? "结果：成功" : "结果：失败" });
  if (filters.startTime) chips.push({ key: "startTime", label: `起：${formatTime(toIso(filters.startTime))}` });
  if (filters.endTime) chips.push({ key: "endTime", label: `止：${formatTime(toIso(filters.endTime))}` });

  const records = list.data?.records ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={username} onChange={setUsername} onSubmit={() => apply(filters)} placeholder="按用户名搜索，回车确认" />
        <FilterPopover
          count={chips.length}
          onOpen={() => setDraft(filters)}
          onClear={() => setDraft(EMPTY)}
          onApply={() => apply(draft)}
        >
          <FilterField label="结果">
            <Segmented<Result>
              size="sm"
              className="w-full"
              value={draft.success}
              onChange={(v) => setDraft({ ...draft, success: v })}
              options={[
                { value: "", label: "全部" },
                { value: "true", label: "成功" },
                { value: "false", label: "失败" },
              ]}
            />
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
          <TableSkeleton rows={8} cols={5} />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} retrying={list.isFetching} />
        ) : !records.length ? (
          <EmptyState compact icon={LogInIcon} title="暂无登录日志" description="调整筛选条件后再试。" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead className="pl-4">时间</TableHead>
                <TableHead>用户名</TableHead>
                <TableHead>结果</TableHead>
                <TableHead>失败原因</TableHead>
                <TableHead>IP</TableHead>
                <TableHead className="pr-4">客户端</TableHead>
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
                    <ResultBadge success={r.success} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">{r.failReason || "—"}</TableCell>
                  <TableCell className="font-mono text-xs">{r.ip}</TableCell>
                  <TableCell className="max-w-56 truncate pr-4 text-xs text-muted-foreground">{r.userAgent}</TableCell>
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
        <SheetContent>
          <SheetHeader>
            <SheetTitle>登录详情</SheetTitle>
            <SheetDescription>{detail && formatTime(detail.createdAt)}</SheetDescription>
          </SheetHeader>
          {detail && (
            <SheetBody className="divide-y">
              <Row label="用户名">{detail.username}</Row>
              <Row label="用户 ID">{detail.userId ?? "—（未匹配到用户）"}</Row>
              <Row label="结果">
                <ResultBadge success={detail.success} />
              </Row>
              <Row label="失败原因">{detail.failReason || "—"}</Row>
              <Row label="IP">
                <span className="font-mono">{detail.ip}</span>
              </Row>
              <Row label="客户端">
                <span className="flex gap-2">
                  <MonitorSmartphoneIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="font-mono text-xs leading-relaxed">{detail.userAgent}</span>
                </span>
              </Row>
            </SheetBody>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
