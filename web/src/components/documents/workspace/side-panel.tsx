"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { PanelRightCloseIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DURATION, EASE_OUT, SPRING_LAYOUT, SPRING_SHEET } from "@/components/motion/tokens";
import { useDocTaskSelector } from "@/hooks/use-doc-task";
import type { DocTaskVO } from "@/lib/api/documents";
import { activeTermCount } from "@/lib/doc-terms";
import { cn } from "@/lib/utils";
import { ConsistencyPanel } from "./consistency-panel";
import { useWorkspace, type SideTab } from "./context";
import { OverviewPanel } from "./overview-panel";
import { SegmentDetail } from "./segment-detail";
import { TermsConfirm, TermsReadonly } from "./terms-panel";
import { TracePanel } from "./trace-panel";

export const PANEL_WIDTH = 384;
export const PANEL_WIDTH_WIDE = 452;

function Count({ n, tone }: { n: number; tone?: "warning" }) {
  if (!n) return null;
  return (
    <span className={cn("rounded-full px-1.5 text-[10px] tabular-nums", tone === "warning" ? "bg-warning-soft text-warning" : "bg-foreground/5")}>
      {n}
    </span>
  );
}

/** 侧栏内容：标签页（概览 / 术语 / 一致性 / 轨迹）；选中段落时滑入段落详情 */
export function SidePanelBody({ task, onClose }: { task: DocTaskVO; onClose?: () => void }) {
  const ws = useWorkspace();
  const reduce = useReducedMotion();
  const terms = useDocTaskSelector(ws.store, (s) => s.terms);
  const awaiting = task.status === "AWAITING_CONFIRM";
  const preAnalysis = ["PENDING", "PARSING", "ANALYZING"].includes(task.status) || (task.status === "CANCELLED" && !task.summary && !terms?.length);
  const issues = task.consistencyReport?.issues.length ?? 0;
  const slide = {
    initial: { opacity: 0, x: reduce ? 0 : 16 },
    animate: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: reduce ? 0 : 16 },
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <Tabs value={ws.tab} onValueChange={(v) => ws.setTab(v as SideTab)} className="min-h-0 flex-1 gap-0">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3 pr-12 xl:pr-3">
          <TabsList className="flex-1">
            <TabsTrigger value="overview">概览</TabsTrigger>
            <TabsTrigger value="terms">
              术语
              {awaiting ? (
                <span className="size-1.5 animate-breathe rounded-full bg-warning text-warning motion-reduce:animate-none" />
              ) : (
                <Count n={activeTermCount(terms)} />
              )}
            </TabsTrigger>
            <TabsTrigger value="consistency">
              一致性
              <Count n={issues} tone="warning" />
            </TabsTrigger>
            <TabsTrigger value="trace">轨迹</TabsTrigger>
          </TabsList>
          {onClose && (
            <Button variant="ghost" size="icon-sm" aria-label="收起侧栏" onClick={onClose}>
              <PanelRightCloseIcon />
            </Button>
          )}
        </div>
        <div className="relative min-h-0 flex-1">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={ws.tab + (awaiting ? "-awaiting" : "")}
              {...slide}
              transition={{ duration: DURATION.page, ease: EASE_OUT }}
              className={cn("absolute inset-0", ws.tab === "terms" && awaiting ? "flex flex-col" : "scrollbar-thin overflow-y-auto")}
            >
              {ws.tab === "overview" && <OverviewPanel task={task} />}
              {ws.tab === "terms" &&
                (awaiting && terms ? (
                  <TermsConfirm key={terms.map((t) => t.id).join(",")} terms={terms} />
                ) : (
                  <TermsReadonly terms={terms} loading={!terms} preAnalysis={preAnalysis} />
                ))}
              {ws.tab === "consistency" && <ConsistencyPanel task={task} />}
              {ws.tab === "trace" && <TracePanel task={task} />}
            </motion.div>
          </AnimatePresence>
        </div>
      </Tabs>

      {/* 段落详情：覆盖在标签页之上滑入 */}
      <AnimatePresence>
        {ws.selectedSeq !== null && (
          <motion.div
            key="detail"
            initial={{ opacity: 0, x: reduce ? 0 : 32 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: reduce ? 0 : 32 }}
            transition={reduce ? { duration: DURATION.fast } : SPRING_SHEET}
            className="absolute inset-0 z-10 bg-surface"
          >
            <SegmentDetail seq={ws.selectedSeq} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** 宽屏下的可收起侧栏（宽度弹簧动画；术语确认时加宽） */
export function SidePanel({ open, wide, children }: { open: boolean; wide: boolean; children: React.ReactNode }) {
  const reduce = useReducedMotion();
  const width = wide ? PANEL_WIDTH_WIDE : PANEL_WIDTH;
  return (
    <motion.aside
      initial={false}
      animate={{ width: open ? width : 0, opacity: open ? 1 : 0, marginLeft: open ? 0 : -12 }}
      transition={reduce ? { duration: 0.15 } : SPRING_LAYOUT}
      className="shrink-0 overflow-hidden rounded-xl border bg-surface shadow-card"
      aria-hidden={!open}
      inert={!open}
    >
      <div className="h-full" style={{ width }}>
        {children}
      </div>
    </motion.aside>
  );
}
