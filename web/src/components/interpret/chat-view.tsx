"use client";

import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  CircleStopIcon,
  HeadphonesIcon,
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
  ScissorsIcon,
  Volume2Icon,
  VolumeXIcon,
  WifiOffIcon,
  XIcon,
} from "lucide-react";
import { AiAvatar } from "@/components/avatar/ai-avatar";
import { CharacterFace } from "@/components/avatar/character-face";
import { MascotIcon } from "@/components/avatar/mascot-icon";
import { HUMAN_AVATAR_ENABLED } from "@/lib/avatar/feature";
import { characterForLang } from "@/lib/avatar/characters";
import { Button } from "@/components/ui/button";
import { DURATION, EASE_OUT } from "@/components/motion";
import { useInterpretAvatar } from "@/hooks/use-interpret-avatar";
import { useStickToBottom } from "@/hooks/use-stick-to-bottom";
import { interpretRuntime } from "@/hooks/use-interpret-socket";
import { AVATAR_STATE_LABEL } from "@/lib/avatar/state";
import { liveState, openUtterance, type Utterance } from "@/lib/interpret/reducer";
import { REALTIME_CHAT_ENGINE } from "@/lib/interpret/setup";
import { langName } from "@/lib/languages";
import { cn } from "@/lib/utils";
import { useInterpretSetup, useInterpretStore } from "@/stores/interpret-store";
import { ToggleButton } from "./control-bar";
import { Caret, LatencyPill, NewMessagesPill } from "./live-bits";
import { ListeningIndicator, useLocalListening } from "./listening-indicator";
import { StreamingText } from "./streaming-text";
import { AI_NAME, CHAT_SCENARIOS } from "./meta";
import { ReplayButton, SentenceFade, SpeakingBars, useUtteranceSpeaking } from "./replay-button";

/** 状态说明：数字人下方的一句话（"Lumi 正在倾听…"） */
const STAGE_HINT: Record<string, string> = {
  idle: "说点什么吧，我在听",
  listening: "正在倾听…",
  thinking: "正在想怎么回答…",
  speaking: "正在说话",
  holding: "等你说完…",
  error: "连接出了点问题，正在重连…",
};

/**
 * AI 对话进行中（add-ai-avatar-and-landing D6 / UI·UX）：
 * 桌面主从两栏——左侧数字人舞台（状态说明、打断按钮），右侧对话流（AI 气泡含对话语言原文与母语字幕）；
 * 移动端上下布局（数字人约 38vh）。
 */
export function ChatView() {
  const languages = useInterpretStore((s) => s.join?.languages ?? ["zh", "en"]);
  const [my, ai] = languages;
  const { state, signals } = useInterpretAvatar();
  // 用户说到一半停顿、服务端正在等待续说（improve-speech-endpointing-and-live-ux D9）
  const holding = useInterpretStore((s) => !!openUtterance(s.live, s.join?.participantId)?.hold);
  const hintKey = holding && state !== "speaking" ? "holding" : state;
  const scenario = useInterpretSetup((s) => s.chatScenario);
  const sc = CHAT_SCENARIOS[scenario] ?? CHAT_SCENARIOS.free;
  const ScIcon = sc.icon;
  const reduce = useReducedMotion();
  const ended = useInterpretStore((s) => s.phase !== "live");

  // 连接就绪后做一次开心问候
  const ready = useInterpretStore((s) => !!s.live.ready);
  const character = characterForLang(ai);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid min-h-0 flex-1 grid-rows-[38vh_minmax(0,1fr)] md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] md:grid-rows-1">
        {/* 数字人舞台 */}
        <section
          className="relative flex min-h-0 flex-col items-center overflow-hidden border-b bg-[linear-gradient(180deg,color-mix(in_oklch,var(--color-brand-soft)_70%,var(--color-background))_0%,var(--color-background)_100%)] md:border-r md:border-b-0"
          aria-label={`${AI_NAME} 数字人`}
        >
          <span className="absolute top-3 left-3 z-10 inline-flex items-center gap-1.5 rounded-full border bg-card/80 px-2.5 py-1 text-xs font-medium shadow-card backdrop-blur">
            <ScIcon className="size-3.5 text-brand" />
            {sc.title}
          </span>
          <span className="absolute top-3 right-3 z-10 rounded-full border bg-card/80 px-2.5 py-1 text-xs text-muted-foreground shadow-card backdrop-blur">
            {langName(ai)} 对话 · {langName(my)}字幕
          </span>
          {/* 吉祥物背后的柔光 */}
          <span
            aria-hidden
            className="pointer-events-none absolute top-[18%] left-1/2 aspect-square w-[72%] max-w-[420px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,color-mix(in_oklch,var(--color-brand)_20%,transparent)_0%,transparent_65%)]"
          />
          <AiAvatar
            character={character}
            state={state}
            signals={signals}
            framing="stage"
            interactive
            greetKey={ready ? 1 : 0}
            className="min-h-0 w-full flex-1"
          />
          <div className="relative z-10 flex w-full flex-col items-center gap-2 px-4 pb-4">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.p
                key={hintKey}
                initial={{ opacity: 0, y: reduce ? 0 : 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: reduce ? 0 : -6 }}
                transition={{ duration: DURATION.fast, ease: EASE_OUT }}
                className="text-sm text-muted-foreground"
                aria-live="polite"
              >
                <span className="font-semibold text-foreground">{AI_NAME}</span> {STAGE_HINT[hintKey] ?? AVATAR_STATE_LABEL[state]}
              </motion.p>
            </AnimatePresence>
            <AnimatePresence>
              {state === "speaking" && !ended && (
                <motion.div
                  initial={{ opacity: 0, scale: reduce ? 1 : 0.9, y: reduce ? 0 : 6 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: reduce ? 1 : 0.9 }}
                  transition={{ type: "spring", stiffness: 420, damping: 28 }}
                >
                  <Button variant="outline" className="h-9 gap-2 rounded-full bg-card/90 px-4 shadow-card backdrop-blur" onClick={interpretRuntime.interrupt}>
                    <CircleStopIcon className="size-4 text-danger" />
                    打断
                  </Button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </section>

        {/* 对话流 */}
        <ChatThread my={my} ai={ai} />
      </div>
      <ChatControls />
    </div>
  );
}

function ChatThread({ my, ai }: { my: string; ai: string }) {
  const reduce = useReducedMotion();
  const utterances = useInterpretStore((s) => s.live.utterances);
  // AI 回复在出字前显示"思考中"气泡；还没出字就被打断的回复不显示（否则会留下空气泡）；
  // 用户句只在有文字后出现，之前由底部的"正在听"指示代替（improve-speech-endpointing-and-live-ux D9）
  const items = utterances.filter((u) => u.source || (u.role === "assistant" && !u.interrupted));
  const listening = useLocalListening();
  const { ref, contentRef, onScroll, unread, scrollToBottom } = useStickToBottom<HTMLElement>(items.length, { reduce: !!reduce });

  return (
    <div className="relative flex min-h-0 flex-col">
    <section ref={ref} onScroll={onScroll} className="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4 md:px-6" aria-label="对话记录">
      <div ref={contentRef} className="flex min-h-full flex-col gap-3">
      <RealtimeBanner />
      {!items.length && (
        <p className="m-auto max-w-xs text-center text-sm text-muted-foreground">
          {AI_NAME} 会先和你打招呼。听完后直接开口回答，用{langName(ai)}或{langName(my)}都可以。
        </p>
      )}
      <AnimatePresence initial={false}>
        {items.map((u, i) => {
          // 用户侧连续气泡（如让位后接着说的两段）分组显示
          const grouped = u.role === "user" && items[i - 1]?.role === "user";
          return (
            <motion.div
              key={u.id}
              layout={reduce ? false : "position"}
              initial={{ opacity: 0, y: reduce ? 0 : 10, scale: reduce ? 1 : 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: reduce ? 1 : 0.96, transition: { duration: DURATION.fast } }}
              transition={{ duration: DURATION.page + 0.04, ease: EASE_OUT }}
              className={cn("flex", u.role === "assistant" ? "justify-start" : "justify-end", grouped && "-mt-2")}
            >
              {u.role === "assistant" ? <AiBubble u={u} my={my} ai={ai} /> : <UserBubble u={u} grouped={grouped} />}
            </motion.div>
          );
        })}
        {listening && <ListeningIndicator key="listening" align="end" />}
      </AnimatePresence>
      </div>
    </section>
    <NewMessagesPill count={unread} onClick={() => scrollToBottom()} />
    </div>
  );
}

/**
 * 实时语音模型上游中断（非致命 C0174，服务端正在用最近对话重建会话）时的提示横幅，可关闭；
 * 重连仍失败会以致命错误结束，摘要框提供"切换到平台级联重新开始"（improve-speech-playback-latency 8.5）
 */
function RealtimeBanner() {
  const reduce = useReducedMotion();
  const engine = useInterpretStore((s) => s.join?.engine);
  const error = useInterpretStore((s) => s.live.error);
  const [dismissed, setDismissed] = useState<object | null>(null);
  const show = engine === REALTIME_CHAT_ENGINE && !!error && !error.fatal && error.code === "C0174" && dismissed !== error;
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: reduce ? 0 : -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reduce ? 0 : -6 }}
          transition={{ duration: DURATION.page, ease: EASE_OUT }}
          role="status"
          className="sticky top-0 z-10 flex items-start gap-2 rounded-xl border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning shadow-card"
        >
          <WifiOffIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="flex-1 leading-relaxed">
            实时语音模型连接中断，正在重连并恢复对话上下文…若长时间无响应，可结束后切换到平台级联。
          </span>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={() => setDismissed(error)}
            className="rounded p-0.5 text-warning/80 transition-colors hover:text-warning"
          >
            <XIcon className="size-3.5" />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function AiBubble({ u, my, ai }: { u: Utterance; my: string; ai: string }) {
  const subtitle = my !== ai ? u.translations[my] : undefined;
  const speaking = useUtteranceSpeaking(u.id);
  return (
    <div className="group flex max-w-[88%] items-start gap-2.5">
      {HUMAN_AVATAR_ENABLED ? (
        <CharacterFace id={characterForLang(ai)} className="mt-0.5 size-9 shadow-card" />
      ) : (
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand-soft shadow-card">
          <MascotIcon crop="face" className="size-9" />
        </span>
      )}
      <div className="min-w-0 rounded-2xl rounded-tl-md border bg-card px-4 py-2.5 shadow-card">
        {u.source ? (
          <p className="text-base leading-snug font-medium md:text-lg">
            <StreamingText text={u.source} mark={u.sourceFinal || u.interrupted ? null : "live"} />
            {u.interrupted && <span className="text-muted-foreground">…</span>}
          </p>
        ) : (
          <span className="flex gap-1 py-2" aria-label="正在思考">
            {[0, 1, 2].map((i) => (
              <span key={i} className="size-1.5 animate-breathe rounded-full bg-brand" style={{ animationDelay: `${i * 0.18}s` }} />
            ))}
          </span>
        )}
        {subtitle?.text && (
          <p className="mt-1.5 border-t pt-1.5 text-sm text-muted-foreground">
            <SentenceFade text={subtitle.text} />
            {!subtitle.final && <Caret />}
          </p>
        )}
        {u.source && u.sourceFinal && (
          <div className="mt-1 -mb-1 flex h-6 items-center gap-1.5">
            {speaking && <SpeakingBars />}
            <ReplayButton utteranceId={u.id} text={u.source} lang={ai} className="-ml-1" />
          </div>
        )}
        {u.interrupted && (
          <span className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            <ScissorsIcon className="size-3" />
            已打断
          </span>
        )}
      </div>
    </div>
  );
}

function UserBubble({ u, grouped }: { u: Utterance; grouped?: boolean }) {
  return (
    <div
      className={cn(
        "max-w-[80%] rounded-2xl bg-brand-gradient px-4 py-2.5 text-sm text-brand-foreground shadow-brand [&_.bg-brand]:bg-brand-foreground",
        grouped ? "rounded-r-md" : "rounded-br-md",
      )}
    >
      <StreamingText text={u.source} mark={liveState(u)} />
    </div>
  );
}

function ChatControls() {
  const muted = useInterpretStore((s) => s.muted);
  const tts = useInterpretStore((s) => s.tts);
  const headphone = useInterpretStore((s) => s.headphone);
  const gated = useInterpretStore((s) => s.gated);
  const ended = useInterpretStore((s) => s.phase !== "live");
  return (
    <div className="flex flex-wrap items-center gap-3 border-t bg-card/80 px-4 py-3 backdrop-blur supports-backdrop-filter:bg-card/70 md:px-6">
      <LatencyPill />
      <AnimatePresence initial={false}>
        {gated && (
          <motion.span
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="hidden rounded-full bg-warning-soft px-2.5 py-1 text-xs font-medium text-warning sm:inline-flex"
            role="status"
          >
            {AI_NAME} 说话时暂停收音 · 戴耳机可直接插话
          </motion.span>
        )}
      </AnimatePresence>
      <div className="ml-auto flex items-center gap-1.5">
        <ToggleButton
          on={!muted}
          onIcon={MicIcon}
          offIcon={MicOffIcon}
          danger
          label={muted ? "打开麦克风" : "静音麦克风"}
          tip={muted ? "打开麦克风" : "静音麦克风"}
          onClick={() => interpretRuntime.setMuted(!muted)}
          disabled={ended}
        />
        <ToggleButton
          on={tts}
          onIcon={Volume2Icon}
          offIcon={VolumeXIcon}
          label="语音播报"
          tip={tts ? `关闭 ${AI_NAME} 的语音` : `开启 ${AI_NAME} 的语音`}
          onClick={() => interpretRuntime.setTts(!tts)}
          disabled={ended}
        />
        <ToggleButton
          on={headphone}
          onIcon={HeadphonesIcon}
          label="耳机模式"
          tip={headphone ? "关闭耳机模式（她说话时暂停收音）" : "耳机模式：她说话时也能直接插话打断"}
          onClick={() => interpretRuntime.setHeadphone(!headphone)}
          disabled={ended}
        />
        <Button variant="destructive" className="ml-1 h-9 gap-2 rounded-full px-4" onClick={() => void interpretRuntime.end()} disabled={ended}>
          <PhoneOffIcon className="size-4" />
          结束
        </Button>
      </div>
    </div>
  );
}
