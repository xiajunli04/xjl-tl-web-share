"use client";

import { motion, useReducedMotion } from "motion/react";
import { ArrowRightIcon, CheckIcon, LogInIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DURATION, EASE_OUT, FADE_ONLY, staggerDelay } from "@/components/motion";
import type { InterpretMode } from "@/lib/api/interpret";
import { cn } from "@/lib/utils";
import { MascotIcon } from "@/components/avatar/mascot-icon";
import { MODES, MODE_META } from "./meta";

/** 模式插画：用令牌色绘制的抽象场景（语种气泡 / 面对面 / 多人） */
function ModeArt({ mode }: { mode: InterpretMode }) {
  const Icon = MODE_META[mode].icon;
  return (
    <div className="relative h-28 overflow-hidden rounded-xl bg-brand-soft">
      <div className="absolute inset-0 bg-[radial-gradient(60%_80%_at_50%_120%,var(--color-brand-to)_0%,transparent_70%)] opacity-15" />
      {mode === "LISTEN" && (
        <>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="absolute top-1/2 left-1/2 rounded-full border border-brand/25"
              style={{ width: 64 + i * 34, height: 64 + i * 34, transform: "translate(-50%,-50%)" }}
            />
          ))}
          <span className="absolute top-4 left-6 rounded-full bg-card px-2 py-0.5 text-[10px] font-medium shadow-card">EN</span>
          <span className="absolute right-7 bottom-5 rounded-full bg-card px-2 py-0.5 text-[10px] font-medium shadow-card">日本語</span>
          <span className="absolute top-6 right-10 rounded-full bg-card px-2 py-0.5 text-[10px] font-medium shadow-card">한국어</span>
        </>
      )}
      {mode === "CONVERSE" && (
        <>
          <span className="absolute top-4 left-5 rounded-2xl rounded-bl-sm bg-card px-2.5 py-1 text-[11px] shadow-card">你好！</span>
          <span className="absolute right-5 bottom-4 rounded-2xl rounded-br-sm bg-brand-gradient px-2.5 py-1 text-[11px] text-brand-foreground shadow-brand">Hello!</span>
          <span className="absolute inset-x-8 top-1/2 h-px bg-brand/20" />
        </>
      )}
      {mode === "CHAT" && (
        <>
          <MascotIcon mood="idle" className="absolute top-1/2 left-5 size-24 -translate-y-1/2 drop-shadow-[0_6px_10px_rgba(110,90,220,0.25)]" />
          <span className="absolute top-4 right-5 rounded-2xl rounded-bl-sm bg-card px-2.5 py-1 text-[11px] shadow-card">Hi, I&apos;m Lumi!</span>
          <span className="absolute right-14 bottom-4 rounded-2xl rounded-br-sm bg-brand-gradient px-2.5 py-1 text-[11px] text-brand-foreground shadow-brand">一起练口语</span>
        </>
      )}
      {mode === "ROOM" && (
        <div className="absolute inset-x-0 bottom-3 flex justify-center -space-x-2">
          {["中", "EN", "日", "한"].map((l, i) => (
            <span
              key={l}
              className={cn(
                "flex size-8 items-center justify-center rounded-full text-[10px] font-semibold ring-2 ring-background",
                ["bg-card text-brand", "bg-success-soft text-success", "bg-info-soft text-info", "bg-warning-soft text-warning"][i],
              )}
            >
              {l}
            </span>
          ))}
        </div>
      )}
      <div
        className={cn(
          "absolute inset-0 flex justify-center",
          mode === "ROOM" ? "items-start pt-3" : "items-center",
          // AI 对话的主视觉是光球形象，图标收到右下角作为角标（保留 layoutId 的共享过渡）
          mode === "CHAT" && "pointer-events-none items-end justify-end p-3",
        )}
      >
        <motion.span
          layoutId={`mode-tile-${mode}`}
          className={cn(
            "flex items-center justify-center rounded-2xl bg-brand-gradient text-brand-foreground shadow-brand",
            mode === "CHAT" ? "size-8 rounded-xl" : "size-12",
          )}
        >
          <Icon className={mode === "CHAT" ? "size-4" : "size-6"} />
        </motion.span>
      </div>
    </div>
  );
}

/** 第一步：四张模式卡片（错开进场、悬停上浮）；会议室卡片带「输入房间码加入」入口 */
export function ModeStep({
  value,
  onPick,
  onJoin,
}: {
  value: InterpretMode;
  onPick: (m: InterpretMode) => void;
  onJoin: () => void;
}) {
  const reduce = useReducedMotion();
  return (
    // 4 张卡：两列（2+2）→ 超宽屏四列
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {MODES.map((m, i) => {
        const meta = MODE_META[m];
        const active = value === m;
        return (
          <motion.div
            key={m}
            initial={{ opacity: 0, y: reduce ? 0 : 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={reduce ? { ...FADE_ONLY, delay: staggerDelay(i) } : { duration: DURATION.page + 0.06, ease: EASE_OUT, delay: 0.04 + i * 0.07 }}
            whileHover={reduce ? undefined : { y: -4 }}
            className="group"
          >
            <div
              data-mode-card={m}
              onClick={() => onPick(m)}
              className={cn(
                "relative flex h-full cursor-pointer flex-col gap-4 rounded-2xl border bg-card p-4 text-left shadow-card transition-[box-shadow,border-color] duration-200 group-hover:shadow-popover has-[[data-pick]:focus-visible]:ring-3 has-[[data-pick]:focus-visible]:ring-ring/50",
                active && "border-brand/40 ring-1 ring-brand/20",
              )}
            >
              <ModeArt mode={m} />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-semibold">{meta.title}</h3>
                  {active && (
                    <span className="flex size-4.5 items-center justify-center rounded-full bg-brand-gradient text-brand-foreground">
                      <CheckIcon className="size-3" />
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{meta.desc}</p>
                <ul className="mt-3 space-y-1.5">
                  {meta.points.map((p) => (
                    <li key={p} className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="size-1 rounded-full bg-brand" />
                      {p}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  data-pick
                  aria-pressed={active}
                  aria-label={`选择${meta.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onPick(m);
                  }}
                  className="inline-flex items-center gap-1 rounded-md text-sm font-medium text-brand outline-none"
                >
                  选择
                  <ArrowRightIcon className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                </button>
                {m === "ROOM" && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      onJoin();
                    }}
                  >
                    <LogInIcon />
                    输入房间码加入
                  </Button>
                )}
              </div>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}
