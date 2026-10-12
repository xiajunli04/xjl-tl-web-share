"use client";

import { motion, useReducedMotion } from "motion/react";
import { FlaskConicalIcon, KeyRoundIcon, WorkflowIcon, ZapIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/feedback/error-state";
import { DURATION, EASE_OUT, SPRING_LAYOUT, staggerDelay } from "@/components/motion";
import type { EngineInfo } from "@/lib/api/speech";
import { CHAT_ENGINE, REALTIME_CHAT_ENGINE } from "@/lib/interpret/setup";
import { cn } from "@/lib/utils";

const COPY: Record<string, { title: string; badge: string; desc: string; icon: typeof ZapIcon }> = {
  [CHAT_ENGINE]: {
    title: "平台级联",
    badge: "可选回复模型",
    desc: "识别 → 对话模型 → 合成，可选回复模型与响应速度，更可控",
    icon: WorkflowIcon,
  },
  [REALTIME_CHAT_ENGINE]: {
    title: "实时语音模型",
    badge: "最快",
    desc: "端到端语音模型直接听、直接说，说完约 0.5 s 开口，语气更自然",
    icon: ZapIcon,
  },
};

/**
 * AI 对话的引擎双卡片（improve-speech-playback-latency 8.3）：平台级联 / 实时语音模型。
 * 选中项以 layoutId 指示器滑动；不可用置灰并显示原因，悬停时轻微抖动提示；未联调的厂商显示"实验"徽章。
 */
export function ChatEngineCards({
  engines,
  value,
  onChange,
  loading,
  error,
  onRetry,
}: {
  engines: EngineInfo[];
  value: string;
  onChange: (id: string) => void;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
}) {
  const reduce = useReducedMotion();
  if (loading) {
    return (
      <div className="grid gap-2 sm:grid-cols-2">
        <Skeleton className="h-32 rounded-xl" />
        <Skeleton className="h-32 rounded-xl" />
      </div>
    );
  }
  if (error) return <ErrorState title="引擎列表加载失败" error={error} onRetry={onRetry} />;

  const cards = [CHAT_ENGINE, REALTIME_CHAT_ENGINE].map(
    (id) =>
      engines.find((e) => e.id === id) ??
      // 后端尚未提供实时语音模型（旧版本）：仍展示卡片并说明需要配置
      ({ id, type: "chat", name: COPY[id].title, vendor: "", kind: "config", available: false, reason: "需要管理员配置实时语音对话模型", languages: [], modelConfigId: null } satisfies EngineInfo),
  );

  return (
    <div role="radiogroup" aria-label="对话引擎" className="grid gap-2 sm:grid-cols-2">
      {cards.map((e, i) => {
        const copy = COPY[e.id];
        const Icon = copy.icon;
        const active = e.id === value;
        const experimental = e.id === REALTIME_CHAT_ENGINE && e.available && e.tested === false;
        return (
          <motion.button
            key={e.id}
            type="button"
            role="radio"
            aria-checked={active}
            aria-disabled={!e.available}
            initial={{ opacity: 0, y: reduce ? 0 : 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: DURATION.page, ease: EASE_OUT, delay: staggerDelay(i) }}
            whileHover={!e.available && !reduce ? { x: [0, -3, 3, -2, 0], transition: { duration: 0.35 } } : undefined}
            onClick={() => e.available && onChange(e.id)}
            className={cn(
              "relative flex flex-col items-start gap-2 rounded-xl border bg-card p-3.5 text-left outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
              e.available ? "hover:bg-muted/50" : "cursor-not-allowed",
              active && "border-transparent",
            )}
          >
            {active && (
              <motion.span
                layoutId="chat-engine-active"
                transition={SPRING_LAYOUT}
                className="absolute inset-0 rounded-xl bg-brand-soft ring-1 ring-brand/40"
              />
            )}
            <span className={cn("relative flex w-full items-center gap-2", !e.available && "opacity-55")}>
              <span
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-lg",
                  active ? "bg-brand-gradient text-brand-foreground shadow-brand" : "bg-muted text-muted-foreground",
                )}
              >
                <Icon className="size-4" />
              </span>
              <span className="text-sm font-medium">{copy.title}</span>
              <span className="ml-auto flex items-center gap-1">
                {experimental && (
                  <span className="inline-flex h-5 items-center gap-1 rounded-full bg-warning-soft px-1.5 text-[10px] font-medium text-warning">
                    <FlaskConicalIcon className="size-3" />
                    实验
                  </span>
                )}
                <span
                  className={cn(
                    "inline-flex h-5 items-center rounded-full px-1.5 text-[10px] font-medium whitespace-nowrap",
                    e.id === REALTIME_CHAT_ENGINE ? "bg-success-soft text-success" : "bg-info-soft text-info",
                  )}
                >
                  {copy.badge}
                </span>
              </span>
            </span>
            <span className={cn("relative text-xs leading-relaxed text-muted-foreground", !e.available && "opacity-55")}>
              {copy.desc}
            </span>
            {!e.available ? (
              <span className="relative flex items-start gap-1.5 rounded-lg bg-warning-soft px-2 py-1.5 text-[11px] leading-relaxed text-warning">
                <KeyRoundIcon className="mt-0.5 size-3 shrink-0" />
                <span>
                  {e.reason ?? "当前不可用"}
                  {e.id === REALTIME_CHAT_ENGINE && "；请管理员在模型配置中添加「实时语音对话（REALTIME_CHAT）」"}
                </span>
              </span>
            ) : (
              <span className="relative text-[11px] text-muted-foreground">
                {e.vendor && `${e.vendor} · `}
                {e.languages.length} 种语言
                {e.id === REALTIME_CHAT_ENGINE && " · 按音频时长计费"}
              </span>
            )}
          </motion.button>
        );
      })}
    </div>
  );
}
