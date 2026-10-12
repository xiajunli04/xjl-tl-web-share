"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, useAnimationControls, useReducedMotion } from "motion/react";
import { HistoryIcon, Loader2Icon, PlayIcon, SquareIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DURATION, EASE_OUT } from "@/components/motion";
import { interpretRuntime } from "@/hooks/use-interpret-socket";
import { interpretApi } from "@/lib/api/interpret";
import { INTERPRET_HISTORY_QUERY_KEY } from "@/lib/api/interpret-history";
import { toastError } from "@/lib/errors";
import { elapsedLabel } from "@/lib/interpret/resume";
import { langName } from "@/lib/languages";
import { useInterpretStore } from "@/stores/interpret-store";
import { MODE_META } from "./meta";

export const INTERPRET_ACTIVE_QUERY_KEY = ["interpret-active"] as const;

/**
 * 进行中会话的恢复卡片：刷新页面或离开后回到同传页时，提示「继续」或「结束并重新开始」；
 * 创建时遇到"已有进行中的会话"（A0214）会刷新并以抖动提示用户。
 */
export function ResumeCard() {
  const reduce = useReducedMotion();
  const qc = useQueryClient();
  const conflictAt = useInterpretStore((s) => s.conflictAt);
  const phase = useInterpretStore((s) => s.phase);
  const controls = useAnimationControls();
  const [busy, setBusy] = useState<"resume" | "end" | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const q = useQuery({
    queryKey: INTERPRET_ACTIVE_QUERY_KEY,
    queryFn: interpretApi.active,
    staleTime: 0,
    retry: false,
    enabled: phase === "setup",
  });
  const session = q.data;

  // 冲突时刷新并抖动提示
  useEffect(() => {
    if (!conflictAt) return;
    void q.refetch().then(() => {
      if (reduce) return;
      void controls.start({ x: [0, -8, 8, -5, 5, 0], transition: { duration: 0.45 } });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conflictAt]);

  useEffect(() => {
    if (!session) return;
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, [session]);

  if (!session || phase !== "setup") return null;
  const meta = MODE_META[session.mode];
  const Icon = meta.icon;
  const langs =
    session.mode === "CONVERSE" ? session.languages.map((l) => langName(l)).join(" ⇄ ") : session.languages.map((l) => langName(l)).join("、");

  const resume = async () => {
    setBusy("resume");
    try {
      await interpretRuntime.resume(session);
    } finally {
      setBusy(null);
      void qc.invalidateQueries({ queryKey: INTERPRET_ACTIVE_QUERY_KEY });
    }
  };

  const endIt = async () => {
    setBusy("end");
    try {
      await interpretApi.end(session.id);
      toast.success("已结束上一场同传", { description: "转写已保存到翻译历史的「同传」标签" });
      useInterpretStore.getState().patch({ conflictAt: null });
      await qc.invalidateQueries({ queryKey: INTERPRET_ACTIVE_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: INTERPRET_HISTORY_QUERY_KEY });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: reduce ? 0 : -8, height: 0 }}
      animate={{ opacity: 1, y: 0, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: DURATION.page + 0.04, ease: EASE_OUT }}
      className="overflow-hidden"
      role="status"
      aria-live="polite"
    >
      <motion.div
        animate={controls}
        className={
          "relative mb-5 flex flex-col gap-4 rounded-2xl border border-brand/30 bg-brand-soft p-4 sm:flex-row sm:items-center " +
          (conflictAt ? "ring-3 ring-brand/30" : "")
        }
      >
        <span className="relative flex size-11 shrink-0 items-center justify-center">
          <span className="absolute inset-0 animate-pulse-ring rounded-xl bg-brand/25 motion-reduce:hidden" />
          <span className="relative flex size-11 items-center justify-center rounded-xl bg-card text-brand shadow-card">
            <Icon className="size-5" />
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">你有一场进行中的{meta.title}</h3>
            <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[11px] text-success">
              <span className="size-1.5 animate-pulse rounded-full bg-success motion-reduce:animate-none" />
              进行中
            </span>
          </div>
          <p className="mt-1 text-sm text-foreground/80">
            {session.title ?? langs}
            <span className="text-muted-foreground"> · {elapsedLabel(session.startedAt, now)}</span>
            {session.roomCode && <span className="text-muted-foreground"> · 房间码 {session.roomCode}</span>}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {conflictAt ? "同一时间只能进行一场同传。" : "可能是刷新或离开了页面。"}继续后已识别的字幕会恢复；结束后转写保存在翻译历史中。
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button onClick={resume} disabled={!!busy}>
            {busy === "resume" ? <Loader2Icon className="animate-spin" /> : <PlayIcon />}
            继续同传
          </Button>
          <Button variant="outline" onClick={endIt} disabled={!!busy}>
            {busy === "end" ? <Loader2Icon className="animate-spin" /> : <SquareIcon />}
            结束并重新开始
          </Button>
          <Button variant="ghost" size="icon" aria-label="查看历史" nativeButton={false} render={<Link href="/history?tab=interpret" />}>
            <HistoryIcon />
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}
