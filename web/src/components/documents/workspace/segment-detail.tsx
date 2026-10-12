"use client";

import { ArrowLeftIcon, BrainCircuitIcon, CheckIcon, LocateFixedIcon, PencilLineIcon, SparklesIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScoreRing } from "@/components/agent/score-ring";
import { FadeIn } from "@/components/motion/fade-in";
import { TmHitCard } from "@/components/memory/tm-hit";
import { useDocTaskSelector } from "@/hooks/use-doc-task";
import type { DocBlockType } from "@/lib/api/documents";
import { cn } from "@/lib/utils";
import { useWorkspace } from "./context";
import { renderInline } from "./inline";
import { RetranslateBox } from "./retranslate";

const BLOCK_LABEL: Record<DocBlockType, string> = {
  heading: "标题",
  paragraph: "段落",
  list_item: "列表项",
  blockquote: "引用",
  table_row: "表格行",
  code: "代码块",
  html: "HTML",
  blank: "空行",
  hr: "分隔线",
};

/** 段落详情：评审分、修正轮次、术语遵循、一致性修正说明；可编辑与重译 */
export function SegmentDetail({ seq }: { seq: number }) {
  const ws = useWorkspace();
  const seg = useDocTaskSelector(ws.store, (s) => {
    const i = s.seqIndex.get(seq);
    return i === undefined ? null : (s.segments?.[i] ?? null);
  });
  const task = useDocTaskSelector(ws.store, (s) => s.task);
  if (!seg) return null;
  const tmHits = Array.isArray(seg.tmHits) ? seg.tmHits : [];
  const fixes = (task?.consistencyReport?.issues ?? []).filter((i) => i.fixedSegs.includes(seq) || i.unresolvedSegs.includes(seq));
  const passed = (seg.reviewScore ?? 100) >= 85;
  const terminal = task && ["COMPLETED", "FAILED", "CANCELLED"].includes(task.status);
  const canAct = seg.translatable && task?.status !== "CONSISTENCY" && (terminal || seg.target !== null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <Button variant="ghost" size="icon-sm" aria-label="返回" onClick={() => ws.select(null)}>
          <ArrowLeftIcon />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">段落 §{seg.seq}</div>
          <div className="text-[11px] text-muted-foreground">
            {BLOCK_LABEL[seg.blockType]}
            {seg.chunkIndex !== null && ` · 第 ${seg.chunkIndex + 1} 块`}
            {!seg.translatable && " · 不翻译"}
          </div>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="在列表中定位" onClick={() => ws.locate(seg.seq)}>
          <LocateFixedIcon />
        </Button>
      </div>
      <FadeIn key={seq} className="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {seg.translatable && (
          <section className="flex items-center gap-4 rounded-xl border bg-card p-3 shadow-card">
            {seg.reviewScore !== null ? (
              <ScoreRing score={seg.reviewScore} passed={passed} size={58} />
            ) : (
              <div className="flex size-[58px] shrink-0 items-center justify-center rounded-full border-2 border-dashed text-[11px] text-muted-foreground">
                未评审
              </div>
            )}
            <div className="grid flex-1 grid-cols-2 gap-2 text-xs">
              <div>
                <div className="text-[11px] text-muted-foreground">评审</div>
                <div className={cn("font-medium", seg.reviewScore === null ? "text-muted-foreground" : passed ? "text-success" : "text-warning")}>
                  {seg.reviewScore === null ? "-" : passed ? "通过" : "未通过"}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-muted-foreground">修正轮次</div>
                <div className="font-medium tabular-nums">{seg.reviewRounds ?? 0}</div>
              </div>
              <div>
                <div className="text-[11px] text-muted-foreground">状态</div>
                <div className="font-medium">{seg.target === null ? "未翻译" : seg.edited ? "已人工编辑" : "已翻译"}</div>
              </div>
              <div>
                <div className="text-[11px] text-muted-foreground">术语遵循</div>
                <div className="font-medium tabular-nums">
                  {seg.compliance?.length ? `${seg.compliance.filter((c) => c.compliant).length}/${seg.compliance.length}` : "-"}
                </div>
              </div>
            </div>
          </section>
        )}

        {seg.compliance && seg.compliance.length > 0 && (
          <section className="rounded-xl border bg-card p-3">
            <h4 className="mb-2 text-xs font-medium text-muted-foreground">术语遵循</h4>
            <ul className="space-y-1">
              {seg.compliance.map((c) => (
                <li key={c.source} className="flex items-center gap-2 text-xs">
                  <span
                    className={cn(
                      "flex size-4 items-center justify-center rounded-full",
                      c.compliant ? "bg-success-soft text-success" : "bg-danger-soft text-danger",
                    )}
                  >
                    {c.compliant ? <CheckIcon className="size-2.5" /> : <XIcon className="size-2.5" />}
                  </span>
                  <span className="font-medium">{c.source}</span>
                  <span className="text-muted-foreground">→</span>
                  <span className={c.compliant ? "text-foreground" : "text-danger"}>{c.target}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {tmHits.length > 0 && (
          <section className="rounded-xl border bg-card p-3">
            <h4 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <BrainCircuitIcon className="size-3.5 text-brand" />
              翻译记忆
              <span className="font-normal">· 作为参考写入了本块提示词</span>
            </h4>
            <div className="space-y-2">
              {tmHits.map((h) => (
                <TmHitCard key={h.id} hit={h} current={seg.source} compact />
              ))}
            </div>
          </section>
        )}

        {fixes.length > 0 && (
          <section className="rounded-xl border border-warning/30 bg-warning-soft p-3 text-xs">
            <div className="mb-1 flex items-center gap-1.5 font-medium text-warning">
              <SparklesIcon className="size-3.5" />
              一致性检查
            </div>
            {fixes.map((f) => (
              <p key={f.term} className="leading-relaxed text-foreground/80">
                「{f.term}」{f.fixedSegs.includes(seq) ? `已统一为「${f.chosen}」` : `未能自动统一为「${f.chosen}」，建议人工修改`}
              </p>
            ))}
          </section>
        )}

        <section className="space-y-2">
          <h4 className="text-xs font-medium text-muted-foreground">原文</h4>
          <div className="rounded-lg bg-muted/40 p-2.5 text-sm leading-relaxed whitespace-pre-wrap">{renderInline(seg.source)}</div>
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-medium text-muted-foreground">译文</h4>
            {canAct && (
              <Button variant="ghost" size="xs" onClick={() => {
                ws.setEditingSeq(seg.seq);
                ws.locate(seg.seq);
              }}>
                <PencilLineIcon />
                在列表中编辑
              </Button>
            )}
          </div>
          <div className="rounded-lg border p-2.5 text-sm leading-relaxed whitespace-pre-wrap">
            {seg.target ? renderInline(seg.target) : <span className="text-muted-foreground italic">尚无译文</span>}
          </div>
        </section>

        {canAct && (
          <section className="rounded-xl border bg-card p-3 shadow-card">
            <RetranslateBox seg={seg} />
          </section>
        )}
      </FadeIn>
    </div>
  );
}
