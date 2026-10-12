"use client";

import { useRef } from "react";
import { useInView, useReducedMotion } from "motion/react";
import { PlayIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useScriptPlayer } from "@/hooks/use-script-player";
import { HERO_SCRIPT, HERO_SOURCE } from "@/lib/landing/fixtures";
import { initialTrace } from "@/lib/landing/script";
import { scrollToId } from "./marketing-header";
import { TraceCard } from "./trace-card";

/** Hero 右侧：进入视口自动播放一次 Agent 轨迹，播完可重播 */
export function HeroTrace() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.3 });
  const player = useScriptPlayer(HERO_SCRIPT, initialTrace, { active: inView });
  return (
    <div ref={ref} className="relative">
      {/* 背后的柔光：只做装饰 */}
      <div aria-hidden className="absolute -inset-6 -z-10 rounded-[2rem] bg-[radial-gradient(60%_60%_at_60%_40%,var(--color-brand-soft),transparent_70%)]" />
      <TraceCard sourceAudio="/audio/literary-source-en.mp3" targetAudio="/audio/literary-target-zh.mp3" sourceLabel="原文 · 英语散文" targetLabel="译文 · 中文文学表达" source={HERO_SOURCE} state={player.state} done={player.done} onReplay={player.restart} />
    </div>
  );
}

/** 次 CTA：平滑滚动到交互试玩 */
export function SeeHowButton() {
  const reduce = useReducedMotion();
  return (
    <Button variant="outline" size="lg" className="h-11 rounded-full px-6 text-base" onClick={() => scrollToId("demo", reduce)}>
      <PlayIcon />
      看它如何工作
    </Button>
  );
}
