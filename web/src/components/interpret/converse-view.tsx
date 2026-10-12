"use client";

import { useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { BotIcon, BotOffIcon, HandIcon, MicIcon, PauseCircleIcon, PhoneOffIcon, RotateCcwIcon, Volume2Icon, VolumeXIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DURATION, EASE_OUT } from "@/components/motion";
import { AiAvatar } from "@/components/avatar/ai-avatar";
import { characterForLang } from "@/lib/avatar/characters";
import { useInterpretAvatar } from "@/hooks/use-interpret-avatar";
import { useStickToBottom } from "@/hooks/use-stick-to-bottom";
import { useSpeechEngines } from "@/hooks/use-speech-engines";
import { interpretRuntime } from "@/hooks/use-interpret-socket";
import { normLang } from "@/lib/interpret/protocol";
import { liveState, type Utterance } from "@/lib/interpret/reducer";
import { supportsAutoConverse } from "@/lib/interpret/setup";
import { langName } from "@/lib/languages";
import { cn } from "@/lib/utils";
import { ReplayButton, SpeakingBars, useUtteranceSpeaking } from "./replay-button";
import { useInterpretStore } from "@/stores/interpret-store";
import { useUiStore } from "@/stores/ui";
import { ToggleButton } from "./control-bar";
import { LatencyPill, LevelOrb, NewMessagesPill, StatusPill } from "./live-bits";
import { useLocalListening } from "./listening-indicator";
import { langShort } from "./meta";
import { HoldDots, StreamingText, type LiveMark } from "./streaming-text";

type Side = "A" | "B";

/** 句子的说话方：按识别语种判断；尚未识别时按已有译文推断 */
function sideOf(u: Utterance, a: string, b: string): Side | null {
  const l = normLang(u.lang);
  if (l === a) return "A";
  if (l === b) return "B";
  if (u.translations[b]) return "A";
  if (u.translations[a]) return "B";
  return null;
}

/** 双向对话：上下面对面两半区（上半区可旋转 180°），中间为自动开关与状态 */
export function ConverseView() {
  const languages = useInterpretStore((s) => s.join?.languages ?? ["zh", "en"]);
  const [a, b] = languages;
  const [rotated, setRotated] = useState(false);

  return (
    <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto_minmax(0,1fr)]">
      <motion.div
        className="min-h-0"
        animate={{ rotate: rotated ? 180 : 0 }}
        transition={{ type: "spring", stiffness: 160, damping: 22 }}
      >
        <HalfPanel side="B" lang={b} other={a} top rotated={rotated} onRotate={() => setRotated((r) => !r)} />
      </motion.div>
      <MiddleBar />
      <HalfPanel side="A" lang={a} other={b} />
    </div>
  );
}

function HalfPanel({
  side,
  lang,
  other,
  top,
  rotated,
  onRotate,
}: {
  side: Side;
  lang: string;
  other: string;
  top?: boolean;
  rotated?: boolean;
  onRotate?: () => void;
}) {
  const reduce = useReducedMotion();
  const utterances = useInterpretStore((s) => s.live.utterances);
  const [a, b] = side === "A" ? [lang, other] : [other, lang];
  const items = useMemo(() => {
    const list = utterances
      .map((u) => ({ u, from: sideOf(u, a, b) }))
      .filter((x): x is { u: Utterance; from: Side } => x.from !== null)
      .map(({ u, from }) => {
        const mine = from === side;
        const text = mine ? u.source : (u.translations[lang]?.text ?? "");
        const final = mine ? u.sourceFinal : !!u.translations[lang]?.final;
        const mark: LiveMark = mine ? liveState(u) : liveState(u, lang);
        return { id: u.id, mine, text, final, mark, original: mine ? null : u.source };
      })
      .filter((x) => x.text);
    // 光标只留给本侧最后一条进行中的语句（improve-speech-endpointing-and-live-ux D9）
    const active = [...list].reverse().find((x) => x.mark)?.id;
    return list.map((x) => (x.id === active ? x : { ...x, mark: null }));
  }, [utterances, a, b, side, lang]);
  const { ref, contentRef, onScroll, unread, scrollToBottom } = useStickToBottom<HTMLDivElement>(items.length, { reduce: !!reduce });

  return (
    <section className={cn("flex h-full min-h-0 flex-col", top ? "bg-surface/60" : "bg-background")} aria-label={`${langName(lang)} 一侧`}>
      <div className="flex items-center gap-2 px-4 pt-3 md:px-6">
        <span className="inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs font-medium shadow-card">
          <span className="flex size-4 items-center justify-center rounded-full bg-brand-soft text-[9px] font-semibold text-brand">{langShort(lang)}</span>
          {langName(lang)}
          <span className="text-muted-foreground">· {top ? "对方" : "我"}</span>
        </span>
        {top && onRotate && (
          <Tooltip>
            <TooltipTrigger
              render={<Button variant="ghost" size="icon-sm" className="ml-auto text-muted-foreground" aria-label="旋转上半区" aria-pressed={rotated} onClick={onRotate} />}
            >
              <RotateCcwIcon />
            </TooltipTrigger>
            <TooltipContent>{rotated ? "转回正向" : "旋转 180°，方便对面阅读"}</TooltipContent>
          </Tooltip>
        )}
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={ref} onScroll={onScroll} className="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-3 md:px-6">
        <div ref={contentRef} className="flex min-h-full flex-col gap-2">
        {!items.length && (
          <p className="m-auto text-center text-sm text-muted-foreground">
            {top ? `对方说${langName(lang)}时，原文显示在这里` : `说${langName(lang)}，对方会看到并听到${langName(other)}译文`}
          </p>
        )}
        <AnimatePresence initial={false}>
          {items.map((it) => (
            <motion.div
              key={it.id}
              layout={reduce ? false : "position"}
              initial={{ opacity: 0, y: reduce ? 0 : 10, scale: reduce ? 1 : 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: reduce ? 1 : 0.97, transition: { duration: DURATION.fast } }}
              transition={{ duration: DURATION.page + 0.04, ease: EASE_OUT }}
              className={cn("flex", it.mine ? "justify-end" : "justify-start")}
            >
              <div
                className={cn(
                  "group max-w-[85%] rounded-2xl px-4 py-2.5",
                  it.mine
                    ? "rounded-br-md bg-muted text-sm text-muted-foreground"
                    : "rounded-bl-md border bg-card text-lg leading-snug font-medium shadow-card md:text-xl",
                )}
              >
                <StreamingText text={it.text} mark={it.mark} />
                {it.original && it.final && <p className="mt-1 text-xs font-normal text-muted-foreground">{it.original}</p>}
                {!it.mine && it.final && <BubbleAudio id={it.id} text={it.text} lang={lang} />}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
        </div>
      </div>
      <NewMessagesPill count={unread} onClick={() => scrollToBottom()} />
      </div>
      <div className="flex justify-center px-4 pb-4">
        <PttButton side={side} lang={lang} />
      </div>
    </section>
  );
}

/** 译文气泡底部：播报中的声波条与重播按钮（improve-speech-playback-latency 8.4） */
function BubbleAudio({ id, text, lang }: { id: string; text: string; lang: string }) {
  const speaking = useUtteranceSpeaking(id);
  return (
    <div className="mt-1 -mb-1 flex h-6 items-center gap-1.5 text-base">
      {speaking && <SpeakingBars />}
      <ReplayButton utteranceId={id} text={text} lang={lang} className="-ml-1" />
    </div>
  );
}

/** 大号按键说话按钮：按住期间以该侧语言为源（自动模式下用于强制方向） */
function PttButton({ side, lang }: { side: Side; lang: string }) {
  const reduce = useReducedMotion();
  const pressed = useInterpretStore((s) => s.pttSide === side);
  const auto = useInterpretStore((s) => s.converseAuto);
  const ended = useInterpretStore((s) => s.phase !== "live");
  const down = (e: React.PointerEvent) => {
    if (ended) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    interpretRuntime.ptt(side);
  };
  const up = () => pressed && interpretRuntime.ptt(null);
  return (
    <motion.button
      type="button"
      disabled={ended}
      onPointerDown={down}
      onPointerUp={up}
      onPointerCancel={up}
      onKeyDown={(e) => (e.key === " " || e.key === "Enter") && !e.repeat && interpretRuntime.ptt(side)}
      onKeyUp={(e) => (e.key === " " || e.key === "Enter") && up()}
      animate={{ scale: pressed && !reduce ? 1.04 : 1 }}
      transition={{ type: "spring", stiffness: 420, damping: 24 }}
      aria-pressed={pressed}
      className={cn(
        "relative flex h-14 w-full max-w-sm touch-none items-center justify-center gap-2 rounded-full text-sm font-semibold outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50",
        pressed ? "bg-brand-gradient text-brand-foreground shadow-brand" : "border bg-card text-foreground shadow-card hover:bg-muted/60",
      )}
    >
      {pressed && <span className="absolute inset-0 animate-pulse-ring rounded-full bg-brand/25 motion-reduce:hidden" />}
      {pressed ? <MicIcon className="relative size-5" /> : <HandIcon className="relative size-5 text-brand" />}
      <span className="relative">{pressed ? `正在听${langName(lang)}…松开结束` : auto ? `按住强制说${langName(lang)}` : `按住说${langName(lang)}`}</span>
    </motion.button>
  );
}

function MiddleBar() {
  const engines = useSpeechEngines();
  const engineId = useInterpretStore((s) => s.join?.engine);
  const engine = engines.data?.interpret.find((e) => e.id === engineId);
  const autoOk = engine ? supportsAutoConverse(engine) : engineId === "cascade";
  const auto = useInterpretStore((s) => s.converseAuto);
  const gated = useInterpretStore((s) => s.gated);
  const tts = useInterpretStore((s) => s.tts);
  const ended = useInterpretStore((s) => s.phase !== "live");
  // 尚未判定方向的进行中语句（显示在中间条）；没有文字但已开口时显示"正在听"
  const partial = useInterpretStore((s) => {
    const u = s.live.utterances.at(-1);
    return u && !u.sourceFinal && !u.lang ? u.source : "";
  });
  const holding = useInterpretStore((s) => {
    const u = s.live.utterances.at(-1);
    return !!u && !u.sourceFinal && u.hold;
  });
  const listening = useLocalListening();

  const avatarOn = useUiStore((s) => s.avatarEnabled);
  const setAvatarOn = useUiStore((s) => s.setAvatarEnabled);

  return (
    <div className="relative z-10 flex flex-wrap items-center gap-3 border-y bg-card px-4 py-2.5 shadow-card md:px-6">
      {avatarOn ? <InterpreterBadge /> : <LevelOrb size="sm" />}
      <StatusPill />
      <LatencyPill className="hidden sm:inline-flex" />
      <div className="min-w-0 flex-1">
        <AnimatePresence mode="popLayout" initial={false}>
          {gated ? (
            <motion.span
              key="gated"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              className="inline-flex items-center gap-1.5 rounded-full bg-warning-soft px-2.5 py-1 text-xs font-medium text-warning"
              role="status"
            >
              <PauseCircleIcon className="size-3.5" />
              播报中，暂停收音
            </motion.span>
          ) : partial ? (
            <motion.span key="partial" initial={{ opacity: 0 }} animate={{ opacity: 0.8 }} exit={{ opacity: 0 }} className="block truncate text-sm text-muted-foreground">
              <StreamingText text={partial} mark={holding ? "hold" : "live"} />
            </motion.span>
          ) : listening ? (
            <motion.span key="listening" initial={{ opacity: 0 }} animate={{ opacity: 0.8 }} exit={{ opacity: 0 }} className="inline-flex items-center text-sm text-muted-foreground" role="status">
              正在听
              <HoldDots />
            </motion.span>
          ) : null}
        </AnimatePresence>
      </div>
      <Tooltip>
        <TooltipTrigger render={<label className={cn("flex items-center gap-2 text-xs font-medium", !autoOk && "text-muted-foreground")} />}>
          自动
          <Switch
            checked={autoOk && auto}
            disabled={!autoOk || ended}
            onCheckedChange={(v) => interpretRuntime.setConverseAuto(v, engine)}
            aria-label="自动切换方向"
          />
        </TooltipTrigger>
        <TooltipContent>{autoOk ? (auto ? "按识别语种自动切换方向" : "两侧各自按住按钮说话") : "该引擎仅支持按键说话"}</TooltipContent>
      </Tooltip>
      <ToggleButton
        on={avatarOn}
        onIcon={BotIcon}
        offIcon={BotOffIcon}
        label="AI 译员"
        tip={avatarOn ? "隐藏 AI 译员数字人" : "显示 AI 译员数字人"}
        onClick={() => setAvatarOn(!avatarOn)}
      />
      <ToggleButton on={tts} onIcon={Volume2Icon} offIcon={VolumeXIcon} label="语音播报" tip={tts ? "关闭语音播报" : "开启语音播报"} onClick={() => interpretRuntime.setTts(!tts)} disabled={ended} />
      <Button variant="destructive" className="h-9 gap-2 rounded-full px-4" onClick={() => void interpretRuntime.end()} disabled={ended}>
        <PhoneOffIcon className="size-4" />
        结束
      </Button>
    </div>
  );
}

/** 状态外环颜色：倾听绿、思考蓝、说话品牌色 */
const RING: Record<string, string> = {
  idle: "ring-border",
  listening: "ring-success",
  thinking: "ring-info",
  speaking: "ring-brand",
  error: "ring-danger/60",
};

/**
 * AI 译员徽章（add-ai-avatar-and-landing D7）：头肩近景的圆形数字人，向上溢出控制条、骑在两半区的分隔线上；
 * 外环颜色随状态变化，说话 / 倾听时外环扩散。点击不触发任何动作（避免面对面使用时误触）。
 */
function InterpreterBadge() {
  const reduce = useReducedMotion();
  const { state, signals } = useInterpretAvatar();
  // AI 译员取对方（B 侧）语言的形象
  const character = useInterpretStore((s) => characterForLang(s.join?.languages[1]));
  const active = state === "speaking" || state === "listening";
  return (
    // 只向上溢出（上半区左下角通常是空白），不压住下半区的语言标签
    <div className="relative -mt-10 -mb-2 shrink-0 md:-mt-14" title="AI 译员">
      {active && !reduce && (
        <span className={cn("absolute inset-0 animate-pulse-ring rounded-full", state === "speaking" ? "bg-brand/30" : "bg-success/30")} />
      )}
      <div
        className={cn(
          "relative size-16 overflow-hidden rounded-full bg-[radial-gradient(circle_at_50%_30%,var(--color-brand-soft),var(--color-card))] shadow-popover ring-3 transition-[box-shadow] duration-300 md:size-22",
          RING[state],
        )}
      >
        <AiAvatar character={character} state={state} signals={signals} framing="badge" className="size-full" />
      </div>
    </div>
  );
}
