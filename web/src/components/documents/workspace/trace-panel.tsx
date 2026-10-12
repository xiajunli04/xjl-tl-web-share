"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import {
  BookOpenCheckIcon,
  FileSearchIcon,
  FlagIcon,
  GitMergeIcon,
  LanguagesIcon,
  RadioIcon,
  ScanSearchIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { AgentTimeline, type TimelineItem, type TimelineStatus } from "@/components/agent/agent-timeline";
import { DURATION } from "@/components/motion/tokens";
import { useDocTaskSelector } from "@/hooks/use-doc-task";
import { docApi, type DocTaskVO, type DocTraceVO } from "@/lib/api/documents";
import { ListSkeleton } from "@/components/feedback/skeletons";
import type { DocLogItem } from "@/lib/doc-task";
import { langName } from "@/lib/languages";
import { cn } from "@/lib/utils";
import { formatDuration, stepIndexOf, toneDot } from "../meta";
import { useWorkspace } from "./context";

const ICONS = [FileSearchIcon, ScanSearchIcon, BookOpenCheckIcon, LanguagesIcon, ShieldCheckIcon, FlagIcon];
const NODES = ["parse", "analyze", "confirm_terms", "translate_groups", "consistency", "finalize"];
const LABELS = ["解析", "全文分析", "术语确认", "分块翻译", "一致性检查", "定稿"];

/** doc_task_trace.node → 名称与图标（design.md D5 篇章图节点） */
const NODE_META: Record<string, { label: string; icon: typeof FlagIcon }> = {
  parse: { label: "解析", icon: FileSearchIcon },
  analyze: { label: "全文分析", icon: ScanSearchIcon },
  align_terms: { label: "术语对齐", icon: GitMergeIcon },
  confirm_terms: { label: "术语确认", icon: BookOpenCheckIcon },
  translate_chunk: { label: "分块翻译", icon: LanguagesIcon },
  translate_groups: { label: "分块翻译", icon: LanguagesIcon },
  review_model: { label: "评审模型", icon: ShieldAlertIcon },
  consistency: { label: "一致性检查", icon: ShieldCheckIcon },
  finalize: { label: "定稿", icon: FlagIcon },
};

function traceStatus(s: string): TimelineStatus {
  if (s === "completed") return "completed";
  if (s === "skipped") return "skipped";
  if (s === "failed" || s === "error") return "error";
  return "running";
}

function traceItems(list: DocTraceVO[]): TimelineItem[] {
  return list.map((t) => ({
    key: `tr-${t.seq}`,
    node: t.node,
    label: (NODE_META[t.node]?.label ?? t.node) + (t.chunkIndex !== null && t.chunkIndex !== undefined ? ` · 第 ${t.chunkIndex + 1} 块` : ""),
    icon: NODE_META[t.node]?.icon,
    status: traceStatus(t.status),
    summary: t.summary,
    latencyMs: t.latencyMs,
    tokens: (t.promptTokens ?? 0) + (t.completionTokens ?? 0) || undefined,
  }));
}

/** 由任务状态推导篇章图各阶段（design.md D5）的时间线 */
function phaseItems(task: DocTaskVO, termCount: { ok: number; rejected: number } | null): TimelineItem[] {
  const current = stepIndexOf(task);
  const terminal: TimelineStatus | null =
    task.status === "FAILED" ? "error" : task.status === "CANCELLED" || task.status === "CANCELLING" ? "stopped" : null;
  const issues = task.consistencyReport?.issues ?? [];
  const summaries = [
    task.progressTotal ? `切分为 ${task.progressTotal} 块${task.detectedLang ? ` · 识别为${langName(task.detectedLang)}` : ""}` : null,
    task.domain ? `领域：${task.domain}${task.genre ? ` · ${task.genre}` : ""}${task.summary ? " · 已生成全文摘要" : ""}` : null,
    !task.confirmTerms
      ? "未开启人工确认：术语库术语强制使用，抽取术语仅作参考"
      : termCount
        ? `确认 ${termCount.ok} 条，拒绝 ${termCount.rejected} 条`
        : null,
    task.progressTotal ? `已完成 ${task.progressDone}/${task.progressTotal} 块` : null,
    task.consistencyReport ? (issues.length ? `${issues.length} 个术语存在多种译法，已定向修正` : "全文术语一致") : null,
    task.status === "COMPLETED" ? `总耗时 ${formatDuration(task.latencyMs)}` : null,
  ];
  return NODES.map((node, i) => {
    let status: TimelineStatus;
    if (i === 2 && !task.confirmTerms && current > 2) status = "skipped";
    else if (task.status === "COMPLETED" || i < current) status = "completed";
    else if (i === current) status = terminal ?? "running";
    else status = "pending";
    return {
      key: node,
      node,
      label: LABELS[i],
      icon: ICONS[i],
      status,
      summary:
        status === "error"
          ? `${task.errorCode ?? ""} ${task.errorMessage ?? "执行失败"}`.trim()
          : status === "stopped"
            ? "任务已取消，可从断点继续"
            : status === "pending"
              ? null
              : summaries[i],
    };
  });
}

function LogRow({ item }: { item: DocLogItem }) {
  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DURATION.page }}
      className="flex gap-2.5 py-1.5"
    >
      <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", toneDot(item.tone))} />
      <div className="min-w-0 flex-1">
        <div className="text-xs">{item.title}</div>
        {item.detail && <div className="truncate text-[11px] text-muted-foreground">{item.detail}</div>}
      </div>
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
        {new Date(item.at).toLocaleTimeString("zh-CN", { hour12: false })}
      </span>
    </motion.li>
  );
}

/** 轨迹：篇章图阶段时间线 + 本次会话收到的实时事件（服务端若转发 trace 事件则一并展示） */
export function TracePanel({ task }: { task: DocTaskVO }) {
  const { id, store } = useWorkspace();
  const log = useDocTaskSelector(store, (s) => s.log);
  const sseTraces = useDocTaskSelector(store, (s) => s.traces);
  const terms = useDocTaskSelector(store, (s) => s.terms);
  // 每收到一批执行事件就刷新一次服务端轨迹（GET /api/doc-tasks/{id}/traces）
  const version = log.filter((l) => l.kind !== "duplicate" && l.kind !== "reconnecting").length;
  const traces = useQuery({
    queryKey: ["doc-tasks", id, "traces", version],
    queryFn: () => docApi.traces(id),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const termCount =
    terms && task.status !== "AWAITING_CONFIRM"
      ? { ok: terms.filter((t) => t.status === "CONFIRMED").length, rejected: terms.filter((t) => t.status === "REJECTED").length }
      : null;
  const recent = [...log].reverse().slice(0, 60);
  const serverItems: DocTraceVO[] =
    traces.data ??
    sseTraces.map((t) => ({
      seq: t.seq,
      node: t.node,
      chunkIndex: t.chunk ?? null,
      status: t.status,
      summary: t.summary,
      latencyMs: t.latencyMs ?? null,
      promptTokens: t.usage?.promptTokens ?? null,
      completionTokens: t.usage?.completionTokens ?? null,
      createdAt: "",
    }));

  return (
    <div className="space-y-4 px-4 py-4">
      <section className="rounded-xl border bg-card p-3 shadow-card">
        <h4 className="mb-3 text-xs font-medium text-muted-foreground">阶段</h4>
        <AgentTimeline items={phaseItems(task, termCount)} />
      </section>

      <section className="rounded-xl border bg-card p-3 shadow-card">
        <h4 className="mb-3 flex items-center text-xs font-medium text-muted-foreground">
          Agent 节点轨迹
          <span className="ml-auto font-normal tabular-nums">{serverItems.length}</span>
        </h4>
        {traces.isLoading && !sseTraces.length ? (
          <ListSkeleton rows={3} />
        ) : serverItems.length ? (
          <AgentTimeline items={traceItems(serverItems)} />
        ) : (
          <p className="py-2 text-xs text-muted-foreground">
            {traces.isError ? "轨迹加载失败，稍后会自动重试。" : "节点执行完成后，轨迹会出现在这里。"}
          </p>
        )}
      </section>

      <section className="rounded-xl border bg-card p-3 shadow-card">
        <h4 className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <RadioIcon className="size-3.5" />
          实时事件
          <span className="ml-auto font-normal tabular-nums">{log.length}</span>
        </h4>
        {recent.length ? (
          <ul className="scrollbar-thin max-h-72 divide-y divide-border/50 overflow-y-auto">
            <AnimatePresence initial={false}>
              {recent.map((item) => (
                <LogRow key={item.key} item={item} />
              ))}
            </AnimatePresence>
          </ul>
        ) : (
          <p className="py-3 text-xs text-muted-foreground">连接后，执行事件会实时出现在这里。</p>
        )}
      </section>
    </div>
  );
}
