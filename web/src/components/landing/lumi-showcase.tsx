"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useInView, useReducedMotion } from "motion/react";
import { EarIcon, HandIcon, MessagesSquareIcon, MousePointerClickIcon, Move3dIcon, UsersRoundIcon, Volume2Icon } from "lucide-react";
import { AiAvatar } from "@/components/avatar/ai-avatar";
import type { AvatarSignals } from "@/components/avatar/types";
import { Button } from "@/components/ui/button";
import { DURATION, EASE_OUT } from "@/components/motion/tokens";
import { MOOD_STYLE, type MascotMood } from "@/lib/avatar/mascot";
import type { AvatarState } from "@/lib/avatar/state";
import { cn } from "@/lib/utils";
import { ReplayBadge } from "./trace-card";

const MODES = [
  { icon: EarIcon, title: "同传收听", desc: "讲座与发布会：多语种语音持续翻译成你的语言" },
  { icon: MessagesSquareIcon, title: "双向对话", desc: "面对面交流：Lumi 当你们的译员" },
  { icon: UsersRoundIcon, title: "多语会议室", desc: "3–8 人各用自己的语言开会" },
];

/** 情绪芯片：点一下，Lumi 立刻演示对应的状态 */
const MOOD_CHIPS: { mood: MascotMood; label: string }[] = [
  { mood: "listening", label: "倾听" },
  { mood: "thinking", label: "思考" },
  { mood: "speaking", label: "说话" },
  { mood: "happy", label: "开心" },
  { mood: "error", label: "小失落" },
  { mood: "sleepy", label: "犯困" },
];

// Phrase boundaries for the prerecorded 6.96-second greeting.
const GREETING_CUES = [
  { start: 0, end: 0.2, zh: "你好，我是 Lumi！", en: "Hi, I'm Lumi!" },
  { start: 0.2, end: 0.56, zh: "我可以实时为你的对话做翻译，", en: "I can interpret your conversations in real time," },
  { start: 0.56, end: 1, zh: "也可以陪你用想练习的语言聊天。", en: "or chat with you in the language you want to practice." },
] as const;

/**
 * 和 AI 面对面（landing-page「吉祥物情绪演示」）：分区接近视口（300px）时才挂载 3D 吉祥物；
 * 情绪芯片即时切换状态；「听 Lumi 打招呼」播放预生成的千问 Cherry 欢迎语，字幕与说话状态跟随音频播放。
 */
export function LumiShowcase() {
  const reduce = useReducedMotion();
  const stage = useRef<HTMLDivElement>(null);
  const near = useInView(stage, { once: true, margin: "300px 0px" });
  const [mood, setMood] = useState<MascotMood | null>(null);
  const [state, setState] = useState<AvatarState>("idle");
  const [greet, setGreet] = useState(0);
  const [spoken, setSpoken] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const playbackId = useRef(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const cueIndex = Math.max(0, GREETING_CUES.findLastIndex((cue) => progress >= cue.start));
  const cue = GREETING_CUES[cueIndex];
  const cueProgress = Math.min(1, Math.max(0, (progress - cue.start) / (cue.end - cue.start)));
  const caption = reduce ? cue.zh : cue.zh.slice(0, Math.max(1, Math.ceil(cue.zh.length * cueProgress)));
  const englishWords = cue.en.split(" ");
  const visibleWords = reduce ? englishWords.length : Math.max(1, Math.ceil(englishWords.length * cueProgress));
  const signals = useMemo<AvatarSignals>(() => ({ pseudoSpeaking: () => true }), []);

  const stop = useCallback(() => {
    playbackId.current += 1;
    const player = audio.current;
    if (player) {
      player.pause();
      player.currentTime = 0;
    }
  }, []);
  useEffect(() => {
    const player = audio.current;
    return () => {
      playbackId.current += 1;
      player?.pause();
    };
  }, []);

  // Read the actual playback clock: subtitles freeze on pause and do not race buffering.
  useEffect(() => {
    if (state !== "speaking") return;
    let frame = 0;
    let last = 0;
    const update = (time: number) => {
      const player = audio.current;
      if (player && !player.paused && Number.isFinite(player.duration) && player.duration > 0 && time - last >= 40) {
        setProgress(Math.min(1, player.currentTime / player.duration));
        last = time;
      }
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [state]);

  const pick = (m: MascotMood) => {
    stop();
    setSpoken(false);
    setLoading(false);
    setError(null);
    setState("idle");
    setMood((cur) => (cur === m ? null : m));
  };

  const sayHello = async () => {
    stop();
    setLoading(false);
    setError(null);
    if (state === "speaking") {
      setState("idle");
      return;
    }
    const player = audio.current;
    if (!player) return;
    document.querySelectorAll<HTMLAudioElement>("audio[data-landing-audio]").forEach((other) => {
      if (other !== player) other.pause();
    });
    const id = playbackId.current;
    setMood(null);
    setSpoken(true);
    setProgress(0);
    setGreet((g) => g + 1);
    setLoading(true);
    // Start within the click gesture so mobile browsers allow audio playback.
    try {
      await player.play();
    } catch {
      if (playbackId.current !== id) return;
      setLoading(false);
      setState("idle");
      setError("欢迎语暂时无法播放，请再试一次。");
    }
  };

  const active = mood ?? (state === "speaking" ? "speaking" : null);

  return (
    <div className="grid items-center gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <audio
        ref={audio}
        data-landing-audio
        src="/audio/lumi-greeting-zh.mp3"
        preload="none"
        onPlaying={() => {
          setLoading(false);
          setState("speaking");
        }}
        onTimeUpdate={(event) => {
          const player = event.currentTarget;
          if (!player.paused && Number.isFinite(player.duration) && player.duration > 0) {
            setProgress(Math.min(1, player.currentTime / player.duration));
          }
        }}
        onPause={() => { setLoading(false); setState("idle"); }}
        onEnded={() => {
          setProgress(1);
          setState("idle");
          setSpoken(false);
        }}
        onError={() => {
          setLoading(false);
          setState("idle");
          setError("欢迎语暂时无法播放，请再试一次。");
        }}
      />
      <div
        ref={stage}
        className="relative aspect-[4/5] max-h-[600px] w-full overflow-hidden rounded-3xl border bg-[linear-gradient(180deg,color-mix(in_oklch,var(--color-brand-soft)_85%,var(--color-card))_0%,var(--color-card)_100%)] shadow-popover"
      >
        <span
          aria-hidden
          className="pointer-events-none absolute top-[16%] left-1/2 aspect-square w-[78%] -translate-x-1/2 rounded-full transition-[background] duration-500"
          style={{ background: `radial-gradient(circle, color-mix(in oklch, ${MOOD_STYLE[mood ?? "idle"].accent} 26%, transparent) 0%, transparent 66%)` }}
        />
        <div className="absolute top-3 left-3 z-10 flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border bg-card/80 px-2.5 py-1 text-xs font-medium shadow-card backdrop-blur">
            <span className="size-1.5 rounded-full transition-colors" style={{ background: MOOD_STYLE[active ?? "idle"].accent }} />
            Lumi · {MOOD_STYLE[active ?? "idle"].label}
          </span>
          <ReplayBadge />
        </div>
        <div className="absolute inset-x-0 top-12 bottom-0">
          {near ? (
            <AiAvatar state={state} mood={mood} signals={signals} framing="stage" interactive greetKey={greet} className="size-full" />
          ) : (
            <div className="size-full" />
          )}
        </div>
        <div className="pointer-events-none absolute right-3 bottom-3 z-10 flex gap-1.5 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1 rounded-full bg-card/80 px-2 py-0.5 backdrop-blur">
            <Move3dIcon className="size-3" />
            拖动我转一圈
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-card/80 px-2 py-0.5 backdrop-blur">
            <MousePointerClickIcon className="size-3" />
            点我一下
          </span>
        </div>
        <AnimatePresence>
          {spoken && (
            <motion.div
              initial={{ opacity: 0, y: reduce ? 0 : 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: DURATION.page, ease: EASE_OUT }}
              className="pointer-events-none absolute inset-x-6 bottom-12 z-10 py-2 text-left"
            >
              <div aria-hidden="true" className="relative z-10 mx-auto grid max-w-[26rem] [text-shadow:0_1px_8px_var(--color-card)]">
                <AnimatePresence initial={false}>
                  <motion.div
                    key={`${greet}:${cueIndex}`}
                    className="col-start-1 row-start-1"
                    initial={{ opacity: 0, y: reduce ? 0 : 3, filter: reduce ? "none" : "blur(1px)" }}
                    animate={{ opacity: 1, y: 0, filter: reduce ? "none" : "blur(0px)", transition: { duration: reduce ? 0 : 0.3, delay: reduce ? 0 : 0.16, ease: EASE_OUT } }}
                    exit={{ opacity: 0, y: reduce ? 0 : -2, filter: reduce ? "none" : "blur(1px)", transition: { duration: reduce ? 0 : 0.16, ease: EASE_OUT } }}
                    transition={{ duration: reduce ? 0 : 0.3, ease: EASE_OUT }}
                  >
                    <p className="text-sm leading-relaxed font-medium text-foreground/85">{caption}</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-pretty text-foreground/60">
                      {englishWords.map((word, i) => (
                        <motion.span
                          key={`${i}:${word}`}
                          initial={false}
                          animate={{ opacity: i < visibleWords ? 1 : 0 }}
                          transition={{ duration: reduce ? 0 : 0.25, ease: EASE_OUT }}
                        >
                          {word}{i < englishWords.length - 1 ? " " : ""}
                        </motion.span>
                      ))}
                    </p>
                  </motion.div>
                </AnimatePresence>
              </div>
              <p className="sr-only" role="status">{cue.zh} {cue.en}</p>
              <motion.div
                aria-hidden="true"
                className="pointer-events-none absolute -inset-x-4 -inset-y-2 bg-[radial-gradient(ellipse_at_center,var(--color-card)_0%,transparent_75%)]"
                initial={false}
                animate={{ opacity: state === "speaking" ? 0.75 : 0.5 }}
                transition={{ duration: reduce ? 0 : 0.6, ease: EASE_OUT }}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="space-y-6">
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-muted-foreground">
            Lumi 是译桥的小助手：在同声传译里，她是面对面交流时的 AI 译员；在 AI 对话里，她陪你用外语聊天。她会用颜色和表情告诉你自己在做什么——在听、在想、在说，还是遇到了问题。
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="lg" className="h-11 rounded-full px-5" onClick={sayHello} disabled={loading} aria-busy={loading}>
              {state === "speaking" ? <Volume2Icon /> : <HandIcon />}
              {loading ? "正在加载欢迎语…" : state === "speaking" ? "停止播放" : "听 Lumi 打招呼"}
            </Button>
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div>
            <div className="mb-2 text-xs font-medium text-muted-foreground">试试她的情绪</div>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="吉祥物情绪">
              {MOOD_CHIPS.map((c) => {
                const on = mood === c.mood;
                return (
                  <button
                    key={c.mood}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => pick(c.mood)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                      on ? "border-brand/40 bg-brand-soft font-medium text-brand" : "text-muted-foreground hover:bg-muted",
                    )}
                  >
                    <span className="size-2 rounded-full" style={{ background: MOOD_STYLE[c.mood].accent }} />
                    {c.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {MODES.map((m, i) => (
            <motion.div
              key={m.title}
              initial={{ opacity: 0, y: 10 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: DURATION.page, ease: EASE_OUT, delay: i * 0.06 }}
              whileHover={reduce ? undefined : { y: -3 }}
              className="rounded-2xl border bg-card p-3.5 shadow-card"
            >
              <span className="mb-2 flex size-8 items-center justify-center rounded-lg bg-brand-soft text-brand">
                <m.icon className="size-4" />
              </span>
              <div className="text-sm font-semibold">{m.title}</div>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{m.desc}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}
