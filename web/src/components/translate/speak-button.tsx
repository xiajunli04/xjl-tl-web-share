"use client";

import { useId } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronDownIcon, Volume2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Segmented } from "@/components/ui/segmented";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSpeakLevel, useSpeakPhase } from "@/hooks/use-speak";
import { speak, stopSpeaking } from "@/lib/audio/speak";
import { cn } from "@/lib/utils";
import { SPEECH_RATES, useSpeechPrefs, type SpeechGender, type SpeechRate } from "@/stores/speech-prefs";

const BAR_GAIN = [0.75, 1, 0.6];

/** 播放中的声波条：有输出电平时随声音跳动，否则循环动画；减少动效时为静态条 */
function Wave({ level }: { level: number | null }) {
  const reduce = useReducedMotion();
  return (
    <span className="flex h-4 items-center gap-[2.5px]" aria-hidden>
      {BAR_GAIN.map((g, i) =>
        reduce ? (
          <span key={i} className="h-4 w-[2.5px] rounded-full bg-current" style={{ transform: `scaleY(${0.4 + g * 0.4})` }} />
        ) : level !== null ? (
          <motion.span
            key={i}
            className="h-4 w-[2.5px] origin-center rounded-full bg-current"
            animate={{ scaleY: 0.25 + Math.min(1, level * g * 1.6) * 0.75 }}
            transition={{ duration: 0.08, ease: "linear" }}
          />
        ) : (
          <motion.span
            key={i}
            className="h-4 w-[2.5px] origin-center rounded-full bg-current"
            animate={{ scaleY: [0.3, 1, 0.45, 0.85, 0.3] }}
            transition={{ duration: 0.9, repeat: Infinity, ease: "easeInOut", delay: i * 0.12 }}
          />
        ),
      )}
    </span>
  );
}

/** 加载环：首包未到 */
function Ring() {
  return (
    <span className="relative flex size-4 items-center justify-center" aria-hidden>
      <span className="absolute inset-0 animate-spin rounded-full border-2 border-current border-t-transparent opacity-80 motion-reduce:animate-none" />
    </span>
  );
}

const ICON = {
  initial: { opacity: 0, scale: 0.85 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.85 },
  transition: { duration: 0.15 },
};

/** 音色与语速（本地持久化） */
function VoiceSettings() {
  const gender = useSpeechPrefs((s) => s.gender);
  const rate = useSpeechPrefs((s) => s.rate);
  const setGender = useSpeechPrefs((s) => s.setGender);
  const setRate = useSpeechPrefs((s) => s.setRate);
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">音色</p>
        <Segmented<SpeechGender>
          ariaLabel="朗读音色"
          size="sm"
          className="w-full"
          value={gender}
          onChange={setGender}
          options={[
            { value: "female", label: "女声" },
            { value: "male", label: "男声" },
          ]}
        />
      </div>
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">语速</p>
        <Segmented<string>
          ariaLabel="朗读语速"
          size="sm"
          className="w-full"
          value={String(rate)}
          onChange={(v) => setRate(Number(v) as SpeechRate)}
          options={SPEECH_RATES.map((r) => ({ value: String(r), label: `${r.toFixed(1)}×` }))}
        />
      </div>
    </div>
  );
}

/**
 * 朗读按钮（improve-speech-playback-latency 7.1）：分体按钮——主体播放 / 停止，右侧弹层选音色与语速。
 * 三态：加载（首包未到，加载环）→ 播放（随电平跳动的声波）→ 空闲；同一时刻全局只播一段。
 * disabledReason 不为空时按钮可见但禁用，悬停说明原因（如翻译进行中"译文完成后可朗读"）。
 */
export function SpeakButton({
  text,
  lang,
  label = "朗读",
  id,
  disabledReason,
  settings = true,
  className,
}: {
  text: string;
  lang: string | null | undefined;
  label?: string;
  /** 朗读条目 id（区分"是不是我在朗读"）；缺省自动生成 */
  id?: string;
  disabledReason?: string;
  /** 是否显示音色 / 语速设置 */
  settings?: boolean;
  className?: string;
}) {
  const autoId = useId();
  const speakId = id ?? autoId;
  const phase = useSpeakPhase(speakId);
  const level = useSpeakLevel(phase === "playing");
  const gender = useSpeechPrefs((s) => s.gender);
  const rate = useSpeechPrefs((s) => s.rate);

  const noLang = !lang || lang === "auto";
  const reason = disabledReason ?? (noLang ? "请先选择或识别出语言" : !text.trim() ? "暂无可朗读的内容" : undefined);
  const active = phase !== "idle";
  const tip = reason ?? (active ? "停止朗读" : label);

  const toggle = () => {
    if (active) stopSpeaking();
    else if (!reason && lang) void speak({ id: speakId, text, lang, gender, rate });
  };

  return (
    <div className={cn("inline-flex items-center", className)}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant={active ? "secondary" : "ghost"}
              size="icon-sm"
              aria-label={active ? "停止朗读" : label}
              aria-pressed={active}
              aria-busy={phase === "loading"}
              aria-disabled={!!reason || undefined}
              data-speak-phase={phase}
              onClick={toggle}
              className={cn(active && "text-brand", reason && "cursor-not-allowed opacity-50", settings && "rounded-r-none")}
            />
          }
        >
          <AnimatePresence mode="wait" initial={false}>
            {phase === "loading" ? (
              <motion.span key="loading" {...ICON}>
                <Ring />
              </motion.span>
            ) : phase === "playing" ? (
              <motion.span key="playing" {...ICON}>
                <Wave level={level} />
              </motion.span>
            ) : (
              <motion.span key="idle" {...ICON} className="flex">
                <Volume2Icon className="size-4" />
              </motion.span>
            )}
          </AnimatePresence>
        </TooltipTrigger>
        <TooltipContent>{tip}</TooltipContent>
      </Tooltip>
      {settings && (
        <Popover>
          <Tooltip>
            <TooltipTrigger
              render={
                <PopoverTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="朗读设置"
                      className="-ml-0.5 w-4 rounded-l-none text-muted-foreground"
                    />
                  }
                />
              }
            >
              <ChevronDownIcon className="size-3" />
            </TooltipTrigger>
            <TooltipContent>音色与语速</TooltipContent>
          </Tooltip>
          <PopoverContent align="end" className="w-56 p-3">
            <VoiceSettings />
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
