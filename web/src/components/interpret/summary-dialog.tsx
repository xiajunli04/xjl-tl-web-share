"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
import { CheckIcon, ClockIcon, HistoryIcon, MessageSquareTextIcon, RotateCcwIcon, TimerIcon, WorkflowIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NumberTicker } from "@/components/motion/number-ticker";
import { DURATION, EASE_OUT, staggerDelay } from "@/components/motion";
import { interpretRuntime } from "@/hooks/use-interpret-socket";
import { formatDuration } from "@/lib/interpret/reducer";
import { REALTIME_CHAT_ENGINE } from "@/lib/interpret/setup";
import { useInterpretStore } from "@/stores/interpret-store";
import { END_REASON } from "./meta";

/** 结束摘要：时长、句数、平均延迟；「查看记录」跳转历史的同传标签 */
export function SummaryDialog() {
  const router = useRouter();
  const reduce = useReducedMotion();
  const summary = useInterpretStore((s) => s.summary);
  const phase = useInterpretStore((s) => s.phase);
  const engine = useInterpretStore((s) => s.join?.engine);
  // 关闭对话框后停留在已结束的字幕页，可回顾内容
  const [dismissed, setDismissed] = useState<object | null>(null);
  const open = phase === "summary" && !!summary && dismissed !== summary;
  if (!summary) return null;

  const stats = [
    { icon: ClockIcon, label: "时长", node: <span className="tabular-nums">{formatDuration(summary.durationMs)}</span> },
    { icon: MessageSquareTextIcon, label: "句数", node: <NumberTicker value={summary.utterances} /> },
    {
      icon: TimerIcon,
      label: "平均延迟",
      node: summary.avgE2eMs === null ? <span>--</span> : <NumberTicker value={summary.avgE2eMs / 1000} decimals={1} suffix=" s" />,
    },
  ];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && setDismissed(summary)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="items-center text-center">
          <motion.span
            initial={{ scale: reduce ? 1 : 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 380, damping: 18 }}
            className="mb-1 flex size-12 items-center justify-center rounded-2xl bg-brand-gradient text-brand-foreground shadow-brand"
          >
            <CheckIcon className="size-6" />
          </motion.span>
          <DialogTitle>{END_REASON[summary.reason] ?? "同传已结束"}</DialogTitle>
          <DialogDescription>
            {summary.canViewHistory ? "完整的双语转写已保存到翻译历史的「同传」标签。" : "会议记录由主持人保存。"}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-3 gap-2">
          {stats.map((s, i) => (
            <motion.div
              key={s.label}
              initial={{ opacity: 0, y: reduce ? 0 : 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: DURATION.page, ease: EASE_OUT, delay: 0.1 + staggerDelay(i) * 2 }}
              className="rounded-xl border bg-card px-3 py-3 text-center shadow-card"
            >
              <s.icon className="mx-auto mb-1.5 size-4 text-brand" />
              <div className="text-lg font-semibold">{s.node}</div>
              <div className="text-[11px] text-muted-foreground">{s.label}</div>
            </motion.div>
          ))}
        </div>
        {summary.reason === "error" && engine === REALTIME_CHAT_ENGINE && (
          <p className="rounded-lg bg-warning-soft px-3 py-2 text-xs leading-relaxed text-warning">
            实时语音模型连接中断且重连失败。可以改用平台级联（识别 → 对话模型 → 合成）继续练习。
          </p>
        )}
        <DialogFooter>
          {summary.reason === "error" && engine === REALTIME_CHAT_ENGINE && (
            <Button variant="outline" onClick={interpretRuntime.restartWithCascade}>
              <WorkflowIcon />
              切换到平台级联重新开始
            </Button>
          )}
          <Button variant="outline" onClick={interpretRuntime.restart}>
            <RotateCcwIcon />
            再来一次
          </Button>
          {summary.canViewHistory && (
            <Button
              onClick={() => {
                interpretRuntime.restart();
                router.push("/history?tab=interpret");
              }}
            >
              <HistoryIcon />
              查看记录
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
