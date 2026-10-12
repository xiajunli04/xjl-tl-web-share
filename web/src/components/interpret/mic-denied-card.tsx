"use client";

import { motion, useReducedMotion } from "motion/react";
import { LockIcon, MicOffIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DURATION, EASE_OUT } from "@/components/motion";
import type { MicErrorKind } from "@/lib/audio/capture";

const COPY: Record<MicErrorKind, { title: string; desc: string }> = {
  denied: { title: "麦克风权限被拒绝", desc: "同声传译需要使用麦克风收音。请按下面的步骤在浏览器中允许访问，然后重试。" },
  nodevice: { title: "没有找到麦克风", desc: "请连接耳机麦克风或外置麦克风，并在系统声音设置中确认输入设备可用。" },
  busy: { title: "麦克风被占用", desc: "麦克风可能正被会议软件或其他标签页使用，关闭后重试。" },
  unsupported: { title: "当前环境无法录音", desc: "请使用最新版 Chrome / Edge / Safari，并通过 HTTPS 或 localhost 访问本平台。" },
};

const STEPS = [
  { icon: LockIcon, text: "点击地址栏左侧的锁形 / 设置图标" },
  { icon: MicOffIcon, text: "在「网站设置」中把「麦克风」改为「允许」" },
  { icon: RotateCcwIcon, text: "回到本页点击「重试」" },
];

/** 麦克风权限引导卡片（spec：麦克风被拒绝时显示引导与重试） */
export function MicDeniedCard({ kind, onRetry, onClose }: { kind: MicErrorKind; onRetry: () => void; onClose: () => void }) {
  const reduce = useReducedMotion();
  const copy =
    kind === "unsupported" && typeof window !== "undefined" && !window.isSecureContext
      ? {
          title: "当前页面无法使用麦克风",
          desc: "通过 http 局域网地址打开时，浏览器只允许在 HTTPS 或 localhost 下录音。请改用 https 地址打开（开发环境用 pnpm dev:lan 启动）；多语会议室可直接以仅收听方式加入。",
        }
      : COPY[kind];
  return (
    <motion.div
      initial={{ opacity: 0, y: reduce ? 0 : -8, height: 0 }}
      animate={{ opacity: 1, y: 0, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: DURATION.page + 0.04, ease: EASE_OUT }}
      className="overflow-hidden"
      role="alert"
    >
      <div className="relative mb-5 flex flex-col gap-4 rounded-2xl border border-danger/25 bg-danger-soft p-4 sm:flex-row sm:items-start">
        <span className="relative flex size-11 shrink-0 items-center justify-center">
          <span className="absolute inset-0 animate-pulse-ring rounded-xl bg-danger/25 motion-reduce:hidden" />
          <span className="relative flex size-11 items-center justify-center rounded-xl bg-card text-danger shadow-card">
            <MicOffIcon className="size-5" />
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-danger">{copy.title}</h3>
          <p className="mt-1 text-sm leading-relaxed text-foreground/80">{copy.desc}</p>
          {kind === "denied" && (
            <ol className="mt-3 grid gap-2 sm:grid-cols-3">
              {STEPS.map((s, i) => (
                <li key={s.text} className="flex items-start gap-2 rounded-lg bg-card/80 px-3 py-2 text-xs shadow-card">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-danger text-[10px] font-semibold text-danger-foreground">{i + 1}</span>
                  <span className="leading-relaxed">{s.text}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className="flex shrink-0 gap-2 sm:flex-col">
          <Button onClick={onRetry}>
            <RotateCcwIcon />
            重试
          </Button>
          <Button variant="ghost" size="icon" aria-label="关闭提示" onClick={onClose} className="absolute top-2 right-2 sm:static">
            <XIcon />
          </Button>
        </div>
      </div>
    </motion.div>
  );
}
