"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  BrainCircuitIcon,
  ChevronDownIcon,
  CornerDownLeftIcon,
  GitBranchIcon,
  LanguagesIcon,
  Loader2Icon,
  MessageCircleQuestionIcon,
  MessagesSquareIcon,
  OctagonPauseIcon,
  SparklesIcon,
  WandSparklesIcon,
  WorkflowIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CopyButton } from "@/components/feedback/copy-button";
import { ErrorState } from "@/components/feedback/error-state";
import { DURATION, EASE_OUT, SPRING_LAYOUT } from "@/components/motion/tokens";
import type { SessionDetailVO } from "@/lib/api/sessions";
import { REVISE_CHIPS, type ThreadTurn, type ThreadVersion } from "@/lib/session-thread";
import { cn } from "@/lib/utils";
import { useAutoRead } from "@/hooks/use-speak";
import { SpeakButton } from "./speak-button";
import { SaveToMemoryButton, StreamingText } from "./target-panel";

const MAX_INSTRUCTION = 500;
/** 原文气泡超过该长度（或行数）时默认折叠 */
const LONG_SOURCE = 160;

/** 线程末尾正在进行的一轮 */
export interface LiveTurn {
  source: string;
  text: string;
  /** settling：已完成、等待会话详情刷新出新的一轮 */
  status: "running" | "clarify" | "error" | "stopped" | "settling";
  /** 运行中当前执行的节点名（分析 / 规划 / 翻译…） */
  step?: string;
  error?: unknown;
}

/** 示例：空会话时一键填入，演示指代与专名的跨轮一致 */
const EXAMPLES = [
  "I bought the X200 headphones from your store last week.",
  "Our new CFO, Mrs. Chen, will join the call on Friday.",
];

/** 版本条：选中滑块使用 layoutId；生成中的新版本以占位芯片显示 */
function VersionBar({
  id,
  versions,
  activeIndex,
  generating,
  disabled,
  onPick,
}: {
  id: string;
  versions: ThreadVersion[];
  activeIndex: number;
  generating?: boolean;
  disabled?: boolean;
  onPick: (v: ThreadVersion) => void;
}) {
  return (
    <div role="radiogroup" aria-label="版本" className="inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
      {versions.map((v, i) => {
        const active = i === activeIndex;
        return (
          <Tooltip key={v.id}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={disabled}
                  onClick={() => !active && onPick(v)}
                  className={cn(
                    "relative h-6 rounded-md px-2 font-mono text-[11px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed",
                    active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                />
              }
            >
              {active && (
                <motion.span
                  layoutId={`ver-${id}`}
                  className="absolute inset-0 rounded-md bg-background shadow-card ring-1 ring-foreground/5 dark:bg-input/50"
                  transition={SPRING_LAYOUT}
                />
              )}
              <span className="relative">{v.label}</span>
            </TooltipTrigger>
            <TooltipContent>
              {v.no === 1 ? "原始翻译" : `修订：${v.reviseInstruction ?? "—"}`}
              {active ? "（采用中）" : "，点击设为采用"}
            </TooltipContent>
          </Tooltip>
        );
      })}
      <AnimatePresence>
        {generating && (
          <motion.span
            key="gen"
            initial={{ opacity: 0, width: 0 }}
            animate={{ opacity: 1, width: "auto" }}
            exit={{ opacity: 0, width: 0 }}
            className="inline-flex h-6 items-center gap-1 overflow-hidden rounded-md px-2 font-mono text-[11px] text-brand"
          >
            <Loader2Icon className="size-3 animate-spin" />v{versions.length + 1}
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}

/** 原文气泡（右侧，用户一侧）：长原文默认折叠 */
function SourceBubble({ text, seq, clarified }: { text: string; seq?: number; clarified?: boolean }) {
  const long = text.length > LONG_SOURCE || text.split("\n").length > 4;
  const [open, setOpen] = useState(false);
  return (
    <div className="flex items-end justify-end gap-2 pl-10">
      {seq !== undefined && (
        <span className="mb-1.5 shrink-0 font-mono text-[10px] text-muted-foreground/70 tabular-nums">#{seq}</span>
      )}
      <div className="max-w-[85%] min-w-0 rounded-2xl rounded-tr-md bg-muted px-4 py-2.5 dark:bg-muted/60">
        <p
          className={cn(
            "text-sm leading-relaxed break-words whitespace-pre-wrap text-foreground/85",
            long && !open && "line-clamp-4",
          )}
        >
          {text}
        </p>
        {(long || clarified) && (
          <div className="mt-1 flex items-center justify-end gap-2 text-[11px] text-muted-foreground">
            {clarified && (
              <span className="inline-flex items-center gap-0.5 text-warning">
                <MessageCircleQuestionIcon className="size-3" />
                已澄清
              </span>
            )}
            {long && (
              <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                className="inline-flex items-center gap-0.5 hover:text-foreground"
              >
                <ChevronDownIcon className={cn("size-3 transition-transform", open && "rotate-180")} />
                {open ? "收起" : "展开全文"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 译文一侧（左侧，Agent 一侧）：品牌头像 + 内容 */
function AgentRow({ children, highlighted }: { children: React.ReactNode; highlighted?: boolean }) {
  return (
    <div className="flex gap-3 pr-2">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand">
        <LanguagesIcon className="size-3.5" />
      </span>
      <div
        className={cn(
          "-mx-2 min-w-0 flex-1 rounded-xl px-2 py-1 transition-colors duration-500",
          highlighted && "bg-brand-soft/40",
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** 修订面板：在该轮下方就地展开（快捷芯片 + 自定义要求） */
function RevisePanel({
  turn,
  busy,
  onSubmit,
  onClose,
}: {
  turn: ThreadTurn;
  busy?: boolean;
  onSubmit: (instruction: string) => void;
  onClose: () => void;
}) {
  const reduce = useReducedMotion();
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus({ preventScroll: true }), []);
  const submit = (t: string) => {
    const s = t.trim();
    if (!s || busy || s.length > MAX_INSTRUCTION) return;
    onSubmit(s);
    setValue("");
  };
  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: reduce ? DURATION.fast : DURATION.page, ease: EASE_OUT }}
      className="overflow-hidden"
    >
      <div className="mt-2 space-y-2 rounded-xl border bg-card p-2.5 shadow-card">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-0.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <WandSparklesIcon className="size-3 text-brand" />
            基于 {turn.adopted.label} 修订
          </span>
          {REVISE_CHIPS.map((c) => (
            <motion.button
              key={c}
              type="button"
              whileTap={reduce ? undefined : { scale: 0.94 }}
              disabled={busy}
              onClick={() => submit(c)}
              className="h-6 rounded-full border bg-background px-2.5 text-[11px] text-foreground/80 transition-colors hover:border-brand/40 hover:bg-brand-soft hover:text-brand disabled:pointer-events-none disabled:opacity-50"
            >
              {c}
            </motion.button>
          ))}
          <Button variant="ghost" size="icon-xs" className="ml-auto text-muted-foreground" aria-label="收起修订" onClick={onClose}>
            <XIcon />
          </Button>
        </div>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit(value);
          }}
        >
          <Input
            ref={inputRef}
            value={value}
            maxLength={MAX_INSTRUCTION}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && onClose()}
            disabled={busy}
            placeholder={`说说怎么改，例如"把「坏了」换成更委婉的说法"`}
            aria-label="修订要求"
            className="h-8 text-sm"
          />
          <Button type="submit" size="sm" disabled={busy || !value.trim()}>
            <CornerDownLeftIcon />
            修订
          </Button>
        </form>
      </div>
    </motion.div>
  );
}

function TurnItem({
  sessionId,
  turn,
  targetLang,
  latest,
  highlighted,
  revising,
  reviseOpen,
  busy,
  onToggleRevise,
  onRevise,
  onAdopt,
}: {
  sessionId: number;
  turn: ThreadTurn;
  targetLang: string;
  latest: boolean;
  highlighted: boolean;
  /** 本轮修订进行中：流式的新译文（空字符串表示还没有首字） */
  revising: string | null;
  reviseOpen: boolean;
  busy?: boolean;
  onToggleRevise: () => void;
  onRevise: (instruction: string) => void;
  onAdopt: (v: ThreadVersion) => void;
}) {
  const reduce = useReducedMotion();
  const [detailOpen, setDetailOpen] = useState(false);
  const v = turn.adopted;
  const hasDetail = !!v.reviseInstruction || !!turn.clarification;
  const showVersions = turn.versions.length > 1 || revising !== null;
  // 最新一轮、选中、修订中的轮次常显操作栏；其余悬停 / 聚焦时显示（触屏设备常显）
  const pinned = latest || highlighted || reviseOpen || revising !== null;

  return (
    <motion.li
      layout={reduce ? false : "position"}
      initial={{ opacity: 0, y: reduce ? 0 : 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.22, ease: EASE_OUT }}
      data-seq={turn.seq}
      className="group space-y-2.5"
    >
      <SourceBubble text={turn.source} seq={turn.seq} clarified={!!turn.clarification} />
      <AgentRow highlighted={highlighted}>
        {/* 版本切换 / 修订流式：译文交叉淡化 */}
        <div className="relative grid">
          <AnimatePresence initial={false} mode="popLayout">
            {revising ? (
              <motion.p
                key="revising"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="text-[15px] leading-7 break-words whitespace-pre-wrap [grid-area:1/1]"
              >
                <StreamingText text={revising} streaming />
              </motion.p>
            ) : (
              <motion.p
                key={v.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: revising === "" ? 0.45 : 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: DURATION.fast, ease: "linear" }}
                className="text-[15px] leading-7 break-words whitespace-pre-wrap [grid-area:1/1]"
              >
                {v.targetText}
              </motion.p>
            )}
          </AnimatePresence>
        </div>

        <div className="mt-1.5 -ml-1.5 flex flex-wrap items-center gap-1">
          {/* 朗读常驻可见（不依赖悬停，触屏也能直接点）；其余操作悬停 / 聚焦时显示 */}
          <SpeakButton id={`turn:${v.id}`} text={v.targetText} lang={targetLang} label="朗读译文" />
          <div
            className={cn(
              "flex min-w-0 flex-1 flex-wrap items-center gap-1 transition-opacity duration-200",
              pinned
                ? "opacity-100"
                : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100",
            )}
          >
          <CopyButton text={v.targetText} label="复制译文" />
          <SaveToMemoryButton recordId={v.id} compact />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant={reviseOpen ? "secondary" : "ghost"}
                  size="xs"
                  aria-expanded={reviseOpen}
                  disabled={busy && !reviseOpen}
                  onClick={onToggleRevise}
                  className={cn("text-muted-foreground", reviseOpen && "text-brand")}
                />
              }
            >
              <WandSparklesIcon />
              修订
            </TooltipTrigger>
            <TooltipContent>对这一轮提出修改要求，生成新版本</TooltipContent>
          </Tooltip>
          {showVersions && (
            <span className="ml-1">
              <VersionBar
                id={`${sessionId}-${turn.seq}`}
                versions={turn.versions}
                activeIndex={turn.adoptedIndex}
                generating={revising !== null}
                disabled={busy}
                onPick={onAdopt}
              />
            </span>
          )}
          <span className="ml-auto flex items-center gap-2">
            {v.reviewScore != null && (
              <Tooltip>
                <TooltipTrigger render={<span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground tabular-nums" />}>
                  <SparklesIcon className="size-3" />
                  {v.reviewScore}
                </TooltipTrigger>
                <TooltipContent>评审得分</TooltipContent>
              </Tooltip>
            )}
            {hasDetail && (
              <button
                type="button"
                onClick={() => setDetailOpen((o) => !o)}
                aria-expanded={detailOpen}
                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
              >
                <ChevronDownIcon className={cn("size-3 transition-transform", detailOpen && "rotate-180")} />
                {v.reviseInstruction && turn.clarification ? "修订与追问" : v.reviseInstruction ? "修订要求" : "追问问答"}
              </button>
            )}
          </span>
          </div>
        </div>

        <AnimatePresence initial={false}>
          {detailOpen && hasDetail && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: DURATION.page, ease: EASE_OUT }}
              className="overflow-hidden"
            >
              <div className="mt-1.5 space-y-1.5 rounded-lg bg-muted/50 px-3 py-2 text-xs">
                {v.reviseInstruction && (
                  <div className="flex gap-1.5">
                    <WandSparklesIcon className="mt-0.5 size-3 shrink-0 text-brand" />
                    <span>
                      <span className="text-muted-foreground">{v.label} 修订要求：</span>
                      {v.reviseInstruction}
                    </span>
                  </div>
                )}
                {turn.clarification && (
                  <div className="flex gap-1.5">
                    <MessageCircleQuestionIcon className="mt-0.5 size-3 shrink-0 text-warning" />
                    <span>
                      <span className="text-muted-foreground">{turn.clarification.question}</span>
                      <span className="ml-1 font-medium">→ {turn.clarification.answer}</span>
                    </span>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {reviseOpen && <RevisePanel key="revise" turn={turn} busy={busy} onSubmit={onRevise} onClose={onToggleRevise} />}
        </AnimatePresence>
      </AgentRow>
    </motion.li>
  );
}

/** 进行中的一轮：流式译文 / 追问卡片 / 失败重试 / 已停止 */
function LiveItem({
  live,
  seq,
  clarifySlot,
  onRetry,
  onShowProcess,
}: {
  live: LiveTurn;
  seq: number;
  clarifySlot?: React.ReactNode;
  onRetry?: () => void;
  onShowProcess?: () => void;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.li
      key="live"
      initial={{ opacity: 0, y: reduce ? 0 : 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.22, ease: EASE_OUT }}
      className="space-y-2.5"
    >
      {live.source && <SourceBubble text={live.source} seq={seq} />}
      <AgentRow>
        {live.status === "clarify" ? (
          (clarifySlot ?? (
            <p className="flex items-center gap-1.5 py-1 text-sm text-muted-foreground">
              <MessageCircleQuestionIcon className="size-3.5 text-warning" />
              等待你回答追问…
            </p>
          ))
        ) : live.status === "error" ? (
          <ErrorState compact title="这一轮翻译失败" error={live.error} onRetry={onRetry} />
        ) : (
          <>
            {live.status === "running" && (
              <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                <span className="relative flex size-2">
                  {!reduce && <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand/60" />}
                  <span className="relative inline-flex size-2 rounded-full bg-brand" />
                </span>
                <AnimatePresence mode="wait" initial={false}>
                  <motion.span
                    key={live.step ?? "start"}
                    initial={{ opacity: 0, y: reduce ? 0 : 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: reduce ? 0 : -4 }}
                    transition={{ duration: DURATION.fast }}
                  >
                    {live.step ? `${live.step}中…` : "Agent 正在准备…"}
                  </motion.span>
                </AnimatePresence>
                {onShowProcess && (
                  <button
                    type="button"
                    onClick={onShowProcess}
                    className="inline-flex items-center gap-0.5 text-brand/80 hover:text-brand"
                  >
                    <WorkflowIcon className="size-3" />
                    查看过程
                  </button>
                )}
              </div>
            )}
            {live.text ? (
              <p
                className={cn(
                  "text-[15px] leading-7 break-words whitespace-pre-wrap",
                  live.status === "stopped" && "text-muted-foreground",
                )}
                aria-live="polite"
              >
                <StreamingText text={live.text} streaming={live.status === "running"} />
              </p>
            ) : (
              live.status === "running" && (
                <div className="space-y-2 pt-1" aria-hidden>
                  <Skeleton className="h-3.5 w-11/12" />
                  <Skeleton className="h-3.5 w-2/3" />
                </div>
              )
            )}
            {live.status === "settling" && (
              <p className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                <Loader2Icon className="size-3 animate-spin" />
                正在写入会话…
              </p>
            )}
            {live.status === "stopped" && (
              <p className="mt-1 flex items-center gap-1.5 text-xs text-warning">
                <OctagonPauseIcon className="size-3.5" />
                已停止，这一轮不会写入会话
              </p>
            )}
          </>
        )}
      </AgentRow>
    </motion.li>
  );
}

function MemoryPopover({ detail }: { detail: SessionDetailVO }) {
  const entities = Array.isArray(detail.memoryEntities) ? detail.memoryEntities : [];
  if (!detail.memorySummary && !entities.length) return null;
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="ghost" size="xs" className="text-muted-foreground" />}>
        <BrainCircuitIcon />
        <span className="hidden @md:inline">会话记忆</span>
        {entities.length > 0 && <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums">{entities.length}</span>}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-3 p-3.5">
        {detail.memorySummary && (
          <div>
            <div className="mb-1 text-[11px] font-medium text-muted-foreground">
              早期摘要{detail.memorizedUntil ? `（已压缩第 1–${detail.memorizedUntil} 轮）` : ""}
            </div>
            <p className="text-xs leading-relaxed">{detail.memorySummary}</p>
          </div>
        )}
        {entities.length > 0 && (
          <div>
            <div className="mb-1 text-[11px] font-medium text-muted-foreground">会话专名表</div>
            <ul className="space-y-1">
              {entities.map((e) => (
                <li key={`${e.source}-${e.target}`} className="flex items-center gap-1.5 text-xs">
                  <span className="font-medium">{e.source}</span>
                  <span className="text-muted-foreground">→</span>
                  <span>{e.target}</span>
                  {e.note && <span className="ml-auto truncate text-[11px] text-muted-foreground">{e.note}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** 新会话的欢迎区：说明会话翻译的能力，并提供示例一键填入 */
function EmptyHero({ onExample }: { onExample?: (text: string) => void }) {
  const reduce = useReducedMotion();
  const features = [
    { icon: MessagesSquareIcon, title: "携带前文", desc: "指代、专名与语气跨轮一致" },
    { icon: GitBranchIcon, title: "逐轮修订", desc: "对任意一轮提要求，版本可回退" },
    { icon: MessageCircleQuestionIcon, title: "歧义先问", desc: "拿不准时先向你确认再翻译" },
  ];
  return (
    <motion.div
      initial={{ opacity: 0, y: reduce ? 0 : 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DURATION.page, ease: EASE_OUT }}
      className="mx-auto flex min-h-full max-w-xl flex-col items-center justify-center gap-5 px-4 py-10 text-center short:gap-3 short:py-5"
    >
      <span className="flex size-12 items-center justify-center rounded-2xl bg-brand-soft text-brand shadow-card short:size-10">
        <MessagesSquareIcon className="size-6" />
      </span>
      <div>
        <p className="text-base font-semibold">开始一段会话翻译</p>
        <p className="mt-1 text-sm text-muted-foreground">在下方输入第一句原文，发送后自动创建会话</p>
      </div>
      {/* 矮屏隐藏能力卡片，只保留标题与示例，保证输入框和示例在首屏 */}
      <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-3 short:hidden">
        {features.map((f, i) => (
          <motion.div
            key={f.title}
            initial={{ opacity: 0, y: reduce ? 0 : 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: reduce ? 0 : 0.06 * (i + 1), duration: DURATION.page, ease: EASE_OUT }}
            className="rounded-xl border bg-background/60 px-3 py-2.5 text-left"
          >
            <f.icon className="size-4 text-brand" />
            <p className="mt-1.5 text-xs font-medium">{f.title}</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{f.desc}</p>
          </motion.div>
        ))}
      </div>
      {onExample && (
        <div className="flex w-full flex-col gap-1.5">
          <p className="text-[11px] text-muted-foreground">试试这句</p>
          {EXAMPLES.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => onExample(e)}
              className="rounded-lg border border-dashed px-3 py-2 text-left text-xs text-foreground/80 transition-colors hover:border-brand/40 hover:bg-brand-soft/50 hover:text-brand"
            >
              {e}
            </button>
          ))}
        </div>
      )}
    </motion.div>
  );
}

/**
 * 对话线程（聊天式）：原文气泡在右、译文在左；每轮下方是操作栏（朗读 / 复制 / 存入记忆 / 修订 / 版本），
 * 修订面板就地展开；进行中的一轮（流式、追问、失败、停止）接在末尾。
 */
export function SessionThread({
  sessionId,
  detail,
  loading,
  error,
  onRetry,
  turns,
  targetLang,
  highlightSeq,
  onAdopt,
  onRevise,
  onToggleClarify,
  live,
  clarifySlot,
  onRetryLive,
  onShowProcess,
  revising,
  busy,
  onExample,
}: {
  sessionId: number | null;
  detail?: SessionDetailVO;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  turns: ThreadTurn[];
  targetLang: string;
  /** 需要高亮并滚动到的轮次（「打开会话」定位） */
  highlightSeq: number | null;
  onAdopt: (turn: ThreadTurn, v: ThreadVersion) => void;
  onRevise: (turn: ThreadTurn, instruction: string) => void;
  onToggleClarify: (v: boolean) => void;
  live?: LiveTurn | null;
  /** 追问卡片（进行中的一轮等待回答时显示） */
  clarifySlot?: React.ReactNode;
  onRetryLive?: () => void;
  onShowProcess?: () => void;
  /** 修订进行中的轮次与流式文本 */
  revising?: { seq: number; text: string } | null;
  busy?: boolean;
  onExample?: (text: string) => void;
}) {
  const reduce = useReducedMotion();
  const listRef = useRef<HTMLDivElement>(null);
  // 展开修订面板的轮次（记录所属会话，切换会话后自然收起）
  const [reviseAt, setReviseAt] = useState<{ sessionId: number | null; seq: number } | null>(null);
  const reviseSeq = reviseAt?.sessionId === sessionId ? reviseAt.seq : null;
  const setReviseSeq = (seq: number | null) => setReviseAt(seq === null ? null : { sessionId, seq });
  const count = turns.length;
  const liveKey = live ? `${live.status}` : "";
  const liveText = live?.text ?? "";
  // 完成后自动朗读：最新一轮采用的版本变化时（新一轮完成或修订完成）朗读，切换会话不触发
  const latestVersion = turns.at(-1)?.adopted;
  useAutoRead({
    scope: sessionId === null ? null : String(sessionId),
    doneKey: latestVersion ? String(latestVersion.id) : null,
    id: latestVersion ? `turn:${latestVersion.id}` : "turn:none",
    text: latestVersion?.targetText ?? "",
    lang: targetLang,
  });

  // 新一轮出现 / 进行中卡片状态变化时滚动到底部
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  }, [count, liveKey, reduce]);

  // 流式输出时：用户停留在底部附近才跟随（向上翻阅时不打扰）
  useEffect(() => {
    const el = listRef.current;
    if (!el || !liveText) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [liveText]);

  // 「打开会话」定位：把该轮滚动到视区中部
  useEffect(() => {
    if (highlightSeq === null) return;
    const card = listRef.current?.querySelector(`[data-seq="${highlightSeq}"]`);
    card?.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
  }, [highlightSeq, reduce, count]);

  const empty = sessionId === null || (!loading && !error && !count && !live);

  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-4">
        <MessagesSquareIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-sm font-medium">{sessionId === null ? "新会话" : (detail?.title ?? "会话")}</span>
        {sessionId !== null && count > 0 && (
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground tabular-nums">{count} 轮</span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {detail && <MemoryPopover detail={detail} />}
          {detail && (
            <Tooltip>
              <TooltipTrigger render={<label className="flex cursor-pointer items-center gap-1.5 pl-1 text-xs text-muted-foreground" />}>
                <MessageCircleQuestionIcon className="size-3.5" />
                <span className="hidden @md:inline">歧义追问</span>
                <Switch
                  size="sm"
                  checked={detail.clarifyEnabled !== false}
                  onCheckedChange={(v) => onToggleClarify(v)}
                  aria-label="允许歧义追问"
                />
              </TooltipTrigger>
              <TooltipContent>开启后，遇到不澄清就可能译错的歧义时，Agent 会先向你确认</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      <div ref={listRef} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 md:px-6" aria-busy="true">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="space-y-3">
                <div className="flex justify-end">
                  <Skeleton className="h-10 w-2/3 rounded-2xl" />
                </div>
                <div className="flex gap-3">
                  <Skeleton className="size-7 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-1/2" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="px-4 py-8">
            <ErrorState compact error={error} onRetry={onRetry} title="无法加载会话" />
          </div>
        ) : empty ? (
          <EmptyHero onExample={onExample} />
        ) : (
          <ol className="mx-auto w-full max-w-3xl space-y-5 px-4 py-5 md:px-6" aria-label="对话线程">
            <AnimatePresence initial={false}>
              {turns.map((t, i) => (
                <TurnItem
                  key={t.seq}
                  sessionId={sessionId}
                  turn={t}
                  targetLang={targetLang}
                  latest={i === turns.length - 1 && !live}
                  highlighted={t.seq === highlightSeq}
                  revising={revising?.seq === t.seq ? revising.text : null}
                  reviseOpen={reviseSeq === t.seq}
                  busy={busy}
                  onToggleRevise={() => setReviseSeq(reviseSeq === t.seq ? null : t.seq)}
                  onRevise={(instruction) => {
                    onRevise(t, instruction);
                    setReviseSeq(null);
                  }}
                  onAdopt={(v) => onAdopt(t, v)}
                />
              ))}
              {live && (
                <LiveItem
                  key="live"
                  live={live}
                  seq={count + 1}
                  clarifySlot={clarifySlot}
                  onRetry={onRetryLive}
                  onShowProcess={onShowProcess}
                />
              )}
            </AnimatePresence>
          </ol>
        )}
      </div>
    </div>
  );
}
