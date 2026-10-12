"use client";

import { CheckIcon, CoinsIcon, FlaskConicalIcon, QuoteIcon, ScanSearchIcon, TimerIcon, XIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { NumberTicker } from "@/components/motion/number-ticker";
import { FadeIn } from "@/components/motion/fade-in";
import { useModelOptions } from "@/hooks/use-options";
import type { DocTaskVO } from "@/lib/api/documents";
import { taskReviewLabel } from "@/lib/review-model";
import { langName, styleLabel } from "@/lib/languages";
import { formatTime } from "@/lib/validators";
import { cn } from "@/lib/utils";
import { ProgressRing } from "../bits";
import { OPTION_META, STRATEGY_META, formatChars, formatDuration, normalizeOptions, presetLabel, presetOf } from "../meta";

function Card({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="rounded-xl border bg-card p-3 shadow-card">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-sm">{children}</div>
    </div>
  );
}

/** 概览：摘要、领域、配置、统计与用量 */
export function OverviewPanel({ task }: { task: DocTaskVO }) {
  const options = normalizeOptions(task.options);
  const preset = presetOf(options, task.strategy);
  const models = useModelOptions();
  const translator =
    task.modelConfigId !== null
      ? (models.data?.find((m) => m.id === task.modelConfigId)?.name ?? `模型 #${task.modelConfigId}`)
      : (models.data?.find((m) => m.isDefault)?.name ?? "默认模型");
  const reviewer = taskReviewLabel(options.review, task.reviewModelConfigId, models.data);
  const analyzing = task.status === "PENDING" || task.status === "PARSING" || task.status === "ANALYZING";
  const tokens = (task.promptTokens ?? 0) + (task.completionTokens ?? 0);
  const stats = task.stats;
  const compliance = stats?.compliance;

  return (
    <FadeIn className="space-y-3 px-4 py-3">
      <Card title="全文摘要" aside={task.genre && <span className="rounded bg-muted px-1.5 text-[10px] text-muted-foreground">{task.genre}</span>}>
        {task.summary ? (
          <p className="relative pl-5 text-sm leading-relaxed text-foreground/85">
            <QuoteIcon className="absolute top-0.5 left-0 size-3.5 text-brand/60" />
            {task.summary}
          </p>
        ) : analyzing ? (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-11/12" />
            <Skeleton className="h-3.5 w-2/3" />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {options.globalSummary ? "未生成摘要" : "实验选项关闭了「全文摘要」，本任务不生成摘要。"}
          </p>
        )}
        <div className="mt-3 grid grid-cols-3 gap-3 border-t pt-3">
          <Fact label="领域">{task.domain ?? (analyzing ? "判定中…" : "-")}</Fact>
          <Fact label="识别语种">{task.detectedLang ? langName(task.detectedLang) : task.sourceLang === "auto" ? "识别中…" : langName(task.sourceLang)}</Fact>
          <Fact label="篇幅">{formatChars(task.charCount)}</Fact>
        </div>
      </Card>

      {stats && (
        <Card title="翻译统计">
          <div className="flex items-center gap-4">
            <ProgressRing value={compliance && compliance.total ? compliance.ok / compliance.total : 1} tone="success" size={64}>
              <span className="text-center leading-tight">
                <span className="block text-sm font-semibold tabular-nums">
                  {compliance ? `${compliance.ok}/${compliance.total}` : "-"}
                </span>
                <span className="block text-[9px] text-muted-foreground">术语遵循</span>
              </span>
            </ProgressRing>
            <div className="grid flex-1 grid-cols-3 gap-2 text-center">
              {[
                { label: "分块", value: stats.chunks },
                { label: "缓存命中", value: stats.cachedChunks },
                { label: "评审修正", value: stats.refined },
              ].map((s) => (
                <div key={s.label}>
                  <NumberTicker value={s.value} className="text-lg font-semibold" />
                  <div className="text-[10px] text-muted-foreground">{s.label}</div>
                </div>
              ))}
            </div>
          </div>
        </Card>
      )}

      <Card
        title="配置"
        aside={
          <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium", preset ? "bg-brand-soft text-brand" : "bg-warning-soft text-warning")}>
            <FlaskConicalIcon className="size-3" />
            {presetLabel(preset)}
          </span>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Fact label="语言">
            {langName(task.sourceLang)} → {langName(task.targetLang)}
          </Fact>
          <Fact label="策略">{STRATEGY_META[task.strategy].label}</Fact>
          <Fact label="风格">{styleLabel(task.style)}</Fact>
          <Fact label="术语确认">{task.confirmTerms ? "人工确认" : "自动确认"}</Fact>
          <Fact label="译者模型">{translator}</Fact>
          {reviewer && (
            <Fact label="评审模型">
              <span className="inline-flex max-w-full items-center gap-1 text-info" title={reviewer}>
                <ScanSearchIcon className="size-3.5 shrink-0" />
                <span className="truncate">{reviewer}</span>
              </span>
            </Fact>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5 border-t pt-3">
          {OPTION_META.map((m) => (
            <span
              key={m.key}
              title={m.desc}
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ring-1",
                options[m.key] ? "bg-success-soft text-success ring-success/25" : "bg-muted text-muted-foreground ring-border",
              )}
            >
              {options[m.key] ? <CheckIcon className="size-3" /> : <XIcon className="size-3" />}
              {m.label}
            </span>
          ))}
        </div>
      </Card>

      <Card title="用量与时间">
        <div className="grid grid-cols-2 gap-3">
          <Fact label="Token">
            <span className="inline-flex items-center gap-1 tabular-nums">
              <CoinsIcon className="size-3.5 text-muted-foreground" />
              <NumberTicker value={tokens} />
            </span>
          </Fact>
          <Fact label="耗时">
            <span className="inline-flex items-center gap-1">
              <TimerIcon className="size-3.5 text-muted-foreground" />
              {formatDuration(task.latencyMs)}
            </span>
          </Fact>
          <Fact label="创建">{formatTime(task.createdAt)}</Fact>
          <Fact label="结束">{formatTime(task.finishedAt)}</Fact>
        </div>
      </Card>
    </FadeIn>
  );
}
