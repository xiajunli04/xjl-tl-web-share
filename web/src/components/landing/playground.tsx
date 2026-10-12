"use client";

import { useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useInView, useReducedMotion } from "motion/react";
import { LightbulbIcon } from "lucide-react";
import { Segmented } from "@/components/ui/segmented";
import { DURATION, EASE_OUT } from "@/components/motion/tokens";
import { useScriptPlayer } from "@/hooks/use-script-player";
import { PLAYGROUND, type SampleKey } from "@/lib/landing/fixtures";
import { duration, initialTrace, stateAt, type Step, type TraceState } from "@/lib/landing/script";
import { TraceCard } from "./trace-card";

/**
 * 交互试玩：文学与能力样例回放完整 Agent 轨迹；歧义样例回放到追问时暂停，访客点选释义后播放对应分支。
 * 分支脚本以"追问时刻的状态"为起点：把前段脚本的终态作为一个 at=0 的步骤拼在分支前面。
 */
export function Playground() {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.35 });
  const [key, setKey] = useState<SampleKey>("literary");
  const [branch, setBranch] = useState<number | null>(null);
  const sample = PLAYGROUND.find((p) => p.key === key)!;

  const steps = useMemo<Step<TraceState>[]>(() => {
    if (branch === null || !sample.branches) return sample.script;
    const paused = stateAt(sample.script, initialTrace(), duration(sample.script));
    return [{ at: 0, apply: () => paused }, ...sample.branches[branch].script];
  }, [sample, branch]);

  const player = useScriptPlayer(steps, initialTrace, { active: inView });

  return (
    <div ref={ref} className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:items-start">
      <div className="space-y-4">
        <Segmented
          ariaLabel="试玩样例"
          className="h-auto min-h-9 max-w-full flex-wrap [&>button]:h-8"
          value={key}
          onChange={(v) => {
            setKey(v);
            setBranch(null);
          }}
          options={PLAYGROUND.map((p) => ({ value: p.key, label: p.label }))}
        />
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={key}
            initial={{ opacity: 0, y: reduce ? 0 : 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduce ? 0 : -8 }}
            transition={{ duration: DURATION.page, ease: EASE_OUT }}
            className="space-y-3"
          >
            <p className="text-sm text-muted-foreground">{sample.hint}</p>
            <div className="rounded-2xl border bg-card p-4 shadow-card">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                <LightbulbIcon className="size-4 text-warning" />
                看点
              </div>
              <p className="text-sm leading-relaxed text-muted-foreground">{sample.takeaway}</p>
            </div>
            {sample.branches && (
              <p className="text-xs text-muted-foreground">
                {branch === null ? "回放到一半时，Agent 会停下来问你——点选一个答案试试。" : "换个答案再看一遍：点上方的“歧义句”重新开始。"}
              </p>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
      <TraceCard
        source={sample.source}
        sourceLabel={sample.sourceLabel}
        targetLabel={sample.targetLabel}
        sourceNote={sample.sourceNote}
        sourceAudio={sample.sourceAudio}
        targetAudio={sample.targetAudio}
        state={player.state}
        done={player.done && !player.state.question}
        onReplay={() => {
          setBranch(null);
          player.restart();
        }}
        onAnswer={(i) => setBranch(i)}
        className="min-h-[380px]"
      />
    </div>
  );
}
