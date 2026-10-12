"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CheckIcon, CoinsIcon, Loader2Icon, RotateCwIcon, TimerIcon, WandSparklesIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMs } from "@/components/agent/node-meta";
import { DURATION, EASE_OUT } from "@/components/motion/tokens";
import { docApi, type DocSegmentVO, type RetranslateResult } from "@/lib/api/documents";
import { toastError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { useWorkspace } from "./context";
import { renderInline } from "./inline";

const QUICK = ["更简洁", "更口语化", "更正式", "保持术语不变"];

/** 单段重译：可附加一句要求；结果出来后选择采用（PUT 保存）或放弃 */
export function RetranslateBox({ seg, onDone, compact }: { seg: DocSegmentVO; onDone?: () => void; compact?: boolean }) {
  const { id, store } = useWorkspace();
  const [instruction, setInstruction] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<RetranslateResult | null>(null);

  const run = async () => {
    setLoading(true);
    setResult(null);
    try {
      setResult(await docApi.retranslate(id, seg.seq, instruction));
    } catch (e) {
      toastError(e);
    } finally {
      setLoading(false);
    }
  };

  const adopt = async () => {
    if (!result) return;
    setSaving(true);
    try {
      const vo = await docApi.updateSegment(id, seg.seq, result.target);
      store.getState().patchSegment(seg.seq, vo ?? { target: result.target, edited: true });
      toast.success(`已采用新译文（§${seg.seq}）`);
      setResult(null);
      setInstruction("");
      onDone?.();
    } catch (e) {
      toastError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={cn("space-y-3", compact && "w-[min(360px,80vw)]")}>
      <div className="flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-lg bg-brand-soft text-brand">
          <WandSparklesIcon className="size-3.5" />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-medium">重译本段</div>
          <div className="text-[11px] text-muted-foreground">结合前后文与任务术语表，结果确认后才会保存</div>
        </div>
      </div>
      <div className="flex gap-2">
        <Input
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !loading) void run();
          }}
          placeholder="附加一句要求（可选），如：更简洁"
          maxLength={100}
          aria-label="重译要求"
          className="h-8"
        />
        <Button size="sm" className="h-8" onClick={run} disabled={loading}>
          {loading ? <Loader2Icon className="animate-spin" /> : <WandSparklesIcon />}
          {result ? "再试" : "生成"}
        </Button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {QUICK.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => setInstruction(q)}
            className={cn(
              "h-6 rounded-full border px-2.5 text-[11px] transition-colors",
              instruction === q ? "border-brand/40 bg-brand-soft text-brand" : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {q}
          </button>
        ))}
      </div>
      <AnimatePresence mode="wait" initial={false}>
        {loading && (
          <motion.div
            key="loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="space-y-2 rounded-lg border bg-muted/30 p-3"
            aria-busy="true"
          >
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-4/5" />
          </motion.div>
        )}
        {result && !loading && (
          <motion.div
            key="result"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: DURATION.page, ease: EASE_OUT }}
            className="space-y-2.5"
          >
            <div className="rounded-lg border bg-muted/30 p-2.5 text-xs leading-relaxed text-muted-foreground line-through decoration-muted-foreground/40">
              {seg.target ? renderInline(seg.target) : "（尚无译文）"}
            </div>
            <div className="rounded-lg border border-brand/30 bg-brand-soft p-2.5 text-sm leading-relaxed whitespace-pre-wrap">
              {renderInline(result.target)}
            </div>
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground tabular-nums">
              <span className="inline-flex items-center gap-1">
                <CoinsIcon className="size-3" />
                {result.usage.promptTokens + result.usage.completionTokens} tokens
              </span>
              <span className="inline-flex items-center gap-1">
                <TimerIcon className="size-3" />
                {formatMs(result.latencyMs)}
              </span>
            </div>
            <div className="flex justify-end gap-1.5">
                <Button variant="ghost" size="sm" onClick={() => setResult(null)} disabled={saving}>
                  放弃
                </Button>
                <Button variant="outline" size="sm" onClick={run} disabled={saving}>
                  <RotateCwIcon />
                  再试一次
                </Button>
                <Button size="sm" onClick={adopt} disabled={saving}>
                  {saving ? <Loader2Icon className="animate-spin" /> : <CheckIcon />}
                  采用
                </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
