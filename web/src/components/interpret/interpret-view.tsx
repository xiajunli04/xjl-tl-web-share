"use client";

import { useSearchParams } from "next/navigation";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react";
import { DURATION, EASE_OUT } from "@/components/motion";
import { useInterpretSocket } from "@/hooks/use-interpret-socket";
import { isRoomCode } from "@/lib/api/interpret";
import { useInterpretStore } from "@/stores/interpret-store";
import { LiveView } from "./live-view";
import { SetupWizard } from "./setup-wizard";
import { SummaryDialog } from "./summary-dialog";

/** /interpret 同声传译：准备（卡片向导）→ 进行中（按模式切换布局）→ 结束摘要 */
export function InterpretView() {
  useInterpretSocket();
  const reduce = useReducedMotion();
  const phase = useInterpretStore((s) => s.phase);
  const room = useSearchParams().get("room")?.toUpperCase();
  const live = phase === "live" || phase === "summary";

  return (
    <LayoutGroup>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={live ? "live" : "setup"}
            initial={{ opacity: 0, scale: reduce ? 1 : 0.985 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: reduce ? 1 : 1.01 }}
            transition={{ duration: DURATION.page + 0.06, ease: EASE_OUT }}
            className="flex min-h-0 flex-1 flex-col"
          >
            {live ? <LiveView /> : <SetupWizard initialRoom={room && isRoomCode(room) ? room : undefined} />}
          </motion.div>
        </AnimatePresence>
        <SummaryDialog />
      </div>
    </LayoutGroup>
  );
}
