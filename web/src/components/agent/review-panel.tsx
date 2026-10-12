"use client";

import { ClipboardCheckIcon } from "lucide-react";
import { StaggerItem, StaggerList } from "@/components/motion/stagger";
import { EmptyState } from "@/components/feedback/empty-state";
import type { ReviewEventData, ReviewIssue } from "@/lib/api/translate";
import { cn } from "@/lib/utils";
import { CATEGORY_LABEL, SEVERITY_LABEL } from "./node-meta";
import { ScoreRing } from "./score-ring";

function severityClass(s: string) {
  if (s === "critical") return "bg-danger-soft text-danger";
  if (s === "major") return "bg-warning-soft text-warning";
  return "bg-info-soft text-info";
}

function groupIssues(issues: ReviewIssue[]) {
  const groups = new Map<string, ReviewIssue[]>();
  for (const i of issues) {
    const list = groups.get(i.category) ?? [];
    list.push(i);
    groups.set(i.category, list);
  }
  return [...groups.entries()];
}

/** 评审标签页：每轮一张卡片，分数环 + 问题按维度分组 */
export function ReviewPanel({
  reviews,
  emptyTitle = "暂无评审",
  emptyDescription = "标准路径会在首译后进行 LLM 评审，分数低于 85 时自动修正。",
}: {
  reviews: ReviewEventData[];
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  if (!reviews.length) {
    return (
      <EmptyState compact icon={ClipboardCheckIcon} title={emptyTitle} description={emptyDescription} />
    );
  }
  return (
    <StaggerList className="space-y-3">
      {reviews.map((r, idx) => (
        <StaggerItem
          key={r.round}
          index={idx}
          className="rounded-xl border bg-card p-4 shadow-card"
        >
          <div className="flex items-center gap-4">
            <ScoreRing score={r.score} passed={r.passed} />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">
                {r.round === 0 ? "首译评审" : `第 ${r.round} 轮修正评审`}
              </div>
              <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 font-medium",
                    r.passed ? "bg-success-soft text-success" : "bg-warning-soft text-warning",
                  )}
                >
                  {r.passed ? "通过" : "未通过"}
                </span>
                {r.score === null
                  ? "评审输出无法解析，视为通过"
                  : r.issues.length
                    ? `${r.issues.length} 个问题`
                    : "未发现问题"}
              </div>
            </div>
          </div>
          {r.issues.length > 0 && (
            <div className="mt-4 space-y-3 border-t pt-3">
              {groupIssues(r.issues).map(([cat, list]) => (
                <div key={cat}>
                  <div className="mb-1.5 text-xs font-medium text-muted-foreground">
                    {CATEGORY_LABEL[cat as keyof typeof CATEGORY_LABEL] ?? cat} · {list.length}
                  </div>
                  <ul className="space-y-1.5">
                    {list.map((i, k) => (
                      <li key={k} className="rounded-lg bg-muted/50 px-3 py-2 text-xs leading-relaxed">
                        <div className="flex items-center gap-2">
                          <span className={cn("rounded px-1.5 py-px text-[11px] font-medium", severityClass(i.severity))}>
                            {SEVERITY_LABEL[i.severity] ?? i.severity}
                          </span>
                          {i.span && (
                            <span className="rounded bg-danger-soft px-1.5 font-medium text-danger line-through decoration-danger/50">
                              {i.span}
                            </span>
                          )}
                        </div>
                        {i.suggestion && <p className="mt-1 text-foreground/80">{i.suggestion}</p>}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </StaggerItem>
      ))}
    </StaggerList>
  );
}
