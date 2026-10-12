"use client";

import { ArrowRightIcon, BookMarkedIcon, CheckIcon, Clock3Icon, InfoIcon, XIcon } from "lucide-react";
import { StaggerItem, StaggerList } from "@/components/motion/stagger";
import { EmptyState } from "@/components/feedback/empty-state";
import type { TermCompliance, TermHit } from "@/lib/api/translate";
import { cn } from "@/lib/utils";

/** 术语标签页：命中术语与遵循情况；未遵循标红 */
export function TermsPanel({
  hits,
  compliance,
  skippedGlossaries = [],
  glossaryName,
  pending,
  emptyDescription = "所选术语库中的术语在原文出现时，会在这里列出并在定稿时逐条校验。",
}: {
  hits: TermHit[];
  compliance?: TermCompliance[] | null;
  skippedGlossaries?: number[];
  glossaryName?: (id: number) => string | undefined;
  /** 仍在翻译中，遵循情况待定 */
  pending?: boolean;
  emptyDescription?: string;
}) {
  const find = (h: { source: string }) =>
    compliance?.find((c) => c.source.toLowerCase() === h.source.toLowerCase());
  const total = compliance?.length ?? 0;
  const ok = compliance?.filter((c) => c.compliant).length ?? 0;
  // 历史详情可能只有 compliance 没有 termHits
  const rows: (TermHit | (TermCompliance & { glossaryId?: number }))[] = hits.length ? hits : (compliance ?? []);

  return (
    <div className="space-y-3">
      {skippedGlossaries.length > 0 && (
        <div className="flex gap-2 rounded-lg border border-info/25 bg-info-soft px-3 py-2 text-xs text-info">
          <InfoIcon className="mt-px size-3.5 shrink-0" />
          <span>
            已跳过 {skippedGlossaries.length} 个语言对不符的术语库：
            {skippedGlossaries.map((id) => glossaryName?.(id) ?? `#${id}`).join("、")}
          </span>
        </div>
      )}
      {!rows.length ? (
        <EmptyState compact icon={BookMarkedIcon} title="未命中术语" description={emptyDescription} />
      ) : (
        <>
          {total > 0 && (
            <div className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2 text-xs">
              <span className="text-muted-foreground">术语遵循</span>
              <span className={cn("font-semibold tabular-nums", ok === total ? "text-success" : "text-danger")}>
                {ok} / {total}
              </span>
            </div>
          )}
          <StaggerList className="space-y-1.5">
            {rows.map((h, i) => {
              const c = find(h);
              const state = c ? (c.compliant ? "ok" : "bad") : pending ? "pending" : "unknown";
              const gid = "glossaryId" in h ? h.glossaryId : undefined;
              return (
                <StaggerItem
                  key={`${h.source}-${i}`}
                  index={i}
                  className={cn(
                    "flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5 text-sm",
                    state === "bad" && "border-danger/40 bg-danger-soft",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-6 shrink-0 items-center justify-center rounded-full",
                      state === "ok" && "bg-success-soft text-success",
                      state === "bad" && "bg-danger text-danger-foreground",
                      (state === "pending" || state === "unknown") && "bg-muted text-muted-foreground",
                    )}
                  >
                    {state === "ok" ? (
                      <CheckIcon className="size-3.5" />
                    ) : state === "bad" ? (
                      <XIcon className="size-3.5" />
                    ) : (
                      <Clock3Icon className="size-3.5" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">{h.source}</span>
                      <ArrowRightIcon className="size-3 text-muted-foreground" />
                      <span className={cn("font-medium", state === "bad" ? "text-danger" : "text-brand")}>
                        {h.target}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      {state === "bad"
                        ? "译文中未使用规定译法"
                        : state === "ok"
                          ? "已遵循"
                          : state === "pending"
                            ? "等待定稿校验"
                            : "—"}
                      {gid !== undefined && ` · ${glossaryName?.(gid) ?? `术语库 #${gid}`}`}
                    </div>
                  </div>
                </StaggerItem>
              );
            })}
          </StaggerList>
        </>
      )}
    </div>
  );
}
