"use client";

import { AnimatePresence, motion } from "motion/react";
import { FlaskConicalIcon, HeadphonesIcon, Loader2Icon, PlusIcon, WifiOffIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSpeechEngines } from "@/hooks/use-speech-engines";
import { interpretRuntime, listenOnlyHint } from "@/hooks/use-interpret-socket";
import { langName } from "@/lib/languages";
import { useInterpretStore } from "@/stores/interpret-store";
import { ChatView } from "./chat-view";
import { ConverseView } from "./converse-view";
import { ListenStage } from "./listen-stage";
import { MODE_META } from "./meta";
import { RoomView } from "./room-view";

function ConnectionChip() {
  const status = useInterpretStore((s) => s.connection);
  const attempt = useInterpretStore((s) => s.reconnectAttempt);
  const phase = useInterpretStore((s) => s.phase);
  if (phase === "summary") {
    return <span className="rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground">已结束</span>;
  }
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      {status === "connecting" || status === "idle" ? (
        <motion.span key="c" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="inline-flex items-center gap-1.5 rounded-full bg-info-soft px-2.5 py-1 text-[11px] font-medium text-info">
          <Loader2Icon className="size-3 animate-spin" />
          连接中
        </motion.span>
      ) : status === "reconnecting" ? (
        <motion.span key="r" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="inline-flex items-center gap-1.5 rounded-full bg-warning-soft px-2.5 py-1 text-[11px] font-medium text-warning">
          <WifiOffIcon className="size-3" />
          重连中（{attempt}/3）
        </motion.span>
      ) : status === "open" ? (
        <motion.span key="o" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="inline-flex items-center gap-1.5 rounded-full bg-success-soft px-2.5 py-1 text-[11px] font-medium text-success">
          <span className="size-1.5 animate-breathe rounded-full bg-success motion-safe-only" />
          实时
        </motion.span>
      ) : null}
    </AnimatePresence>
  );
}

/** 进行中：顶部信息条 + 按模式切换的布局 */
export function LiveView() {
  const join = useInterpretStore((s) => s.join);
  const phase = useInterpretStore((s) => s.phase);
  const simulated = useInterpretStore((s) => s.simulatedMic);
  const listenOnly = useInterpretStore((s) => s.listenOnly);
  const engines = useSpeechEngines();
  if (!join) return null;
  const meta = MODE_META[join.mode];
  const Icon = meta.icon;
  const engine = engines.data?.interpret.find((e) => e.id === join.engine);
  const langLabel =
    join.mode === "LISTEN"
      ? `自动识别 → ${langName(join.languages[0])}`
      : join.mode === "CONVERSE"
        ? `${langName(join.languages[0])} ⇄ ${langName(join.languages[1])}`
        : join.mode === "CHAT"
          ? `与 Lumi 用${langName(join.languages[1])}对话`
          : `我的语言：${langName(join.languages[0])}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b bg-card px-4 py-2.5 md:px-6">
        <motion.span
          layoutId={`mode-tile-${join.mode}`}
          className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand-gradient text-brand-foreground shadow-brand"
        >
          <Icon className="size-4.5" />
        </motion.span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-semibold">{meta.title}</h1>
            <ConnectionChip />
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {langLabel} · {engine?.name ?? join.engine}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {listenOnly && (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2 py-1 text-[11px] text-warning"
              title={listenOnlyHint()}
            >
              <HeadphonesIcon className="size-3" />
              仅收听
            </span>
          )}
          {simulated && (
            <span className="hidden items-center gap-1 rounded-full bg-warning-soft px-2 py-1 text-[11px] text-warning md:inline-flex">
              <FlaskConicalIcon className="size-3" />
              模拟麦克风 · 脚本化事件
            </span>
          )}
          {phase === "summary" && (
            <Button size="sm" onClick={interpretRuntime.restart}>
              <PlusIcon />
              新的同传
            </Button>
          )}
        </div>
      </div>
      {join.mode === "LISTEN" && <ListenStage />}
      {join.mode === "CONVERSE" && <ConverseView />}
      {join.mode === "ROOM" && <RoomView />}
      {join.mode === "CHAT" && <ChatView />}
    </div>
  );
}
