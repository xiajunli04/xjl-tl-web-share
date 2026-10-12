"use client";

import { useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { BookMarkedIcon, BrainIcon, FileTextIcon, ImageIcon, MicIcon, UsersRoundIcon, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface Card {
  key: string;
  icon: LucideIcon;
  title: string;
  desc: string;
  span: string;
  art: (on: boolean, reduce: boolean) => React.ReactNode;
}

/** 术语高亮锁定 */
function TermArt(on: boolean) {
  return (
    <p className="text-sm leading-relaxed">
      将{" "}
      <span className={cn("rounded px-1 transition-colors duration-300", on ? "bg-success-soft font-medium text-success" : "bg-muted")}>Deployment</span>{" "}
      扩容到三个
      <span className={cn("mx-0.5 rounded px-1 transition-colors delay-100 duration-300", on ? "bg-success-soft font-medium text-success" : "bg-muted")}>副本</span>
      ，并通过{" "}
      <span className={cn("rounded px-1 transition-colors delay-200 duration-300", on ? "bg-success-soft font-medium text-success" : "bg-muted")}>Service</span>{" "}
      暴露。
    </p>
  );
}

/** 记忆命中：匹配度计数 */
function MemoryArt(on: boolean, reduce: boolean) {
  return (
    <div className="space-y-1.5 text-xs">
      <div className="rounded-lg border bg-background px-2.5 py-1.5 text-muted-foreground">I bought the X300 headphones from your shop last month.</div>
      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <motion.div
            className="h-full rounded-full bg-brand-gradient"
            animate={{ width: on ? "85%" : "18%" }}
            transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 120, damping: 20 }}
          />
        </div>
        <span className="font-semibold tabular-nums text-brand">{on ? "85%" : "…"}</span>
      </div>
      <div className="text-muted-foreground">沿用记忆中的措辞：“从你们店里购买了”</div>
    </div>
  );
}

/** 断点续译：进度环暂停后继续 */
function ResumeArt(on: boolean, reduce: boolean) {
  const r = 22;
  const c = 2 * Math.PI * r;
  return (
    <div className="flex items-center gap-3">
      <svg viewBox="0 0 56 56" className="size-14 -rotate-90">
        <circle cx="28" cy="28" r={r} className="fill-none stroke-muted" strokeWidth="5" />
        <motion.circle
          cx="28"
          cy="28"
          r={r}
          className="fill-none stroke-brand"
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={c}
          animate={{ strokeDashoffset: on ? 0 : c * 0.55 }}
          transition={reduce ? { duration: 0 } : { duration: 1.2, ease: "easeInOut" }}
        />
      </svg>
      <div className="text-xs">
        <div className="font-medium">{on ? "已完成 12 / 12 块" : "已暂停 · 5 / 12 块"}</div>
        <div className="text-muted-foreground">{on ? "从断点继续，已译内容不重复" : "服务重启也不丢进度"}</div>
      </div>
    </div>
  );
}

/** 会议室：头像脉冲与逐句延迟 */
function RoomArt(on: boolean, reduce: boolean) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex -space-x-2">
        {["中", "EN", "日"].map((l, i) => (
          <span key={l} className="relative">
            {on && !reduce && i === 1 && <span className="absolute inset-0 animate-pulse-ring rounded-full bg-success/40" />}
            <span
              className={cn(
                "relative flex size-9 items-center justify-center rounded-full text-[11px] font-semibold ring-2 ring-card",
                ["bg-brand-soft text-brand", "bg-success-soft text-success", "bg-info-soft text-info"][i],
              )}
            >
              {l}
            </span>
          </span>
        ))}
      </div>
      <div className="text-xs">
        <div className="font-medium">{on ? "Emma 正在发言…" : "3 人 · 3 种语言"}</div>
        <div className="text-muted-foreground tabular-nums">逐句延迟 {on ? "2.4 s" : "--"}</div>
      </div>
    </div>
  );
}

/** 图片原位翻译：原图 / 译图擦除切换 */
function ImageArt(on: boolean, reduce: boolean) {
  return (
    <div className="relative h-20 overflow-hidden rounded-xl border bg-warning-soft">
      <div className="absolute inset-0 flex flex-col items-center justify-center text-warning">
        <span className="text-[10px] tracking-widest">CAUTION</span>
        <span className="text-sm font-bold">Wet Floor</span>
      </div>
      <motion.div
        className="absolute inset-0 flex flex-col items-center justify-center text-warning"
        // Blend with the opaque card color so the original text cannot show through.
        style={{ backgroundColor: "color-mix(in oklch, var(--color-warning) 14%, var(--color-card))" }}
        animate={{ clipPath: on ? "inset(0 0% 0 0)" : "inset(0 100% 0 0)" }}
        transition={reduce ? { duration: 0 } : { duration: 0.7, ease: "easeInOut" }}
      >
        <span className="text-[10px] tracking-widest">小心</span>
        <span className="text-sm font-bold">地面湿滑</span>
      </motion.div>
    </div>
  );
}

/** 听写朗读：声波 */
function VoiceArt(on: boolean, reduce: boolean) {
  return (
    <div className="flex h-12 items-end gap-1">
      {Array.from({ length: 18 }, (_, i) => (
        <motion.span
          key={i}
          className="w-1.5 rounded-full bg-brand/70"
          animate={{ height: on && !reduce ? [6, 10 + ((i * 7) % 30), 6] : 6 + ((i * 5) % 12) }}
          transition={on && !reduce ? { duration: 0.9, repeat: Infinity, delay: i * 0.04 } : { duration: 0.2 }}
        />
      ))}
    </div>
  );
}

const CARDS: Card[] = [
  { key: "terms", icon: BookMarkedIcon, title: "术语库", desc: "导入团队术语，命中即硬约束，评审逐条核对遵循情况", span: "md:col-span-2", art: (on) => TermArt(on) },
  { key: "memory", icon: BrainIcon, title: "翻译记忆", desc: "语义检索相似译文，沿用你确认过的措辞", span: "", art: MemoryArt },
  { key: "doc", icon: FileTextIcon, title: "长文档断点续译", desc: "全文摘要 + 专名表，分段对照编辑后导出", span: "", art: ResumeArt },
  { key: "room", icon: UsersRoundIcon, title: "同传会议室", desc: "多人多语实时字幕与语音，逐句延迟可见", span: "md:col-span-2", art: RoomArt },
  { key: "image", icon: ImageIcon, title: "图片原位翻译", desc: "拍照或上传，译文按原位覆盖", span: "md:col-span-2", art: ImageArt },
  { key: "voice", icon: MicIcon, title: "听写与朗读", desc: "本地识别免密钥，译文一键朗读", span: "", art: VoiceArt },
];

function BentoCard({ card, index }: { card: Card; index: number }) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);
  const Icon = card.icon;
  return (
    <motion.div
      ref={ref}
      tabIndex={0}
      onPointerEnter={() => setOn(true)}
      onPointerLeave={() => setOn(false)}
      onFocus={() => setOn(true)}
      onBlur={() => setOn(false)}
      onPointerMove={(e) => {
        const el = ref.current;
        if (!el || reduce) return;
        const r = el.getBoundingClientRect();
        el.style.setProperty("--x", `${e.clientX - r.left}px`);
        el.style.setProperty("--y", `${e.clientY - r.top}px`);
      }}
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-40px" }}
      transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1], delay: index * 0.05 }}
      whileHover={reduce ? undefined : { y: -3 }}
      className={cn(
        "group relative flex flex-col gap-4 overflow-hidden rounded-2xl border bg-card p-5 shadow-card outline-none transition-shadow hover:shadow-popover focus-visible:ring-3 focus-visible:ring-ring/50",
        card.span,
      )}
    >
      {/* 指针光斑 */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100 motion-reduce:hidden"
        style={{ background: "radial-gradient(240px circle at var(--x, 50%) var(--y, 50%), color-mix(in oklch, var(--color-brand) 12%, transparent), transparent 70%)" }}
      />
      <div className="relative flex items-center gap-2.5">
        <span className="flex size-9 items-center justify-center rounded-xl bg-brand-soft text-brand transition-colors group-hover:bg-brand-gradient group-hover:text-brand-foreground">
          <Icon className="size-4.5" />
        </span>
        <div>
          <div className="text-sm font-semibold">{card.title}</div>
          <div className="text-xs text-muted-foreground">{card.desc}</div>
        </div>
      </div>
      <div className="relative mt-auto">{card.art(on, !!reduce)}</div>
    </motion.div>
  );
}

export function Bento() {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {CARDS.map((c, i) => (
        <BentoCard key={c.key} card={c} index={i} />
      ))}
    </div>
  );
}
