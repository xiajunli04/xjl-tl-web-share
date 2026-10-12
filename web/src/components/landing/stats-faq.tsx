"use client";

import { useRef, useState } from "react";
import { AnimatePresence, motion, useInView, useReducedMotion } from "motion/react";
import { ChevronDownIcon } from "lucide-react";
import { NumberTicker } from "@/components/motion/number-ticker";
import { DURATION, EASE_OUT } from "@/components/motion/tokens";
import { FAQ, STATS, type StatItem } from "@/lib/landing/fixtures";
import { cn } from "@/lib/utils";

function Stat({ item, index }: { item: StatItem; index: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.6 });
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: DURATION.page, ease: EASE_OUT, delay: index * 0.05 }}
      className="flex flex-col rounded-2xl border bg-card p-5 shadow-card"
    >
      <div className="text-3xl font-semibold tracking-tight tabular-nums md:text-4xl">
        <span className="bg-brand-gradient bg-clip-text text-transparent">
          {item.prefix}
          <NumberTicker value={inView ? item.value : 0} decimals={item.decimals ?? 0} suffix={item.suffix} />
        </span>
      </div>
      <div className="mt-1 text-sm font-medium">{item.label}</div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{item.detail}</p>
      <p className="mt-auto pt-3 text-[11px] text-muted-foreground/80">出处：{item.source}</p>
    </motion.div>
  );
}

export function Stats() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {STATS.map((s, i) => (
        <Stat key={s.label} item={s} index={i} />
      ))}
    </div>
  );
}

export function Faq() {
  const reduce = useReducedMotion();
  const [open, setOpen] = useState<number | null>(0);
  return (
    <div className="divide-y rounded-2xl border bg-card shadow-card">
      {FAQ.map((f, i) => {
        const on = open === i;
        return (
          <div key={f.q}>
            <button
              type="button"
              aria-expanded={on}
              onClick={() => setOpen(on ? null : i)}
              className="flex w-full items-center gap-3 px-5 py-4 text-left text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <span className="flex-1">{f.q}</span>
              <motion.span animate={{ rotate: on ? 180 : 0 }} transition={{ duration: DURATION.fast }}>
                <ChevronDownIcon className={cn("size-4", on ? "text-brand" : "text-muted-foreground")} />
              </motion.span>
            </button>
            <AnimatePresence initial={false}>
              {on && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={reduce ? { duration: 0 } : { duration: DURATION.page, ease: EASE_OUT }}
                  className="overflow-hidden"
                >
                  <p className="px-5 pb-4 text-sm leading-relaxed text-muted-foreground">{f.a}</p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
}
