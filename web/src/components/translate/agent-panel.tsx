"use client";

import { motion, useReducedMotion } from "motion/react";
import { BotIcon, BrainCircuitIcon, MessageCircleQuestionIcon, PanelRightCloseIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AgentTimeline, type TimelineItem, type TimelineStatus } from "@/components/agent/agent-timeline";
import { InsightsPanel } from "@/components/agent/insights-panel";
import { ReviewPanel } from "@/components/agent/review-panel";
import { TermsPanel } from "@/components/agent/terms-panel";
import { EmptyState } from "@/components/feedback/empty-state";
import { TmHitCard } from "@/components/memory/tm-hit";
import { StaggerItem } from "@/components/motion/stagger";
import { formatMs } from "@/components/agent/node-meta";
import { SPRING_LAYOUT } from "@/components/motion/tokens";
import { useElapsed } from "@/hooks/use-elapsed";
import { useGlossaryOptions, useLanguages } from "@/hooks/use-options";
import { langName, pathLabel } from "@/lib/languages";
import { AGENT_NODES, tmHitsOf, type RunState } from "@/lib/translation-run";
import type { Language, ReviewEventData, TmHit, TranslateRequest } from "@/lib/api/translate";
import { cn } from "@/lib/utils";

export const AGENT_PANEL_WIDTH = 380;

/** 把运行状态映射为时间线：已发生的节点 + 尚未到达的规范节点占位 */
export function timelineFromRun(run: RunState, languages?: Language[]): TimelineItem[] {
  const terminal: TimelineStatus | null =
    run.status === "stopped" ? "stopped" : run.status === "error" ? "error" : null;
  const items: TimelineItem[] = run.nodes.map((n) => {
    let extra: React.ReactNode;
    if (n.node === "analyze" && (run.detect || run.terms)) {
      extra = (
        <div className="flex flex-wrap gap-1.5 text-[11px]">
          {run.detect && (
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-muted-foreground">
              {langName(run.detect.lang, languages)} · {Math.round(run.detect.confidence * 100)}% · {run.detect.method}
            </span>
          )}
          {run.terms && (
            <span className="rounded-md bg-brand-soft px-1.5 py-0.5 text-brand">
              命中 {run.terms.hits.length} 条术语
            </span>
          )}
        </div>
      );
    }
    if (n.node === "retrieve" && n.status === "completed" && n.detail) {
      const turns = typeof n.detail.sessionTurns === "number" ? n.detail.sessionTurns : undefined;
      const tm = Array.isArray(n.detail.tmHits) ? n.detail.tmHits.length : undefined;
      if (turns || tm !== undefined) {
        extra = (
          <div className="flex flex-wrap gap-1.5 text-[11px]">
            {!!turns && (
              <span className="rounded-md bg-info-soft px-1.5 py-0.5 text-info">会话上下文 {turns} 轮</span>
            )}
            {tm !== undefined && (
              <span className={cn("rounded-md px-1.5 py-0.5", tm ? "bg-brand-soft text-brand" : "bg-muted text-muted-foreground")}>
                {tm ? `翻译记忆 ${tm} 条` : "未命中翻译记忆"}
              </span>
            )}
          </div>
        );
      }
    }
    if (n.node === "clarify" && run.clarify) {
      extra = (
        <div className="rounded-lg border border-warning/30 bg-warning-soft/60 px-2.5 py-2 text-xs">
          <div className="flex items-start gap-1.5">
            <MessageCircleQuestionIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
            <span className="leading-relaxed">{run.clarify.question}</span>
          </div>
          {run.clarify.answer && (
            <div className="mt-1 pl-5 text-muted-foreground">
              回答：<span className="font-medium text-foreground">{run.clarify.answer}</span>
            </div>
          )}
        </div>
      );
    }
    if (n.node === "plan" && run.plan) {
      extra = (
        <div className="rounded-lg border bg-card px-2.5 py-2 text-xs shadow-card">
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                "rounded-md px-1.5 py-0.5 text-[11px] font-medium",
                run.plan.path === "standard"
                  ? "bg-brand-gradient text-brand-foreground"
                  : run.plan.path === "revise"
                    ? "bg-warning-soft text-warning"
                    : "bg-info-soft text-info",
              )}
            >
              {pathLabel(run.plan.path)}
            </span>
            <span className="text-muted-foreground">领域：{run.plan.domain}</span>
          </div>
          <p className="mt-1.5 leading-relaxed text-foreground/80">{run.plan.reason}</p>
        </div>
      );
    }
    return {
      key: n.key,
      node: n.node,
      status: n.status === "running" && terminal ? terminal : n.status,
      summary: n.summary,
      latencyMs: n.latencyMs,
      tokens: n.usage ? n.usage.promptTokens + n.usage.completionTokens : undefined,
      extra,
    };
  });
  // 规范节点占位：只补在最后一个已发生的规范节点之后（clarify / memorize 不在规范顺序中）
  const lastIdx = run.nodes.reduce((m, n) => Math.max(m, AGENT_NODES.indexOf(n.node)), -1);
  if (run.status !== "done") {
    for (const node of AGENT_NODES.slice(lastIdx + 1)) {
      items.push({ key: `pending-${node}`, node, status: "pending" });
    }
  }
  return items;
}

function StatusLine({ run }: { run: RunState }) {
  const elapsed = useElapsed(run.startedAt, run.finishedAt, run.status === "running");
  const map: Record<RunState["status"], { text: string; cls: string }> = {
    idle: { text: "等待开始", cls: "bg-muted-foreground/40" },
    running: { text: "运行中", cls: "bg-brand animate-breathe text-brand" },
    done: { text: "已完成", cls: "bg-success" },
    stopped: { text: "已停止", cls: "bg-warning" },
    error: { text: "出错", cls: "bg-danger" },
    clarify: { text: "等待澄清", cls: "bg-warning animate-breathe" },
  };
  const s = map[run.status];
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className={cn("size-1.5 rounded-full", s.cls)} />
      <span className="text-foreground">{s.text}</span>
      {run.status !== "idle" && <span className="tabular-nums">· {formatMs(elapsed)}</span>}
      {run.plan && <span>· {pathLabel(run.plan.path)}</span>}
    </div>
  );
}

/** 「记忆」标签页：本次命中的翻译记忆（匹配度徽章 + 与当前原文的差异高亮 + 来源） */
function MemoryPanel({ hits, current, run }: { hits: TmHit[]; current?: string; run: RunState }) {
  if (!hits.length) {
    const path = run.plan?.path;
    const title =
      run.status === "idle"
        ? "暂无记忆命中"
        : path === "fast"
          ? "快速路径不检索翻译记忆"
          : path === "revise"
            ? "修订路径不检索翻译记忆"
            : run.status === "running"
              ? "等待检索…"
              : "没有命中翻译记忆";
    return (
      <EmptyState
        compact
        icon={BrainCircuitIcon}
        title={title}
        description="对满意的译文点「存入记忆」，之后翻译相似句子时会在这里看到参考译法。"
      />
    );
  }
  return (
    <div className="space-y-2.5">
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        高亮为记忆原文与当前原文不同的部分；记忆作为参考写入提示词，不要求照抄。
      </p>
      {hits.map((h, i) => (
        <StaggerItem key={h.id} index={i}>
          <TmHitCard hit={h} current={current} />
        </StaggerItem>
      ))}
    </div>
  );
}

/** Agent 面板内容：头部状态 + 时间线 / 评审 / 术语 / 记忆四个标签页 */
export function AgentPanelBody({
  run,
  onClose,
  tab,
  onTabChange,
}: {
  run: RunState & { request?: TranslateRequest };
  onClose?: () => void;
  tab: string;
  onTabChange: (t: string) => void;
}) {
  const languages = useLanguages();
  const glossaries = useGlossaryOptions();
  const glossaryName = (id: number) => glossaries.data?.find((g) => g.id === id)?.name;
  const reviews = run.rounds.map((r) => r.review).filter((r): r is ReviewEventData => !!r);
  const items = timelineFromRun(run, languages);
  const hits = run.terms?.hits ?? [];
  const tmHits = tmHitsOf(run);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b px-4 pr-12 xl:pr-4">
        <span className="flex size-8 items-center justify-center rounded-lg bg-brand-soft text-brand">
          <BotIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">Agent</div>
          <StatusLine run={run} />
        </div>
        {onClose && (
          <Button variant="ghost" size="icon-sm" aria-label="收起 Agent 面板" onClick={onClose}>
            <PanelRightCloseIcon />
          </Button>
        )}
      </div>
      <Tabs value={tab} onValueChange={(v) => onTabChange(String(v))} className="min-h-0 flex-1 gap-0">
        <div className="px-4 pt-3">
          <TabsList className="w-full">
            <TabsTrigger value="timeline">时间线</TabsTrigger>
            <TabsTrigger value="review">
              评审
              {reviews.length > 0 && (
                <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums">{reviews.length}</span>
              )}
            </TabsTrigger>
            <TabsTrigger value="terms">
              术语
              {hits.length > 0 && (
                <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums">{hits.length}</span>
              )}
            </TabsTrigger>
            <TabsTrigger value="memory">
              记忆
              {tmHits.length > 0 && (
                <span className="rounded-full bg-brand-soft px-1.5 text-[10px] text-brand tabular-nums">{tmHits.length}</span>
              )}
            </TabsTrigger>
            <TabsTrigger value="insights" title="备选译法、关键表达与追问">
              解读
              {run.adopted?.text && <span aria-label="已采用备选" className="size-1.5 rounded-full bg-brand" />}
            </TabsTrigger>
          </TabsList>
        </div>
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <TabsContent value="timeline">
            {run.status === "idle" && (
              <p className="mb-4 rounded-lg bg-muted/60 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                点击「翻译」后，Agent 会依次执行以下节点。快速路径会跳过检索、评审与修正。
              </p>
            )}

            <AgentTimeline items={items} />
          </TabsContent>
          <TabsContent value="review">
            <ReviewPanel
              reviews={reviews}
              emptyTitle={run.plan?.path === "fast" ? "快速路径不评审" : "暂无评审"}
            />
          </TabsContent>
          <TabsContent value="terms">
            <TermsPanel
              hits={hits}
              compliance={run.final?.compliance}
              skippedGlossaries={run.terms?.skippedGlossaries}
              glossaryName={glossaryName}
              pending={run.status === "running"}
            />
          </TabsContent>
          <TabsContent value="memory">
            <MemoryPanel hits={tmHits} current={run.request?.text} run={run} />
          </TabsContent>
          <TabsContent value="insights">
            <InsightsPanel run={run} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

/** 宽屏下的可收起侧栏（宽度弹簧动画） */
export function AgentPanel({
  open,
  children,
}: {
  open: boolean;
  children: React.ReactNode;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.aside
      initial={false}
      animate={{ width: open ? AGENT_PANEL_WIDTH : 0, opacity: open ? 1 : 0 }}
      transition={reduce ? { duration: 0.15 } : SPRING_LAYOUT}
      className="shrink-0 overflow-hidden border-l bg-surface"
      aria-hidden={!open}
      inert={!open}
    >
      <div className="h-full" style={{ width: AGENT_PANEL_WIDTH }}>
        {children}
      </div>
    </motion.aside>
  );
}
