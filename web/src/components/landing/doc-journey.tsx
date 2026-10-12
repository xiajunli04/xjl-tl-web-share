"use client";

import { useRef, useState } from "react";
import { AnimatePresence, motion, useMotionValueEvent, useReducedMotion, useScroll } from "motion/react";
import { BookOpenTextIcon, PencilLineIcon, ScissorsIcon, SparklesIcon, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface JourneyStep {
  icon: LucideIcon;
  title: string;
  desc: string;
  card: React.ReactNode;
}

const STEPS: JourneyStep[] = [
  {
    icon: ScissorsIcon,
    title: "按结构切分",
    desc: "按标题、段落和代码块把 Markdown 切成语义完整的块，代码与链接原样保留。",
    card: (
      <div className="space-y-2">
        {["# Deployment 概述", "## 更新 Deployment", "```yaml … ```", "## 回滚"].map((l, i) => (
          <div key={l} className={cn("rounded-lg border px-3 py-2 font-mono text-xs", i === 2 ? "bg-muted text-muted-foreground" : "bg-background")}>
            {l}
          </div>
        ))}
      </div>
    ),
  },
  {
    icon: BookOpenTextIcon,
    title: "先通读全文",
    desc: "生成全文摘要与专名表，确定领域和译法——就像译者动笔前先读完整篇文章。",
    card: (
      <div className="space-y-2 text-xs">
        <div className="rounded-lg bg-brand-soft/60 px-3 py-2">摘要：介绍 Deployment 的创建、更新与回滚……</div>
        <div className="grid grid-cols-2 gap-1.5">
          {["Deployment → 保留", "ReplicaSet → 保留", "rollout → 上线", "Pod → 保留"].map((t) => (
            <span key={t} className="rounded-md bg-info-soft px-2 py-1 font-medium text-info">
              {t}
            </span>
          ))}
        </div>
      </div>
    ),
  },
  {
    icon: SparklesIcon,
    title: "分段翻译",
    desc: "每块带着前文、摘要和术语表翻译；混合策略并行处理，耗时减少 46%。",
    card: (
      <div className="space-y-2">
        {[100, 100, 64, 0].map((w, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span className="w-10 text-muted-foreground">块 {i + 1}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-brand-gradient" style={{ width: `${w}%` }} />
            </div>
          </div>
        ))}
      </div>
    ),
  },
  {
    icon: PencilLineIcon,
    title: "对照编辑与导出",
    desc: "原文译文逐段对照，可就地修改或单段重译，确认后一键导出。",
    card: (
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-lg border bg-background p-2 text-muted-foreground">When you update the Deployment…</div>
        <div className="rounded-lg border border-brand/40 bg-brand-soft/50 p-2">更新 Deployment 时……</div>
      </div>
    ),
  },
];

/**
 * 一份长文档的旅程：左侧 sticky 示意卡、右侧四个步骤文案；滚动进度决定当前步骤（不劫持滚动），
 * 示意卡在步骤间交叉淡入。reduced-motion 下同样切换，只是没有位移。
 */
export function DocJourney() {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 60%", "end 60%"] });
  const [active, setActive] = useState(0);
  useMotionValueEvent(scrollYProgress, "change", (p) => setActive(Math.min(STEPS.length - 1, Math.max(0, Math.floor(p * STEPS.length)))));
  const step = STEPS[active];

  return (
    <div ref={ref} className="grid gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="md:sticky md:top-28 md:self-start">
        <div className="relative min-h-56 overflow-hidden rounded-2xl border bg-card p-5 shadow-popover">
          <div className="mb-4 flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">deployment.md · 5 块</span>
            <span className="ml-auto flex gap-1">
              {STEPS.map((_, i) => (
                <span key={i} className={cn("h-1.5 rounded-full transition-all duration-300", i === active ? "w-5 bg-brand" : "w-1.5 bg-muted")} />
              ))}
            </span>
          </div>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={active}
              initial={{ opacity: 0, y: reduce ? 0 : 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: reduce ? 0 : -8 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            >
              {step.card}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
      <ol className="space-y-6 md:space-y-24 md:py-10">
        {STEPS.map((s, i) => (
          <li
            key={s.title}
            className={cn("flex gap-4 rounded-2xl p-3 transition-opacity duration-300", i === active ? "opacity-100" : "md:opacity-45")}
            aria-current={i === active ? "step" : undefined}
          >
            <span
              className={cn(
                "flex size-10 shrink-0 items-center justify-center rounded-xl transition-colors duration-300",
                i === active ? "bg-brand-gradient text-brand-foreground shadow-brand" : "bg-muted text-muted-foreground",
              )}
            >
              <s.icon className="size-4.5" />
            </span>
            <div>
              <div className="text-xs text-muted-foreground">第 {i + 1} 步</div>
              <h3 className="text-lg font-semibold">{s.title}</h3>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{s.desc}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
