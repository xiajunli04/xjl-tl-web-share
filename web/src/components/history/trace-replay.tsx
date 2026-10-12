"use client";

import { useEffect, useState } from "react";
import { PauseIcon, PlayIcon, RotateCcwIcon } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { Button } from "@/components/ui/button";
import { AgentTimeline, type TimelineItem } from "@/components/agent/agent-timeline";
import { formatMs } from "@/components/agent/node-meta";
import type { TraceVO } from "@/lib/api/history";

const STEP_MS = 650;

function DetailBlock({ detail }: { detail: unknown }) {
  if (detail === null || detail === undefined) return null;
  return (
    <pre className="scrollbar-thin max-h-56 overflow-auto rounded-lg bg-muted/60 p-3 font-mono text-[11px] leading-relaxed text-foreground/80">
      {JSON.stringify(detail, null, 2)}
    </pre>
  );
}

/** Agent 轨迹回放：按 seq 顺序逐个点亮节点，可暂停 / 重播 */
export function TraceReplay({ traces }: { traces: TraceVO[] }) {
  const reduce = useReducedMotion();
  const sorted = [...traces].sort((a, b) => a.seq - b.seq);
  // revealed：已点亮的节点数；初始全部显示，点击回放后从 0 开始
  const [revealed, setRevealed] = useState(sorted.length);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      setRevealed((r) => {
        if (r >= sorted.length) {
          setPlaying(false);
          return r;
        }
        return r + 1;
      });
    }, reduce ? STEP_MS / 2 : STEP_MS);
    return () => clearInterval(t);
  }, [playing, sorted.length, reduce]);

  const items: TimelineItem[] = sorted.map((t, i) => {
    const status: TimelineItem["status"] =
      i < revealed - (playing ? 1 : 0)
        ? t.status === "skipped"
          ? "skipped"
          : t.status === "interrupted"
            ? "interrupted"
            : "completed"
        : i === revealed - 1 && playing
          ? "running"
          : "pending";
    return {
      key: `${t.seq}-${t.node}`,
      node: t.node,
      status,
      summary: status === "pending" ? undefined : t.summary,
      latencyMs: t.latencyMs,
      tokens: (t.promptTokens ?? 0) + (t.completionTokens ?? 0),
      detail: status === "completed" && t.detail ? <DetailBlock detail={t.detail} /> : undefined,
    };
  });

  const totalMs = sorted.reduce((s, t) => s + (t.latencyMs ?? 0), 0);
  const totalTokens = sorted.reduce((s, t) => s + (t.promptTokens ?? 0) + (t.completionTokens ?? 0), 0);
  const done = revealed >= sorted.length && !playing;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-xl border bg-card px-3 py-2.5 shadow-card">
        <Button
          size="sm"
          onClick={() => {
            if (playing) setPlaying(false);
            else {
              if (done) setRevealed(0);
              setPlaying(true);
            }
          }}
        >
          {playing ? <PauseIcon /> : done ? <RotateCcwIcon /> : <PlayIcon />}
          {playing ? "暂停" : done ? "回放" : "继续"}
        </Button>
        <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-brand-gradient transition-[width] duration-300 ease-out"
            style={{ width: `${sorted.length ? (revealed / sorted.length) * 100 : 0}%` }}
          />
        </div>
        <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
          {revealed}/{sorted.length} · {formatMs(totalMs)} · {totalTokens.toLocaleString()} tokens
        </span>
      </div>
      <AgentTimeline items={items} />
    </div>
  );
}
