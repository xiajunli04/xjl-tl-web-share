"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  BookmarkCheckIcon,
  BookmarkIcon,
  CoinsIcon,
  LanguagesIcon,
  Loader2Icon,
  MessageCircleQuestionIcon,
  OctagonPauseIcon,
  RouteIcon,
  StarIcon,
  TimerIcon,
  XCircleIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CopyButton } from "@/components/feedback/copy-button";
import { ErrorState } from "@/components/feedback/error-state";
import { HighlightedText } from "@/components/agent/highlighted-text";
import { ScoreBadge } from "@/components/agent/score-ring";
import { formatMs, formatTokens } from "@/components/agent/node-meta";
import { DURATION, EASE_OUT } from "@/components/motion/tokens";
import { ApiError } from "@/lib/http";
import { HISTORY_QUERY_KEY, historyApi } from "@/lib/api/history";
import { TM_QUERY_KEY, tmApi } from "@/lib/api/tm";
import { toastError } from "@/lib/errors";
import { pathLabel } from "@/lib/languages";
import { currentRound, currentTranslation, latestReview, type RunStore } from "@/lib/translation-run";
import { cn } from "@/lib/utils";
import { useWorkbenchStore } from "@/stores/workbench";
import { useAutoRead } from "@/hooks/use-speak";
import { SpeakButton } from "./speak-button";

/** 流式文本：最新到达的片段淡入，末尾闪烁光标 */
export function StreamingText({ text, streaming }: { text: string; streaming: boolean }) {
  // 派生状态：记录上一次渲染时的文本，新增部分单独淡入
  const [seen, setSeen] = useState({ text: "", stable: 0 });
  if (seen.text !== text) {
    setSeen({ text, stable: text.startsWith(seen.text) ? seen.text.length : 0 });
  }
  const stable = Math.min(seen.stable, text.length);
  return (
    <>
      {text.slice(0, stable)}
      <motion.span
        key={stable}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.25 }}
      >
        {text.slice(stable)}
      </motion.span>
      {streaming && (
        <span
          aria-hidden
          className="ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[3px] animate-caret rounded-full bg-brand"
        />
      )}
    </>
  );
}

function FavoriteButton({ recordId }: { recordId: number }) {
  const qc = useQueryClient();
  // 以 recordId 为键的本地收藏状态（新的翻译完成后自然重置）
  const [fav, setFav] = useState<{ id: number; on: boolean }>({ id: recordId, on: false });
  const on = fav.id === recordId && fav.on;
  const [pending, setPending] = useState(false);
  const toggle = async () => {
    setPending(true);
    try {
      await historyApi.favorite(recordId, !on);
      setFav({ id: recordId, on: !on });
      toast.success(on ? "已取消收藏" : "已收藏");
      void qc.invalidateQueries({ queryKey: HISTORY_QUERY_KEY });
    } catch (e) {
      toastError(e);
    } finally {
      setPending(false);
    }
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={on ? "取消收藏" : "收藏"}
            aria-pressed={on}
            disabled={pending}
            onClick={toggle}
          />
        }
      >
        <motion.span
          key={String(on)}
          initial={{ scale: 0.6 }}
          animate={{ scale: 1 }}
          transition={{ type: "spring", stiffness: 500, damping: 18 }}
          className="inline-flex"
        >
          <StarIcon className={cn(on && "fill-warning text-warning")} />
        </motion.span>
      </TooltipTrigger>
      <TooltipContent>{on ? "取消收藏" : "收藏到历史"}</TooltipContent>
    </Tooltip>
  );
}

/** 「存入记忆」：存入后图标从描边变为实心并弹跳一次，按钮变为"已存入" */
export function SaveToMemoryButton({
  recordId,
  compact,
  targetText,
}: {
  recordId: number;
  compact?: boolean;
  /** 采用了备选译法时传入替换后的译文 */
  targetText?: string;
}) {
  const qc = useQueryClient();
  const reduce = useReducedMotion();
  // 以 recordId 为键的本地状态（新的翻译完成后自然重置）
  const [saved, setSaved] = useState<{ id: number; on: boolean }>({ id: recordId, on: false });
  const on = saved.id === recordId && saved.on;
  const [pending, setPending] = useState(false);
  const save = async () => {
    if (on || pending) return;
    setPending(true);
    try {
      await tmApi.fromRecord(recordId, targetText);
      setSaved({ id: recordId, on: true });
      toast.success("已存入翻译记忆", { description: "之后翻译相似句子时会作为参考译法" });
      void qc.invalidateQueries({ queryKey: TM_QUERY_KEY });
    } catch (e) {
      toastError(e);
    } finally {
      setPending(false);
    }
  };
  const Icon = on ? BookmarkCheckIcon : BookmarkIcon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={on ? "secondary" : "ghost"}
            size={on && !compact ? "xs" : "icon-sm"}
            aria-label={on ? "已存入记忆" : "存入记忆"}
            aria-pressed={on}
            disabled={pending}
            onClick={save}
            className={cn(on && "text-brand")}
          />
        }
      >
        {pending ? (
          <Loader2Icon className="animate-spin" />
        ) : (
          <motion.span
            key={String(on)}
            initial={{ scale: on && !reduce ? 0.5 : 1 }}
            animate={{ scale: 1 }}
            transition={{ type: "spring", stiffness: 520, damping: 14 }}
            className="inline-flex"
          >
            <Icon className={cn(on && "fill-brand/20")} />
          </motion.span>
        )}
        {on && !compact && "已存入"}
      </TooltipTrigger>
      <TooltipContent>{on ? "已存入翻译记忆" : "把这条译文存入翻译记忆"}</TooltipContent>
    </Tooltip>
  );
}

/** 译文区：流式光标、修正轮次切换、术语高亮、评分 / 耗时 / token、复制收藏、停止与错误重试 */
export function TargetPanel({
  run,
  onRetry,
  onStop,
  top,
}: {
  run: RunStore;
  onRetry: () => void;
  onStop: () => void;
  /** 译文区顶部插槽（会话模式的追问卡片） */
  top?: React.ReactNode;
}) {
  const reduce = useReducedMotion();
  const text = currentTranslation(run);
  const round = currentRound(run);
  const review = latestReview(run);
  const running = run.status === "running";
  const streamingNode = run.nodes.at(-1);
  const streaming =
    running && !!streamingNode && streamingNode.status === "running" &&
    (streamingNode.node === "translate" || streamingNode.node === "refine");
  const terms = run.terms?.hits ?? [];
  const nonCompliant = run.final?.compliance.filter((c) => !c.compliant) ?? [];
  const compliantTerms = run.final
    ? terms.filter((t) => !nonCompliant.some((n) => n.source === t.source))
    : [];
  const usage = run.final?.usage;
  const storeTarget = useWorkbenchStore((s) => s.targetLang);
  const targetLang = run.request?.targetLang ?? storeTarget;
  useAutoRead({
    scope: "single",
    doneKey: run.status === "done" && run.finishedAt ? String(run.finishedAt) : null,
    id: "workbench:target",
    text,
    lang: targetLang,
  });

  return (
    <div className="flex min-h-72 flex-col bg-surface/40 lg:min-h-0">
      <div className="flex h-11 shrink-0 items-center gap-2 px-5">
        <span className="text-xs font-medium tracking-wide text-muted-foreground">译文</span>
        <AnimatePresence>
          {round > 0 && (
            <motion.span
              key={round}
              initial={{ opacity: 0, y: reduce ? 0 : -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-brand"
            >
              第 {round} 轮修正
            </motion.span>
          )}
        </AnimatePresence>
        {running && (
          <Button variant="ghost" size="xs" className="ml-auto text-muted-foreground" onClick={onStop}>
            <OctagonPauseIcon />
            停止
          </Button>
        )}
      </div>

      <div className="scrollbar-thin relative min-h-0 flex-1 overflow-y-auto px-5 pb-4">
        {top}
        <AnimatePresence mode="wait" initial={false}>
          {run.status === "clarify" ? (
            <motion.div
              key="clarify"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex items-center gap-2 py-6 text-sm text-muted-foreground"
            >
              <MessageCircleQuestionIcon className="size-4 text-warning" />
              回答追问后，Agent 会从断点继续翻译
            </motion.div>
          ) : run.status === "error" && run.error ? (
            <motion.div key="error" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <ErrorState
                title="翻译失败"
                error={new ApiError(run.error.code, run.error.message, run.error.traceId)}
                onRetry={onRetry}
              />
              {text && (
                <p className="mt-2 border-t pt-3 text-sm whitespace-pre-wrap text-muted-foreground">
                  {text}
                </p>
              )}
            </motion.div>
          ) : run.status === "idle" || (!text && !running && run.status !== "stopped") ? (
            <motion.div
              key="idle"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex h-full min-h-48 flex-col items-center justify-center gap-3 text-center"
            >
              <span className="flex size-11 items-center justify-center rounded-2xl border bg-card text-muted-foreground shadow-card">
                <LanguagesIcon className="size-5" />
              </span>
              <div>
                <p className="text-sm font-medium">译文将在这里逐字出现</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Agent 会先分析与规划，再翻译、评审并按需修正
                </p>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key={`round-${round}-${run.adopted?.seq ?? 0}`}
              initial={{ opacity: 0, y: reduce ? 0 : 6, filter: reduce ? "none" : "blur(2px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: reduce ? 0 : -6, filter: reduce ? "none" : "blur(2px)" }}
              transition={{ duration: DURATION.page, ease: EASE_OUT }}
              className={cn(
                "text-[15px] leading-7 break-words whitespace-pre-wrap",
                run.status === "stopped" && "text-muted-foreground",
              )}
              aria-live="polite"
            >
              {run.final ? (
                <HighlightedText text={text} terms={compliantTerms} />
              ) : text ? (
                <StreamingText text={text} streaming={streaming} />
              ) : (
                <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                  <span className="inline-block h-[1.1em] w-[2px] animate-caret rounded-full bg-brand" />
                  {run.status === "stopped" ? "已停止" : "Agent 正在分析与规划…"}
                </span>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {nonCompliant.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mt-4 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-xs"
            >
              <div className="mb-1 flex items-center gap-1.5 font-medium text-danger">
                <XCircleIcon className="size-3.5" />
                {nonCompliant.length} 条术语未遵循
              </div>
              <div className="flex flex-wrap gap-1.5">
                {nonCompliant.map((c) => (
                  <span key={c.source} className="rounded bg-background/60 px-1.5 py-0.5 text-danger">
                    {c.source} → {c.target}
                  </span>
                ))}
              </div>
            </motion.div>
          )}
          {run.status === "stopped" && (
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="mt-4 flex items-center gap-1.5 text-xs text-warning"
            >
              <OctagonPauseIcon className="size-3.5" />
              已停止，本次翻译不会写入历史
            </motion.p>
          )}
        </AnimatePresence>
      </div>

      <div className="flex h-14 shrink-0 items-center gap-2 border-t px-4 text-xs text-muted-foreground">
        <AnimatePresence initial={false}>
          {review && <ScoreBadge key="score" score={review.score} passed={review.passed} />}
          {run.final && (
            <motion.div
              key="meta"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex min-w-0 items-center gap-3 overflow-hidden whitespace-nowrap tabular-nums"
            >
              <span className="hidden items-center gap-1 min-[1800px]:inline-flex">
                <RouteIcon className="size-3.5" />
                {pathLabel(run.final.path)}
              </span>
              <span className="inline-flex items-center gap-1">
                <TimerIcon className="size-3.5" />
                {formatMs(run.final.latencyMs)}
              </span>
              {usage && (
                <span className="hidden items-center gap-1 min-[1500px]:inline-flex">
                  <CoinsIcon className="size-3.5" />
                  {formatTokens(usage.promptTokens + usage.completionTokens)} tokens
                </span>
              )}
            </motion.div>
          )}
        </AnimatePresence>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {targetLang && (
            <SpeakButton
              id="workbench:target"
              text={text}
              lang={targetLang}
              label="朗读译文"
              disabledReason={running ? "译文完成后可朗读" : !text ? "翻译后可朗读译文" : undefined}
            />
          )}
          {text && run.status !== "running" && <CopyButton text={text} label="复制译文" />}
          {run.final?.recordId != null && (
            <SaveToMemoryButton
              recordId={run.final.recordId}
              targetText={run.adopted ? run.final.translation : undefined}
            />
          )}
          {run.final?.recordId != null && <FavoriteButton recordId={run.final.recordId} />}
        </div>
      </div>
    </div>
  );
}
