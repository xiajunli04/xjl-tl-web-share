"use client";

import { memo, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronDownIcon, CopyIcon, CrownIcon, LinkIcon, UsersRoundIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { copyText } from "@/components/feedback/copy-button";
import { DURATION, EASE_OUT } from "@/components/motion";
import { useStickToBottom } from "@/hooks/use-stick-to-bottom";
import { normLang } from "@/lib/interpret/protocol";
import { isDisplayable, liveState, openUtterance, textIn, visibleText, type Utterance } from "@/lib/interpret/reducer";
import { langName } from "@/lib/languages";
import { cn } from "@/lib/utils";
import { useInterpretStore } from "@/stores/interpret-store";
import { ControlBar } from "./control-bar";
import { Avatar, NewMessagesPill } from "./live-bits";
import { ListeningIndicator, useLocalListening } from "./listening-indicator";
import { StreamingText, type LiveMark } from "./streaming-text";

const MAX_MEMBERS = 8;
/** 同一发言人在这段时间内的连续消息分组显示（后续条不重复头像与名字） */
const GROUP_WINDOW_MS = 60_000;

/** 会议室：成员条（弹入、说话脉冲环、语言徽章）+ 房间码 + 统一消息流 + 控制条 */
export function RoomView() {
  const myLang = useInterpretStore((s) => s.me?.lang ?? s.join?.languages[0] ?? "zh");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <MemberStrip />
      <MessageStream myLang={myLang} />
      <ControlBar lang={myLang} room />
    </div>
  );
}

function MemberStrip() {
  const reduce = useReducedMotion();
  const participants = useInterpretStore((s) => s.live.participants);
  const me = useInterpretStore((s) => s.join?.participantId);
  const code = useInterpretStore((s) => s.join?.roomCode ?? "");
  const languages = new Set(participants.map((p) => p.lang));

  const link = typeof window !== "undefined" ? `${window.location.origin}/interpret?room=${code}` : "";
  const copy = async (text: string, msg: string) => {
    if (await copyText(text)) toast.success(msg);
  };

  return (
    <div className="flex flex-wrap items-center gap-4 border-b bg-surface/60 px-4 py-3 md:px-6">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:inline-flex">
          <UsersRoundIcon className="size-3.5" />
          <span className="tabular-nums">
            {participants.length}/{MAX_MEMBERS}
          </span>
          · {languages.size} 种语言
        </span>
        <div className="scrollbar-thin flex min-w-0 items-center gap-3 overflow-x-auto py-1.5">
          <AnimatePresence initial={false} mode="popLayout">
            {participants.map((p) => (
              <motion.div
                key={p.participantId}
                layout={reduce ? false : "position"}
                initial={{ opacity: 0, scale: reduce ? 1 : 0.6 }}
                animate={{ opacity: p.online === false ? 0.45 : 1, scale: 1 }}
                exit={{ opacity: 0, scale: reduce ? 1 : 0.6 }}
                transition={reduce ? { duration: DURATION.fast } : { type: "spring", stiffness: 420, damping: 22 }}
                className="flex shrink-0 flex-col items-center gap-1"
                title={`${p.displayName} · ${langName(p.lang)}`}
              >
                <span className="relative">
                  <Avatar id={p.participantId} name={p.displayName} lang={p.lang} speaking={p.speaking} />
                  {p.isHost && (
                    <span className="absolute -top-1.5 -left-1 flex size-4 items-center justify-center rounded-full bg-warning text-warning-foreground shadow-card">
                      <CrownIcon className="size-2.5" />
                    </span>
                  )}
                </span>
                <span className={cn("max-w-16 truncate text-[11px]", p.participantId === me ? "font-medium text-brand" : "text-muted-foreground")}>
                  {p.participantId === me ? "我" : p.displayName}
                </span>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </div>
      {code && (
        <div className="flex items-center gap-1 rounded-xl border bg-card py-1 pr-1 pl-3 shadow-card">
          <span className="text-[11px] text-muted-foreground">房间码</span>
          <span className="font-mono text-base font-semibold tracking-[0.2em]">{code}</span>
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="复制房间码" onClick={() => void copy(code, "房间码已复制")} />}>
              <CopyIcon />
            </TooltipTrigger>
            <TooltipContent>复制房间码</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="复制邀请链接" onClick={() => void copy(link, "邀请链接已复制")} />}>
              <LinkIcon />
            </TooltipTrigger>
            <TooltipContent>复制邀请链接</TooltipContent>
          </Tooltip>
        </div>
      )}
    </div>
  );
}

/**
 * 统一消息流（improve-speech-endpointing-and-live-ux D9）：只渲染有可显示文字的语句（不出现空白气泡）；
 * 已开口未出字时底部显示"正在听…"，其他成员说话时显示"某某正在说话…"；同一发言人的连续消息分组；
 * 光标只出现在最后一条进行中的语句上；用户上翻时不抢滚动，显示"新消息"胶囊。
 */
function MessageStream({ myLang }: { myLang: string }) {
  const reduce = useReducedMotion();
  const utterances = useInterpretStore((s) => s.live.utterances);
  const me = useInterpretStore((s) => s.join?.participantId);
  const listening = useLocalListening();
  const talkers = useInterpretStore((s) =>
    s.live.participants
      .filter((p) => p.speaking && p.participantId !== me)
      .filter((p) => {
        const open = openUtterance(s.live, p.participantId);
        return !open || !isDisplayable(open, myLang);
      })
      .map((p) => p.displayName)
      .join("、"),
  );
  const items = useMemo(() => utterances.filter((u) => isDisplayable(u, myLang)), [utterances, myLang]);
  const activeId = useMemo(() => [...items].reverse().find((u) => liveState(u, myLang))?.id ?? null, [items, myLang]);
  const { ref, contentRef, onScroll, unread, scrollToBottom } = useStickToBottom<HTMLDivElement>(items.length, { reduce: !!reduce });

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={ref} onScroll={onScroll} className="scrollbar-thin h-full overflow-y-auto px-4 py-4 md:px-6">
        <div ref={contentRef} className="mx-auto flex min-h-full max-w-3xl flex-col">
          {!items.length && !listening && !talkers ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
              <span className="flex size-12 items-center justify-center rounded-2xl border bg-card text-brand shadow-card">
                <UsersRoundIcon className="size-5" />
              </span>
              <p className="text-sm font-medium">等待成员发言</p>
              <p className="max-w-sm text-xs text-muted-foreground">把房间码或邀请链接发给其他人；每个人都会看到自己语言（{langName(myLang)}）的字幕</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <AnimatePresence initial={false}>
                {items.map((u, i) => {
                  const prev = items[i - 1];
                  const grouped =
                    !!prev && prev.speaker?.participantId === u.speaker?.participantId && u.receivedAt - prev.receivedAt < GROUP_WINDOW_MS;
                  return (
                    <Message
                      key={u.id}
                      u={u}
                      myLang={myLang}
                      mine={!!me && u.speaker?.participantId === me}
                      grouped={grouped}
                      mark={u.id === activeId ? liveState(u, myLang) : null}
                    />
                  );
                })}
              </AnimatePresence>
            </div>
          )}
          <AnimatePresence initial={false}>
            {talkers && <ListeningIndicator key="others" mic={false} align="start" label={`${talkers} 正在说话…`} className="mt-3" />}
            {listening && <ListeningIndicator key="me" align="end" className="mt-3" />}
          </AnimatePresence>
        </div>
      </div>
      <NewMessagesPill count={unread} onClick={() => scrollToBottom()} />
    </div>
  );
}

const Message = memo(function Message({
  u,
  myLang,
  mine,
  grouped,
  mark,
}: {
  u: Utterance;
  myLang: string;
  mine: boolean;
  grouped: boolean;
  mark: LiveMark;
}) {
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(false);
  const t = textIn(u, myLang);
  // 我的语言优先：译文未到时先显示原文（淡色）
  const main = visibleText(u, myLang);
  const pending = !t.text;
  const name = u.speaker?.displayName ?? "发言人";
  const srcLang = normLang(u.lang) ?? u.speaker?.lang ?? null;

  return (
    <motion.div
      layout={reduce ? false : "position"}
      initial={{ opacity: 0, y: reduce ? 0 : 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: reduce ? 1 : 0.97, transition: { duration: DURATION.fast } }}
      transition={{ duration: DURATION.page + 0.04, ease: EASE_OUT }}
      className={cn("flex gap-3", mine && "flex-row-reverse", grouped && "-mt-2")}
    >
      {grouped ? <span className="w-7 shrink-0" aria-hidden /> : <Avatar id={u.speaker?.participantId ?? u.id} name={name} size="sm" className="mt-1" />}
      <div
        className={cn(
          "min-w-0 max-w-[80%] rounded-2xl border px-4 py-3 shadow-card",
          mine ? "bg-brand-soft" : "bg-card",
          grouped ? (mine ? "rounded-r-md" : "rounded-l-md") : mine ? "rounded-tr-md" : "rounded-tl-md",
        )}
      >
        {!grouped && (
          <div className={cn("mb-1 flex items-center gap-2 text-[11px] text-muted-foreground", mine && "flex-row-reverse")}>
            <span className="font-medium text-foreground/80">{mine ? "我" : name}</span>
            {srcLang && <span>{langName(srcLang)}</span>}
          </div>
        )}
        <p className={cn("text-base leading-relaxed transition-colors duration-300", pending && "text-muted-foreground")}>
          <StreamingText text={main} mark={mark} />
        </p>
        {!t.isSource && u.sourceFinal && (
          <>
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              原文 · {name}
              <ChevronDownIcon className={cn("size-3 transition-transform", open && "rotate-180")} />
            </button>
            <AnimatePresence initial={false}>
              {open && (
                <motion.p
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: DURATION.fast + 0.05, ease: EASE_OUT }}
                  className="overflow-hidden text-sm text-muted-foreground"
                >
                  <span className="mt-1 block border-l-2 border-brand/30 pl-2">{u.source}</span>
                </motion.p>
              )}
            </AnimatePresence>
          </>
        )}
      </div>
    </motion.div>
  );
});
