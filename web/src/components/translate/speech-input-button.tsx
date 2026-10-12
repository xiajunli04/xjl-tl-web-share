"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useMotionValue, useReducedMotion, useTransform, type MotionValue } from "motion/react";
import { Loader2Icon, MicIcon, MicOffIcon, SquareIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DURATION } from "@/components/motion/tokens";
import { speechApi } from "@/lib/api/speech";
import { MicrophoneError, type CaptureHandle } from "@/lib/audio/capture";
import { openMicrophone } from "@/lib/audio/mic";
import { CAPTURE_RATE, concatInt16, levelFromRms } from "@/lib/audio/pcm";
import { wavBlob } from "@/lib/audio/wav";
import { toastError } from "@/lib/errors";
import { cn } from "@/lib/utils";

/** 听写上限 60 s（契约 §2.1），提前 1 s 自动结束 */
const MAX_MS = 59_000;
const MIN_MS = 400;
const BAR_WEIGHTS = [0.55, 0.9, 1, 0.75, 0.5];

type State = "idle" | "recording" | "transcribing";

function Bar({ level, weight }: { level: MotionValue<number>; weight: number }) {
  const scaleY = useTransform(level, (v) => 0.2 + Math.min(1, v * weight * 1.15) * 0.8);
  return <motion.span style={{ scaleY }} className="h-3.5 w-[3px] origin-center rounded-full bg-current" />;
}

/**
 * 原文区语音输入：点击开始录音（红色脉冲 + 实时电平），再次点击结束 → 识别中 → 回填原文并设置源语言。
 * 权限被拒时提示"麦克风不可用"，不影响文本输入。
 */
export function SpeechInputButton({
  lang,
  onResult,
  disabled,
}: {
  /** 源语言提示（auto 表示自动识别） */
  lang: string;
  onResult: (text: string, lang: string) => void;
  disabled?: boolean;
}) {
  const reduce = useReducedMotion();
  const [state, setState] = useState<State>("idle");
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const level = useMotionValue(0);
  const handle = useRef<CaptureHandle | null>(null);
  const chunks = useRef<Int16Array[]>([]);
  const startedAt = useRef(0);
  const stopping = useRef(false);

  useEffect(
    () => () => {
      void handle.current?.stop();
      handle.current = null;
    },
    [],
  );

  // 录音计时
  useEffect(() => {
    if (state !== "recording") return;
    const t = setInterval(() => setElapsed(Date.now() - startedAt.current), 250);
    return () => clearInterval(t);
  }, [state]);

  const stop = async () => {
    if (stopping.current || !handle.current) return;
    stopping.current = true;
    const h = handle.current;
    handle.current = null;
    await h.stop();
    level.set(0);
    const samples = concatInt16(chunks.current);
    chunks.current = [];
    const ms = (samples.length / CAPTURE_RATE) * 1000;
    if (ms < MIN_MS) {
      setState("idle");
      stopping.current = false;
      toast.info("录音太短，请再说一次");
      return;
    }
    setState("transcribing");
    try {
      const r = await speechApi.transcribe(wavBlob(samples, CAPTURE_RATE), lang || "auto");
      if (!r.text.trim()) toast.info("没有识别到语音内容");
      else onResult(r.text.trim(), r.lang);
    } catch (e) {
      toastError(e);
    } finally {
      setState("idle");
      stopping.current = false;
    }
  };

  const start = async () => {
    chunks.current = [];
    startedAt.current = Date.now();
    setElapsed(0);
    try {
      handle.current = await openMicrophone((f) => {
        chunks.current.push(f.pcm);
        level.set(Math.max(levelFromRms(f.rms), level.get() * 0.8));
        if (Date.now() - startedAt.current >= MAX_MS) void stop();
      });
      startedAt.current = Date.now();
      setUnavailable(null);
      setState("recording");
    } catch (e) {
      const msg = e instanceof MicrophoneError ? e.message : "无法打开麦克风";
      setUnavailable(msg);
      toast.error("麦克风不可用", { description: msg });
    }
  };

  const toggle = () => {
    if (state === "recording") void stop();
    else if (state === "idle") void start();
  };

  const secs = Math.floor(elapsed / 1000);

  return (
    <AnimatePresence mode="popLayout" initial={false}>
      {state === "recording" ? (
        <motion.button
          key="rec"
          type="button"
          onClick={toggle}
          aria-label="结束录音并识别"
          initial={{ opacity: 0, scale: reduce ? 1 : 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: reduce ? 1 : 0.9 }}
          transition={{ duration: DURATION.fast }}
          className="relative inline-flex h-8 items-center gap-2 rounded-full bg-danger px-3 text-xs font-medium text-danger-foreground shadow-card outline-none focus-visible:ring-3 focus-visible:ring-danger/40"
        >
          {!reduce && <span className="absolute inset-0 animate-pulse-ring rounded-full bg-danger/40" />}
          <span className="relative flex items-center gap-[3px]" aria-hidden>
            {BAR_WEIGHTS.map((w, i) => (
              <Bar key={i} level={level} weight={w} />
            ))}
          </span>
          <span className="relative tabular-nums">
            {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}
          </span>
          <SquareIcon className="relative size-3 fill-current" />
        </motion.button>
      ) : state === "transcribing" ? (
        <motion.span
          key="asr"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="inline-flex h-8 items-center gap-1.5 rounded-full bg-brand-soft px-3 text-xs font-medium text-brand"
          role="status"
        >
          <Loader2Icon className="size-3.5 animate-spin" />
          识别中…
        </motion.span>
      ) : (
        <motion.span key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="inline-flex">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={unavailable ? "麦克风不可用" : "语音输入"}
                  disabled={disabled}
                  onClick={toggle}
                  className={cn(unavailable && "text-danger")}
                />
              }
            >
              {unavailable ? <MicOffIcon /> : <MicIcon />}
            </TooltipTrigger>
            <TooltipContent>{unavailable ? `麦克风不可用：${unavailable}` : "语音输入（最长 60 秒）"}</TooltipContent>
          </Tooltip>
        </motion.span>
      )}
    </AnimatePresence>
  );
}
