"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { RotateCcwIcon, SquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { interpretRuntime, replayId } from "@/hooks/use-interpret-socket";
import { useSpeakPhase } from "@/hooks/use-speak";
import { stopSpeaking } from "@/lib/audio/speak";
import { cn } from "@/lib/utils";
import { useInterpretStore } from "@/stores/interpret-store";

/** 播报中的细声波条（实时播报或重播时显示在对应气泡上） */
export function SpeakingBars({ className }: { className?: string }) {
  const reduce = useReducedMotion();
  return (
    <span className={cn("inline-flex h-3 items-end gap-[2px] text-brand", className)} aria-label="播报中">
      {[0, 1, 2, 3].map((i) =>
        reduce ? (
          <span key={i} className="h-2 w-[2px] rounded-full bg-current" />
        ) : (
          <motion.span
            key={i}
            className="h-3 w-[2px] origin-bottom rounded-full bg-current"
            animate={{ scaleY: [0.35, 1, 0.5, 0.8, 0.35] }}
            transition={{ duration: 1, repeat: Infinity, ease: "easeInOut", delay: i * 0.13 }}
          />
        ),
      )}
    </span>
  );
}

/** 该句是否正在实时播报或重播 */
export function useUtteranceSpeaking(utteranceId: string) {
  const live = useInterpretStore((s) => s.speakingId === utteranceId);
  const replay = useSpeakPhase(replayId(utteranceId)) !== "idle";
  return live || replay;
}

/**
 * 字幕重播按钮（improve-speech-playback-latency 8.4）：用流式朗读以该句语言重读该句；
 * 与实时播报互斥（重播时实时播报暂停，结束后继续）。默认悬停 / 聚焦时显示（触屏常显），重播中常显。
 */
export function ReplayButton({
  utteranceId,
  text,
  lang,
  className,
}: {
  utteranceId: string;
  text: string;
  lang: string | null | undefined;
  className?: string;
}) {
  const phase = useSpeakPhase(replayId(utteranceId));
  const active = phase !== "idle";
  if (!text.trim() || !lang) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={active ? "停止重播" : "重播"}
            aria-pressed={active}
            onClick={() => (active ? stopSpeaking() : interpretRuntime.replay(utteranceId, text, lang))}
            className={cn(
              "text-muted-foreground transition-opacity hover:text-foreground",
              active
                ? "text-brand opacity-100"
                : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100",
              className,
            )}
          />
        }
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={active ? "stop" : "replay"}
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.85 }}
            transition={{ duration: 0.15 }}
            className="flex"
          >
            {active ? <SquareIcon className="size-3" /> : <RotateCcwIcon className="size-3.5" />}
          </motion.span>
        </AnimatePresence>
      </TooltipTrigger>
      <TooltipContent>{active ? "停止重播" : "重播这一句"}</TooltipContent>
    </Tooltip>
  );
}

const SENTENCE = /[^。！？!?.…]+[。！？!?.…]+["'”’）)」』]*\s*|[^。！？!?.…]+$/g;

/** 逐句淡入的字幕：新追加的句子淡入并上移 4 px（字幕按句追加，见 D5） */
export function SentenceFade({ text }: { text: string }) {
  const reduce = useReducedMotion();
  const pieces = text.match(SENTENCE) ?? [text];
  return (
    <>
      {pieces.map((p, i) => (
        <motion.span
          key={i}
          initial={{ opacity: 0, y: reduce ? 0 : 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22 }}
          className="inline-block whitespace-pre-wrap"
        >
          {p}
        </motion.span>
      ))}
    </>
  );
}
