"use client";

import { useRef, useState } from "react";
import { AnimatePresence, motion, useInView, useReducedMotion } from "motion/react";
import { CalculatorIcon, CheckIcon, ChevronDownIcon, CircleAlertIcon, ClockIcon, CoinsIcon, SparklesIcon, XIcon } from "lucide-react";
import { Segmented } from "@/components/ui/segmented";
import { DURATION, EASE_OUT } from "@/components/motion/tokens";
import { useScriptPlayer } from "@/hooks/use-script-player";
import {
  COMPARE,
  COMPARE_COLUMNS,
  COMPARE_TABLE,
  estimateDoc,
  estimateMeeting,
  SOURCES,
  type CompareCell,
  type CompareColumnKey,
  type CompareScenarioKey,
  type Seg,
} from "@/lib/landing/fixtures";
import type { Step } from "@/lib/landing/script";
import { cn } from "@/lib/utils";
import { ReplayBadge } from "./trace-card";

const REPLAY_MS = 2600;
/** 每个场景一份独立的步骤数组：切换场景时播放器据此从头回放 */
const PROGRESS = Object.fromEntries(
  COMPARE.map((c) => [c.key, [{ at: 0, dur: REPLAY_MS, apply: (_: number, p: number) => p }] as Step<number>[]]),
) as Record<CompareScenarioKey, Step<number>[]>;

/** 按进度截断各片段（按字符） */
function visibleSegs(segs: Seg[], progress: number): { seg: Seg; text: string; complete: boolean }[] {
  const total = segs.reduce((n, s) => n + Array.from(s.t).length, 0);
  let budget = Math.round(total * progress);
  return segs.map((seg) => {
    const chars = Array.from(seg.t);
    const take = Math.max(0, Math.min(chars.length, budget));
    budget -= take;
    return { seg, text: chars.slice(0, take).join(""), complete: take === chars.length };
  });
}

function Column({ k, cell, progress, done }: { k: CompareColumnKey; cell: CompareCell; progress: number; done: boolean }) {
  const reduce = useReducedMotion();
  const meta = COMPARE_COLUMNS.find((c) => c.key === k)!;
  const agent = k === "agent";
  const parts = visibleSegs(cell.output, progress);
  const notes = parts.filter((p) => p.complete && (p.seg.issue || p.seg.good));
  const TermIcon = cell.terms.ok === true ? CheckIcon : cell.terms.ok === false ? XIcon : CircleAlertIcon;
  return (
    <div
      className={cn(
        "relative flex flex-col rounded-2xl border bg-card p-4 shadow-card",
        agent && "border-brand/40 shadow-brand ring-1 ring-brand/20",
      )}
    >
      {agent && (
        <span className="absolute -top-2.5 left-4 inline-flex items-center gap-1 rounded-full bg-brand-gradient px-2 py-0.5 text-[10px] font-semibold text-brand-foreground shadow-brand">
          <SparklesIcon className="size-3" />
          本平台
        </span>
      )}
      <div className="mb-3">
        <div className="text-sm font-semibold">{meta.title}</div>
        <div className="text-[11px] text-muted-foreground">{meta.sub}</div>
      </div>
      <p className="min-h-20 text-sm leading-relaxed">
        {parts.map(({ seg, text, complete }, i) =>
          text ? (
            <span
              key={i}
              className={cn(
                "transition-colors duration-300",
                complete && seg.issue && "text-danger underline decoration-danger/70 decoration-wavy underline-offset-4",
                complete && seg.good && "rounded bg-success-soft px-0.5 font-medium text-success",
              )}
            >
              {text}
            </span>
          ) : null,
        )}
        {!done && <span aria-hidden className="ml-0.5 inline-block h-[0.95em] w-[2px] translate-y-[2px] animate-caret rounded-full bg-brand" />}
      </p>
      <ul className="mt-2 min-h-10 space-y-1">
        <AnimatePresence initial={false}>
          {notes.map(({ seg }) => (
            <motion.li
              key={seg.t}
              initial={{ opacity: 0, x: reduce ? 0 : -4 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: DURATION.fast, ease: EASE_OUT }}
              className={cn("flex items-start gap-1 text-[11px] leading-snug", seg.issue ? "text-danger" : "text-success")}
            >
              {seg.issue ? <CircleAlertIcon className="mt-px size-3 shrink-0" /> : <CheckIcon className="mt-px size-3 shrink-0" />}
              {seg.issue ?? seg.good}
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      <dl className="mt-auto space-y-1.5 border-t pt-3 text-xs">
        <div className="flex items-center gap-1.5">
          <ClockIcon className="size-3.5 text-muted-foreground" />
          <dt className="sr-only">耗时</dt>
          <dd>{cell.time}</dd>
        </div>
        <div className="flex items-center gap-1.5">
          <CoinsIcon className="size-3.5 text-muted-foreground" />
          <dt className="sr-only">成本</dt>
          <dd>{cell.cost}</dd>
        </div>
        <div className="flex items-center gap-1.5">
          <TermIcon
            className={cn(
              "size-3.5",
              cell.terms.ok === true ? "text-success" : cell.terms.ok === false ? "text-danger" : "text-warning",
            )}
          />
          <dt className="sr-only">术语一致性</dt>
          <dd>{cell.terms.label}</dd>
        </div>
      </dl>
    </div>
  );
}

export function CompareSection() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.3 });
  const [key, setKey] = useState<CompareScenarioKey>("doc");
  const scenario = COMPARE.find((c) => c.key === key)!;
  const player = useScriptPlayer(PROGRESS[key], 0, { active: inView });

  return (
    <div ref={ref} className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          ariaLabel="对比场景"
          value={key}
          onChange={setKey}
          options={COMPARE.map((c) => ({ value: c.key, label: c.label }))}
        />
        <ReplayBadge />
        <p className="w-full text-sm text-muted-foreground md:ml-auto md:w-auto">{scenario.context}</p>
      </div>
      <div className="rounded-xl border border-dashed bg-muted/30 px-4 py-2.5 text-sm">
        <span className="mr-2 text-xs font-medium text-muted-foreground">原文</span>
        {scenario.source}
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {COMPARE_COLUMNS.map((c) => (
          <Column key={`${key}-${c.key}`} k={c.key} cell={scenario.cells[c.key]} progress={player.state} done={player.done} />
        ))}
      </div>
      <Estimator />
      <CompareTable />
    </div>
  );
}

/* ---------------- 成本估算器 ---------------- */

const fmtUsd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

function Range({ label, value, min, max, step, onChange, format }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
}) {
  return (
    <label className="block">
      <div className="mb-2 flex items-baseline justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-semibold tabular-nums">{format(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-2 w-full cursor-pointer appearance-none rounded-full bg-muted accent-[var(--color-brand)]"
      />
    </label>
  );
}

function Estimator() {
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"doc" | "meeting">("doc");
  const [words, setWords] = useState(10_000);
  const [hours, setHours] = useState(2);
  const [langs, setLangs] = useState(3);
  const doc = estimateDoc(words);
  const meeting = estimateMeeting(hours, langs);

  return (
    <div className="rounded-2xl border bg-card shadow-card">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <span className="flex size-8 items-center justify-center rounded-lg bg-brand-soft text-brand">
          <CalculatorIcon className="size-4" />
        </span>
        <span className="flex-1">
          <span className="block text-sm font-semibold">成本估算器</span>
          <span className="block text-xs text-muted-foreground">输入文档字数或会议时长，看看人工方式要多少时间和费用</span>
        </span>
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: DURATION.fast }}>
          <ChevronDownIcon className="size-4 text-muted-foreground" />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={reduce ? { duration: 0 } : { duration: DURATION.page, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            <div className="grid gap-5 border-t px-4 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
              <div className="space-y-4">
                <Segmented
                  size="sm"
                  ariaLabel="估算类型"
                  value={kind}
                  onChange={setKind}
                  options={[
                    { value: "doc", label: "文档翻译" },
                    { value: "meeting", label: "多语会议" },
                  ]}
                />
                {kind === "doc" ? (
                  <Range label="文档字数（英文词）" value={words} min={1000} max={50_000} step={1000} onChange={setWords} format={(v) => v.toLocaleString("zh-CN")} />
                ) : (
                  <>
                    <Range label="会议时长" value={hours} min={1} max={8} step={1} onChange={setHours} format={(v) => `${v} 小时`} />
                    <Range label="会议语言数" value={langs} min={2} max={6} step={1} onChange={setLangs} format={(v) => `${v} 种`} />
                  </>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                {kind === "doc" ? (
                  <>
                    <Result title="人工翻译" lines={[`约 ${doc.humanDays.toFixed(1)} 个工作日`, `${fmtUsd(doc.humanCost[0])}–${fmtUsd(doc.humanCost[1])}`]} />
                    <Result highlight title="本平台" lines={[`约 ${Math.max(1, Math.round(doc.agentMinutes))} 分钟`, "仅模型调用费用"]} />
                  </>
                ) : (
                  <>
                    <Result title="同传译员" lines={[`${meeting.interpreters} 名译员（${(langs * (langs - 1)) / 2} 个语言方向）`, `${fmtUsd(meeting.cost[0])}–${fmtUsd(meeting.cost[1])}`]} />
                    <Result highlight title="本平台会议室" lines={["每人一台设备，随开随用", "本地识别免密钥 + 模型调用费用"]} />
                  </>
                )}
                <p className="col-span-2 text-[11px] leading-relaxed text-muted-foreground">
                  估算，仅供参考。来源：{SOURCES.map((s) => `${s.label}——${s.text}`).join("；")}。
                </p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Result({ title, lines, highlight }: { title: string; lines: string[]; highlight?: boolean }) {
  return (
    <div className={cn("rounded-xl border p-3", highlight && "border-brand/40 bg-brand-soft/60")}>
      <div className={cn("mb-1 text-xs font-medium", highlight ? "text-brand" : "text-muted-foreground")}>{title}</div>
      {lines.map((l, i) => (
        <div key={l} className={cn("tabular-nums", i === 0 ? "text-base font-semibold" : "text-xs text-muted-foreground")}>
          {l}
        </div>
      ))}
    </div>
  );
}

/* ---------------- 精简对比表 ---------------- */

function CompareTable() {
  return (
    <div className="overflow-x-auto rounded-2xl border bg-card shadow-card">
      <table className="w-full min-w-[640px] text-sm">
        <caption className="sr-only">翻译方式对比</caption>
        <thead>
          <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
            <th scope="col" className="px-4 py-2.5 font-medium">维度</th>
            {COMPARE_COLUMNS.map((c) => (
              <th key={c.key} scope="col" className={cn("px-4 py-2.5 font-medium", c.key === "agent" && "text-brand")}>
                {c.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {COMPARE_TABLE.map((r) => (
            <tr key={r.dim} className="border-b last:border-0">
              <th scope="row" className="px-4 py-2.5 text-left font-medium">{r.dim}</th>
              <td className="px-4 py-2.5 text-muted-foreground">{r.human}</td>
              <td className="px-4 py-2.5 text-muted-foreground">{r.mt}</td>
              <td className="px-4 py-2.5 text-muted-foreground">{r.llm}</td>
              <td className="bg-brand-soft/40 px-4 py-2.5 font-medium">{r.agent}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
