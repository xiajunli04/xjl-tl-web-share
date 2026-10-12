"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronUpIcon, HistoryIcon, SparklesIcon } from "lucide-react";
import { DURATION, EASE_OUT } from "@/components/motion";
import { normLang } from "@/lib/interpret/protocol";
import { isDisplayable, liveState, textIn, type Utterance } from "@/lib/interpret/reducer";
import { langName } from "@/lib/languages";
import { cn } from "@/lib/utils";
import { ReplayButton, SpeakingBars, useUtteranceSpeaking } from "./replay-button";
import { useInterpretStore } from "@/stores/interpret-store";
import { ControlBar } from "./control-bar";
import { ListeningIndicator, useLocalListening } from "./listening-indicator";
import { langShort } from "./meta";
import { StreamingText } from "./streaming-text";

function offset(ms?: number) {
  if (ms === undefined) return "";
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** 收听模式：舞台大字幕（原文小字 partial 透明度过渡、译文定稿上移淡入）+ 可折叠历史字幕 + 控制条 */
export function ListenStage() {
  const reduce = useReducedMotion();
  const utterances = useInterpretStore((s) => s.live.utterances);
  const target = useInterpretStore((s) => s.join?.languages[0] ?? "zh");
  const [historyOpen, setHistoryOpen] = useState(false);

  // 舞台：最近一句有目标语文本的句子；原文行：最近一句有文字的句子（可能仍在识别）。
  // 没有任何文字的语句（只有指标等）不参与显示，避免出现孤立光标（improve-speech-endpointing-and-live-ux D9）
  const latest = useMemo(() => [...utterances].reverse().find((u) => isDisplayable(u)), [utterances]);
  const listening = useLocalListening();
  const stage = useMemo(() => {
    for (let i = utterances.length - 1; i >= 0; i--) if (textIn(utterances[i], target).text) return utterances[i];
    return undefined;
  }, [utterances, target]);
  const history = useMemo(() => utterances.filter((u) => u !== stage && u.sourceFinal), [utterances, stage]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden px-6 py-10">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(50%_60%_at_50%_45%,var(--color-brand-soft),transparent_75%)]" />
        {!latest && listening ? (
          <ListeningIndicator align="center" className="relative" />
        ) : !latest ? (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="relative flex flex-col items-center gap-3 text-center">
            <span className="flex size-12 items-center justify-center rounded-2xl border bg-card text-brand shadow-card">
              <SparklesIcon className="size-5" />
            </span>
            <p className="text-lg font-medium">开始说话，译文会以大字幕显示在这里</p>
            <p className="text-sm text-muted-foreground">自动识别说话语种，翻译为{langName(target)}并播报</p>
          </motion.div>
        ) : (
          <div className="relative w-full max-w-4xl text-center">
            {/* 原文行：partial 更新做细微透明度过渡 */}
            <div className="mb-5 flex min-h-7 items-center justify-center gap-2">
              {latest.lang && (
                <span className="rounded-full border bg-card px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">{langShort(normLang(latest.lang) ?? latest.lang)}</span>
              )}
              <motion.p
                key={latest.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: latest.sourceFinal ? 0.9 : 0.75 }}
                transition={{ duration: DURATION.page }}
                className="text-base text-muted-foreground md:text-lg"
              >
                <StreamingText text={latest.source} mark={liveState(latest)} />
              </motion.p>
            </div>
            <AnimatePresence initial={false}>
              {listening && latest.sourceFinal && <ListeningIndicator key="listening" align="center" className="mb-4" />}
            </AnimatePresence>
            <div className="relative min-h-[7.5rem]">
              <AnimatePresence mode="popLayout" initial={false}>
                {stage && <StageText key={stage.id} u={stage} lang={target} reduce={!!reduce} />}
              </AnimatePresence>
            </div>
          </div>
        )}
      </div>

      {/* 历史字幕：可折叠 */}
      <div className="border-t bg-surface/60">
        <button
          type="button"
          onClick={() => setHistoryOpen((o) => !o)}
          aria-expanded={historyOpen}
          className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground md:px-6"
        >
          <HistoryIcon className="size-3.5" />
          历史字幕
          <span className="rounded-full bg-muted px-1.5 tabular-nums">{history.length}</span>
          <ChevronUpIcon className={cn("ml-auto size-4 transition-transform duration-200", !historyOpen && "rotate-180")} />
        </button>
        <AnimatePresence initial={false}>
          {historyOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: DURATION.page, ease: EASE_OUT }}
              className="overflow-hidden"
            >
              <HistoryList items={history} lang={target} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <ControlBar lang={target} />
    </div>
  );
}

function StageText({ u, lang, reduce }: { u: Utterance; lang: string; reduce: boolean }) {
  const t = textIn(u, lang);
  return (
    <motion.p
      layout="position"
      initial={{ opacity: 0, y: reduce ? 0 : 18 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: reduce ? 0 : -18 }}
      transition={{ duration: DURATION.page + 0.08, ease: EASE_OUT }}
      className="text-3xl leading-tight font-semibold tracking-tight text-balance md:text-[2.75rem]"
      aria-live="polite"
    >
      <StreamingText text={t.text} mark={liveState(u, lang)} />
    </motion.p>
  );
}

/** 历史字幕行：播报中的声波条与重播按钮（improve-speech-playback-latency 8.4） */
function HistoryAudio({ id, text, lang }: { id: string; text: string; lang: string | null }) {
  const speaking = useUtteranceSpeaking(id);
  return (
    <span className="flex h-6 items-center gap-1.5">
      {speaking && <SpeakingBars />}
      <ReplayButton utteranceId={id} text={text} lang={lang} />
    </span>
  );
}

function HistoryList({ items, lang }: { items: Utterance[]; lang: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [items.length]);
  if (!items.length) return <p className="px-6 pb-4 text-xs text-muted-foreground">暂时还没有更早的字幕</p>;
  return (
    <div ref={ref} className="scrollbar-thin max-h-56 space-y-1 overflow-y-auto px-4 pb-3 md:px-6">
      {items.map((u) => {
        const t = textIn(u, lang);
        return (
          <motion.div
            key={u.id}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="group grid grid-cols-[3rem_minmax(0,1fr)_auto] items-start gap-3 rounded-lg px-2 py-2 hover:bg-muted/50"
          >
            <span className="pt-0.5 text-[11px] text-muted-foreground tabular-nums">{offset(u.startedMs)}</span>
            <div className="min-w-0">
              <p className="text-sm font-medium">{t.text || u.source}</p>
              {!t.isSource && <p className="mt-0.5 text-xs text-muted-foreground">{u.source}</p>}
            </div>
            <HistoryAudio id={u.id} text={t.text || u.source} lang={t.isSource ? u.lang : lang} />
          </motion.div>
        );
      })}
    </div>
  );
}
