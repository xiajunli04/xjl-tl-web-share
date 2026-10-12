"use client";

import { motion, useReducedMotion } from "motion/react";
import { AlertTriangleIcon, ArrowRightIcon, CheckCircle2Icon, Loader2Icon, ShieldCheckIcon } from "lucide-react";
import { EmptyState } from "@/components/feedback/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { DURATION, EASE_OUT, staggerDelay } from "@/components/motion";
import type { ConsistencyIssue, DocTaskVO } from "@/lib/api/documents";
import { cn } from "@/lib/utils";
import { useWorkspace } from "./context";

function SegChip({ seq, tone }: { seq: number; tone: "fixed" | "unresolved" }) {
  const { locate, select } = useWorkspace();
  return (
    <button
      type="button"
      onClick={() => {
        locate(seq);
        select(seq);
      }}
      title="定位到该段"
      className={cn(
        "inline-flex h-6 items-center rounded-md px-2 font-mono text-[11px] ring-1 transition-colors",
        tone === "fixed"
          ? "bg-success-soft text-success ring-success/25 hover:bg-success/20"
          : "bg-danger-soft text-danger ring-danger/25 hover:bg-danger/20",
      )}
    >
      §{seq}
    </button>
  );
}

function IssueCard({ issue, index }: { issue: ConsistencyIssue; index: number }) {
  const reduce = useReducedMotion();
  const total = issue.variants.reduce((n, v) => n + v.count, 0) || 1;
  return (
    <motion.li
      initial={{ opacity: 0, y: reduce ? 0 : 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DURATION.page, ease: EASE_OUT, delay: staggerDelay(index) }}
      className="rounded-xl border bg-card p-3 shadow-card"
    >
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-semibold">{issue.term}</span>
        <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate rounded-md bg-brand-soft px-1.5 py-0.5 text-xs font-medium text-brand">{issue.chosen}</span>
        {issue.unresolvedSegs.length > 0 ? (
          <AlertTriangleIcon className="ml-auto size-4 shrink-0 text-danger" aria-label="存在未解决段落" />
        ) : (
          <CheckCircle2Icon className="ml-auto size-4 shrink-0 text-success" aria-label="已全部统一" />
        )}
      </div>
      {/* 各译法占比 */}
      <div className="mt-2.5 flex h-1.5 overflow-hidden rounded-full bg-muted">
        {issue.variants.map((v, i) => (
          <motion.span
            key={v.text}
            className={cn(v.text === issue.chosen ? "bg-brand" : i % 2 ? "bg-warning" : "bg-danger/70")}
            initial={{ width: 0 }}
            animate={{ width: `${(v.count / total) * 100}%` }}
            transition={{ duration: reduce ? 0 : 0.5, ease: EASE_OUT, delay: 0.1 }}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {issue.variants.map((v) => (
          <span
            key={v.text}
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]",
              v.text === issue.chosen ? "bg-brand-soft text-brand" : "bg-muted text-muted-foreground line-through",
            )}
          >
            {v.text}
            <span className="tabular-nums opacity-70">×{v.count}</span>
          </span>
        ))}
      </div>
      {issue.fixedSegs.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-[11px] text-muted-foreground">已修正 {issue.fixedSegs.length} 段（点击定位）</div>
          <div className="flex flex-wrap gap-1">
            {issue.fixedSegs.map((s) => (
              <SegChip key={s} seq={s} tone="fixed" />
            ))}
          </div>
        </div>
      )}
      {issue.unresolvedSegs.length > 0 && (
        <div className="mt-2.5">
          <div className="mb-1 text-[11px] text-danger">未能自动修正 {issue.unresolvedSegs.length} 段，建议人工处理</div>
          <div className="flex flex-wrap gap-1">
            {issue.unresolvedSegs.map((s) => (
              <SegChip key={s} seq={s} tone="unresolved" />
            ))}
          </div>
        </div>
      )}
    </motion.li>
  );
}

/** 一致性报告：源词、各译法及次数、选定译法、已修正 / 未解决段落（点击定位并闪烁） */
export function ConsistencyPanel({ task }: { task: DocTaskVO }) {
  const report = task.consistencyReport;
  if (!report) {
    if (task.status === "CONSISTENCY") {
      return (
        <div className="space-y-3 px-4 py-4" aria-busy="true">
          <p className="flex items-center gap-2 text-xs text-brand">
            <Loader2Icon className="size-3.5 animate-spin motion-reduce:animate-none" />
            正在统计各段译文中的术语译法…
          </p>
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="space-y-2 rounded-xl border p-3">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-1.5 w-full" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          ))}
        </div>
      );
    }
    return (
      <EmptyState
        compact
        icon={ShieldCheckIcon}
        title={task.status === "COMPLETED" ? "没有一致性报告" : "一致性检查尚未开始"}
        description="全部分块翻译完成后，Agent 会检查任务术语与专名在全文中的译法是否统一，并定向修正不一致的段落。"
      />
    );
  }
  if (!report.issues.length) {
    return <EmptyState compact icon={CheckCircle2Icon} title="全文术语一致" description="所有任务术语与专名在各段中的译法都已统一。" />;
  }
  const fixed = report.issues.reduce((n, i) => n + i.fixedSegs.length, 0);
  const unresolved = report.issues.reduce((n, i) => n + i.unresolvedSegs.length, 0);
  return (
    <div className="space-y-3 px-4 py-3">
      <div className="grid grid-cols-3 gap-2 text-center">
        {[
          { label: "不一致术语", value: report.issues.length, cls: "text-warning" },
          { label: "已修正段落", value: fixed, cls: "text-success" },
          { label: "未解决", value: unresolved, cls: unresolved ? "text-danger" : "text-muted-foreground" },
        ].map((s) => (
          <div key={s.label} className="rounded-lg border bg-card px-2 py-2">
            <div className={cn("text-lg font-semibold tabular-nums", s.cls)}>{s.value}</div>
            <div className="text-[10px] text-muted-foreground">{s.label}</div>
          </div>
        ))}
      </div>
      <ul className="space-y-2">
        {report.issues.map((issue, i) => (
          <IssueCard key={issue.term} issue={issue} index={i} />
        ))}
      </ul>
    </div>
  );
}
