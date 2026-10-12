"use client";

import { useEffect, useState } from "react";
import { useReducedMotion } from "motion/react";
import type { CharacterId } from "@/lib/avatar/characters";
import { HUMAN_AVATAR_ENABLED } from "@/lib/avatar/feature";
import { MOOD_STYLE, type MascotMood } from "@/lib/avatar/mascot";
import type { AvatarState } from "@/lib/avatar/state";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui";
import GlyphMascot from "./glyph-mascot";
import { PortraitAvatar } from "./portrait-avatar";
import type { AvatarSignals } from "./types";

export interface AiAvatarProps {
  state: AvatarState;
  signals?: AvatarSignals;
  /** stage：全身舞台；badge：圆形徽章（只取身体，无字符环与阴影） */
  framing?: "stage" | "badge";
  /** 允许拖拽 / 点击 / 键盘互动 */
  interactive?: boolean;
  /** 值变化时做一次开心问候 */
  greetKey?: number;
  /** 外部情绪覆盖（首页演示） */
  mood?: MascotMood | null;
  /** 显示状态说明 */
  showLabel?: boolean;
  name?: string;
  className?: string;
  /** 真人形象开关打开时使用的语言形象（默认隐藏） */
  character?: CharacterId;
}

/**
 * AI 数字人（add-platform-mascot D4 / D5）：默认是平台吉祥物 Lumi——字形粒子生命体。
 * - 始终由代码实时生成：WebGL 不可用时换 Canvas2D，帧率低时降粒子密度，画风不变，不用图片兜底
 * - 偏好"静态"或 reduced-motion：只画稳定帧（still），情绪变化时重画
 * - 可交互时容器可聚焦，Enter / 空格问候；静止时问候改为短暂开心
 */
export function AiAvatar(props: AiAvatarProps) {
  if (HUMAN_AVATAR_ENABLED && props.character) {
    return (
      <PortraitAvatar
        character={props.character}
        state={props.state}
        signals={props.signals}
        framing={props.framing === "badge" ? "portrait" : "bust"}
        interactive={props.interactive}
        greetKey={props.greetKey}
        showLabel={props.showLabel}
        name={props.name}
        className={props.className}
      />
    );
  }
  return <MascotAvatar {...props} />;
}

function MascotAvatar({
  state,
  signals,
  framing = "stage",
  interactive = false,
  greetKey,
  mood,
  showLabel = false,
  name = "Lumi",
  className,
}: AiAvatarProps) {
  const reduce = useReducedMotion();
  const style = useUiStore((s) => s.avatarStyle);
  const still = style === "static" || !!reduce;
  const [localGreet, setLocalGreet] = useState(0);
  const [shownMood, setShownMood] = useState<MascotMood>(mood ?? state);
  const [stillHappy, setStillHappy] = useState(false);
  const labelMood: MascotMood = stillHappy ? "happy" : shownMood;

  useEffect(() => {
    if (!stillHappy) return;
    const t = setTimeout(() => setStillHappy(false), 1100);
    return () => clearTimeout(t);
  }, [stillHappy]);

  const greet = () => {
    if (still) setStillHappy(true);
    else setLocalGreet((g) => g + 1);
  };

  return (
    <div
      className={cn("relative flex flex-col items-center outline-none", interactive && "rounded-3xl focus-visible:ring-3 focus-visible:ring-ring/50", className)}
      data-avatar-state={state}
      data-mascot-mood={labelMood}
      data-avatar-render={still ? "still" : "live"}
      tabIndex={interactive ? 0 : undefined}
      role={interactive ? "button" : undefined}
      aria-label={`${name} ${MOOD_STYLE[labelMood].label}${interactive ? "，按回车和我打招呼" : ""}`}
      onKeyDown={(e) => {
        if (interactive && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          greet();
        }
      }}
      onClick={() => interactive && still && greet()}
    >
      <div className="relative size-full min-h-0 flex-1">
        <GlyphMascot
          state={state}
          mood={stillHappy ? "happy" : mood}
          signals={signals}
          framing={framing}
          interactive={interactive}
          greetKey={(greetKey ?? 0) + localGreet}
          still={still}
          onMood={setShownMood}
        />
      </div>
      <p className={cn("sr-only", showLabel && "not-sr-only mt-2 text-xs text-muted-foreground")} aria-live="polite">
        {name} {MOOD_STYLE[labelMood].label}
      </p>
    </div>
  );
}
