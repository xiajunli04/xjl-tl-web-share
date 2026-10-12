"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  LanguagesIcon,
  LightbulbIcon,
  MessagesSquareIcon,
  OctagonPauseIcon,
  QuoteIcon,
  RotateCcwIcon,
  SparklesIcon,
  WandSparklesIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorState } from "@/components/feedback/error-state";
import { StaggerItem } from "@/components/motion/stagger";
import { DURATION, EASE_OUT, SPRING_LAYOUT } from "@/components/motion/tokens";
import { INSIGHTS_QUERY_KEY, QUICK_QUESTIONS, insightsApi, type Alternative, type InsightsRequest } from "@/lib/api/insights";
import type { RunState } from "@/lib/translation-run";
import type { TranslateRequest } from "@/lib/api/translate";
import { cn } from "@/lib/utils";
import { useWorkbenchStore } from "@/stores/workbench";
import { useInsightsChat, type ChatTurn } from "./insights-store";

const REGISTER_STYLE: Record<string, string> = {
  正式: "bg-info-soft text-info ring-info/25",
  中性: "bg-muted text-muted-foreground ring-foreground/10",
  口语: "bg-warning-soft text-warning ring-warning/25",
  书面: "bg-brand-soft text-brand ring-brand/25",
  文学: "bg-success-soft text-success ring-success/25",
};

/** 可折叠分区 */
function Section({
  icon: Icon,
  title,
  count,
  children,
  defaultOpen = true,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  count?: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-xl border bg-card shadow-card">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-medium outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <Icon className="size-4 text-brand" />
        {title}
        {count !== undefined && (
          <span className="rounded-full bg-muted px-1.5 text-[10px] font-normal text-muted-foreground tabular-nums">{count}</span>
        )}
        <motion.span
          animate={{ rotate: open ? 0 : -90 }}
          transition={{ duration: DURATION.fast }}
          className="ml-auto text-muted-foreground"
        >
          <ChevronDownIcon className="size-4" />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: reduce ? DURATION.fast : DURATION.page, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            <div className="border-t px-3 py-3">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

function InsightsSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="正在生成解读">
      <Skeleton className="h-14 w-full rounded-xl" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-2 rounded-xl border p-3">
          <Skeleton className="h-4 w-12 rounded-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      ))}
      <Skeleton className="h-24 w-full rounded-xl" />
    </div>
  );
}

function AlternativeCard({
  alt,
  index,
  adopted,
  onAdopt,
}: {
  alt: Alternative;
  index: number;
  adopted: boolean;
  onAdopt: () => void;
}) {
  const reduce = useReducedMotion();
  return (
    <StaggerItem index={index}>
      <motion.div
        layout={!reduce}
        className={cn(
          "group relative rounded-lg border bg-background/60 p-3 transition-colors",
          adopted ? "border-brand/40 bg-brand-soft/40" : "hover:border-brand/25",
        )}
      >
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[11px] font-medium ring-1",
              REGISTER_STYLE[alt.register] ?? REGISTER_STYLE["中性"],
            )}
          >
            {alt.register}
          </span>
          <div className="ml-auto">
            <AnimatePresence mode="wait" initial={false}>
              {adopted ? (
                <motion.span
                  key="on"
                  layoutId="insights-adopted"
                  initial={{ opacity: 0, scale: reduce ? 1 : 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: DURATION.fast, layout: SPRING_LAYOUT }}
                  className="inline-flex items-center gap-1 rounded-full bg-brand-gradient px-2 py-0.5 text-[11px] font-medium text-brand-foreground"
                >
                  <CheckIcon className="size-3" />
                  已采用
                </motion.span>
              ) : (
                <motion.span key="off" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <Button size="xs" variant="outline" onClick={onAdopt} aria-label={`采用备选译法：${alt.text}`}>
                    <WandSparklesIcon />
                    采用
                  </Button>
                </motion.span>
              )}
            </AnimatePresence>
          </div>
        </div>
        <p className="mt-2 text-sm leading-6 break-words">{alt.text}</p>
        {alt.note && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{alt.note}</p>}
      </motion.div>
    </StaggerItem>
  );
}

function Bubble({ turn }: { turn: ChatTurn }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      layout={!reduce}
      initial={{ opacity: 0, y: reduce ? 0 : 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DURATION.page, ease: EASE_OUT }}
      className="space-y-2"
    >
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-br-md bg-brand-gradient px-3 py-2 text-[13px] leading-relaxed text-brand-foreground">
          {turn.question}
        </p>
      </div>
      <div className="flex gap-2">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand">
          <SparklesIcon className="size-3.5" />
        </span>
        <div
          className={cn(
            "max-w-[88%] rounded-2xl rounded-tl-md border bg-muted/50 px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap",
            turn.status === "error" && "border-danger/30 bg-danger-soft text-danger",
          )}
          aria-live="polite"
        >
          {turn.status === "error" ? (
            turn.error ?? "回答失败"
          ) : turn.answer ? (
            <>
              {turn.answer}
              {turn.status === "streaming" && (
                <span aria-hidden className="ml-0.5 inline-block h-[1em] w-0.5 translate-y-0.5 animate-caret rounded-full bg-brand" />
              )}
              {turn.status === "stopped" && <span className="ml-1 text-xs text-muted-foreground">（已停止）</span>}
            </>
          ) : turn.status === "stopped" ? (
            <span className="text-xs text-muted-foreground">已停止</span>
          ) : (
            <span className="inline-flex gap-1 py-1" aria-label="正在思考">
              {[0, 1, 2].map((i) => (
                <motion.span
                  key={i}
                  className="size-1.5 rounded-full bg-muted-foreground/60"
                  animate={reduce ? undefined : { opacity: [0.3, 1, 0.3] }}
                  transition={{ duration: 1, repeat: Infinity, delay: i * 0.15 }}
                />
              ))}
            </span>
          )}
        </div>
      </div>
    </motion.div>
  );
}

function AskBox({ ctx }: { ctx: Omit<InsightsRequest, "recordId"> }) {
  const turns = useInsightsChat((s) => s.turns);
  const ask = useInsightsChat((s) => s.ask);
  const stop = useInsightsChat((s) => s.stop);
  const [draft, setDraft] = useState("");
  const streaming = turns.some((t) => t.status === "streaming");
  const endRef = useRef<HTMLDivElement>(null);
  const lastAnswerLength = turns.at(-1)?.answer.length ?? 0;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [turns.length, lastAnswerLength]);

  const send = (q: string) => {
    if (!q.trim() || streaming) return;
    setDraft("");
    void ask(ctx, q);
  };

  return (
    <div className="space-y-3">
      {turns.length === 0 ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          针对当前译文提问，回答只做讲解，不会修改译文，也不会保存到历史。
        </p>
      ) : (
        <div className="space-y-3">
          {turns.map((t) => (
            <Bubble key={t.id} turn={t} />
          ))}
          <div ref={endRef} />
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {QUICK_QUESTIONS.map((q) => (
          <button
            key={q}
            type="button"
            disabled={streaming}
            onClick={() => send(q)}
            className="rounded-full border bg-background px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-brand/30 hover:text-brand disabled:pointer-events-none disabled:opacity-50"
          >
            {q}
          </button>
        ))}
      </div>
      <div className="relative">
        <Textarea
          value={draft}
          rows={2}
          maxLength={500}
          placeholder="问点什么，例如：这里的语气是不是太正式了？"
          className="min-h-16 resize-none pr-11 text-[13px]"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send(draft);
            }
          }}
          aria-label="向 Agent 提问"
        />
        {streaming ? (
          <Button type="button" size="icon-sm" variant="secondary" className="absolute right-2 bottom-2" aria-label="停止回答" onClick={stop}>
            <OctagonPauseIcon />
          </Button>
        ) : (
          <Button
            type="button"
            size="icon-sm"
            className="absolute right-2 bottom-2"
            aria-label="发送问题"
            disabled={!draft.trim()}
            onClick={() => send(draft)}
          >
            <ArrowUpIcon />
          </Button>
        )}
      </div>
    </div>
  );
}

/** 「解读」标签页：备选译法（可采用）/ 关键表达 / 问一问 */
export function InsightsPanel({ run }: { run: RunState & { request?: TranslateRequest } }) {
  const reduce = useReducedMotion();
  const adopt = useWorkbenchStore((s) => s.adoptTranslation);
  const ensureKey = useInsightsChat((s) => s.ensureKey);
  const final = run.status === "done" ? run.final : undefined;
  const source = run.request?.text ?? "";
  const original = run.adopted?.original ?? final?.translation ?? "";
  const runKey = run.requestId ?? (final?.recordId != null ? `r${final.recordId}` : null);

  useEffect(() => {
    if (runKey) ensureKey(runKey);
  }, [runKey, ensureKey]);

  const req: InsightsRequest | null =
    final && source.trim() && original.trim()
      ? { source, translation: original, sourceLang: final.sourceLang, targetLang: final.targetLang, recordId: final.recordId ?? null }
      : null;
  const q = useQuery({
    queryKey: [...INSIGHTS_QUERY_KEY, runKey, original],
    queryFn: () => insightsApi.get(req!),
    enabled: !!req,
    staleTime: Infinity,
    retry: false,
  });

  if (!final || !req) {
    return (
      <EmptyState
        compact
        icon={LightbulbIcon}
        title="翻译完成后可查看解读"
        description={
          run.status === "running"
            ? "Agent 正在翻译，完成后这里会给出备选译法、关键表达，并可以针对译文提问。"
            : "解读包括 2–3 个不同语体的备选译法、关键表达的含义，以及针对译文的追问。"
        }
      />
    );
  }
  if (q.isLoading) return <InsightsSkeleton />;
  if (q.isError) return <ErrorState title="解读生成失败" error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} />;
  const data = q.data;
  if (!data) return null;
  const adoptedText = run.adopted?.text ?? null;

  const onAdopt = (alt: Alternative) => {
    if (adopt(alt.text)) toast.success("已采用备选译法", { description: "译文区已替换，复制将使用新译文" });
  };
  const onRestore = () => {
    if (adopt(null)) toast.info("已恢复原译文");
  };

  return (
    <div className="space-y-3">
      <AnimatePresence initial={false}>
        {adoptedText && (
          <motion.div
            key="adopted"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: reduce ? DURATION.fast : DURATION.page, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            <div role="status" className="flex items-center gap-2 rounded-lg border border-brand/30 bg-brand-soft/50 px-3 py-2 text-xs">
              <CheckIcon className="size-3.5 text-brand" />
              <span className="font-medium text-brand">已采用备选</span>
              <span className="truncate text-muted-foreground">译文区已替换</span>
              <Button size="xs" variant="ghost" className="ml-auto" onClick={onRestore}>
                <RotateCcwIcon />
                恢复原译
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {data.summary && (
        <motion.div
          initial={{ opacity: 0, y: reduce ? 0 : 4 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex gap-2.5 rounded-xl bg-linear-to-br from-brand-soft to-transparent px-3 py-2.5 text-[13px] leading-relaxed"
        >
          <QuoteIcon className="mt-0.5 size-3.5 shrink-0 text-brand" />
          {data.summary}
        </motion.div>
      )}

      <Section icon={LanguagesIcon} title="备选译法" count={data.alternatives.length}>
        {data.alternatives.length ? (
          <div className="space-y-2">
            {data.alternatives.map((a, i) => (
              <AlternativeCard key={a.text} alt={a} index={i} adopted={adoptedText === a.text} onAdopt={() => onAdopt(a)} />
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">当前译文已经很贴切，没有给出备选。</p>
        )}
      </Section>

      <Section icon={LightbulbIcon} title="关键表达" count={data.expressions.length}>
        {data.expressions.length ? (
          <ul className="space-y-2.5">
            {data.expressions.map((x, i) => (
              <StaggerItem key={`${x.source}-${i}`} index={i}>
                <li className="rounded-lg bg-muted/40 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
                    <span className="font-medium">{x.source}</span>
                    <span className="text-muted-foreground">→</span>
                    <span className="font-medium text-brand">{x.target}</span>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-foreground/80">{x.meaning}</p>
                  {x.note && <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{x.note}</p>}
                </li>
              </StaggerItem>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">没有需要特别说明的表达。</p>
        )}
      </Section>

      <Section icon={MessagesSquareIcon} title="问一问">
        <AskBox ctx={{ source: req.source, translation: run.final?.translation ?? original, sourceLang: req.sourceLang, targetLang: req.targetLang }} />
      </Section>
    </div>
  );
}
