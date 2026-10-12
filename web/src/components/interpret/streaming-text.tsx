"use client";

import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";
import { Caret } from "./live-bits";

/**
 * 与上一次文本的稳定前缀长度（improve-speech-endpointing-and-live-ux D9）：最长公共前缀；
 * 拉丁文字落在单词中间时回退到词首，避免半个词闪烁。
 */
export function stablePrefix(prev: string, next: string): number {
  let n = 0;
  const max = Math.min(prev.length, next.length);
  while (n < max && prev[n] === next[n]) n++;
  if (n > 0 && n < next.length && /[\p{L}\p{N}]/u.test(next[n]) && /[A-Za-z\p{N}]/u.test(next[n - 1])) {
    while (n > 0 && /[A-Za-z\p{N}'’]/u.test(next[n - 1])) n--;
  }
  return n;
}

export type LiveMark = "live" | "hold" | null;

/**
 * 流式文本：稳定前缀正常显示，变化的尾部以浅色淡入（整句不闪烁重排）；
 * mark = live 时末尾显示光标，hold（等待续说）时显示呼吸点，null（已定稿）时全部正常显示。
 */
export function StreamingText({ text, mark, className }: { text: string; mark: LiveMark; className?: string }) {
  const reduce = useReducedMotion();
  // 记录上一次渲染的文本（渲染期间对比更新，见 React 文档"存储前一次渲染的信息"）
  const [snap, setSnap] = useState({ text, cut: text.length });
  if (snap.text !== text) setSnap({ text, cut: stablePrefix(snap.text, text) });
  const cut = Math.min(snap.cut, text.length);
  const stable = mark ? text.slice(0, cut) : text;
  const tail = mark ? text.slice(cut) : "";
  return (
    <span className={className}>
      {stable}
      {tail &&
        (reduce ? (
          <span className="opacity-60">{tail}</span>
        ) : (
          <motion.span key={cut} initial={{ opacity: 0.25 }} animate={{ opacity: 0.6 }} transition={{ duration: 0.12 }}>
            {tail}
          </motion.span>
        ))}
      {mark === "live" && <Caret />}
      {mark === "hold" && <HoldDots />}
    </span>
  );
}

/** 等待续说的呼吸点（reduced-motion 下为静态省略号） */
export function HoldDots({ className }: { className?: string }) {
  const reduce = useReducedMotion();
  if (reduce) return <span className={cn("ml-0.5 text-brand", className)}>…</span>;
  return (
    <span aria-label="等待继续说" className={cn("ml-1 inline-flex translate-y-[-1px] items-center gap-[3px] align-middle", className)}>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="size-[4px] rounded-full bg-brand"
          animate={{ opacity: [0.3, 1, 0.3] }}
          transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut", delay: i * 0.2 }}
        />
      ))}
    </span>
  );
}
