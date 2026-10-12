"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { toast } from "sonner";
import { avatarAssetUrl, type CharacterId, type RigManifest } from "@/lib/avatar/characters";
import { AVATAR_STATE_LABEL, type AvatarState } from "@/lib/avatar/state";
import { avatarRender, fallbackReason, supportsWebGL } from "@/lib/avatar/support";
import { backgroundFor, viewRect, type Framing } from "@/lib/avatar/view";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui";
import { loadManifest } from "./manifest";
import type { AvatarSignals } from "./types";

/** WebGL 渲染器单独成 chunk（three.js），只在需要动态形象时下载 */
const PortraitRig = dynamic(() => import("./portrait-rig"), { ssr: false, loading: () => null });

const noop = () => () => {};

/** manifest 加载前使用的脸部窗口近似值（四个形象相近） */
const DEFAULT_FACE: RigManifest["face"] = [0.36, 0.23, 0.33, 0.17];
const IMAGE_ASPECT = 1195 / 1600;

/** 静态形态下的状态光晕（倾听绿、思考蓝、说话品牌色、出错灰） */
const STATE_GLOW: Record<AvatarState, string> = {
  idle: "opacity-0",
  listening: "opacity-100 bg-[radial-gradient(60%_40%_at_50%_100%,var(--color-success),transparent_70%)]",
  thinking: "opacity-100 bg-[radial-gradient(60%_40%_at_50%_100%,var(--color-info),transparent_70%)]",
  speaking: "opacity-100 bg-[radial-gradient(60%_40%_at_50%_100%,var(--color-brand),transparent_70%)]",
  error: "opacity-100 bg-[radial-gradient(60%_40%_at_50%_100%,var(--color-muted-foreground),transparent_70%)]",
};

export interface PortraitAvatarProps {
  /** 语言形象 */
  character: CharacterId;
  state: AvatarState;
  signals?: AvatarSignals;
  framing?: Framing;
  /** 允许点击触发开心表情 */
  interactive?: boolean;
  /** 值变化时做一次开心问候 */
  greetKey?: number;
  /** 显示状态说明（"Lumi 正在倾听"） */
  showLabel?: boolean;
  name?: string;
  className?: string;
}

/**
 * 真人立绘形象（rework-avatar-portrait-rig D5，add-platform-mascot 起默认隐藏，见 lib/avatar/feature.ts）：
 * - 先渲染静态立绘（CSS 背景，按构图裁切）作为占位，同时懒加载 WebGL 立绘渲染器，就绪后交叉淡入
 * - 偏好"静态"、reduced-motion、不支持 WebGL、加载失败或帧率过低时停留在静态立绘（带状态光晕）
 * - 切换形象时新旧立绘交叉淡入
 */
export function PortraitAvatar({
  character,
  state,
  signals,
  framing = "bust",
  interactive = false,
  greetKey,
  showLabel = false,
  name = "Lumi",
  className,
}: PortraitAvatarProps) {
  const reduce = useReducedMotion();
  const style = useUiStore((s) => s.avatarStyle);
  const webgl = useSyncExternalStore(noop, supportsWebGL, () => false);
  const [failed, setFailed] = useState<CharacterId | null>(null);
  const [lowFps, setLowFps] = useState(false);
  const [ready, setReady] = useState<CharacterId | null>(null);
  const [face, setFace] = useState<RigManifest["face"]>(DEFAULT_FACE);
  const [aspect, setAspect] = useState(IMAGE_ASPECT);
  const box = useRef<HTMLDivElement>(null);

  const env = useMemo(
    () => ({ style, reducedMotion: !!reduce, webgl, loadFailed: failed === character, lowFps }),
    [style, reduce, webgl, failed, character, lowFps],
  );
  const live = avatarRender(env) === "live";
  const showLive = live && ready === character;

  useEffect(() => {
    let alive = true;
    loadManifest(character).then(
      (m) => alive && setFace(m.face),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [character]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      if (width && height) setAspect(width / height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (env.loadFailed || lowFps) {
      const reason = fallbackReason(env);
      if (reason) toast.info(reason, { id: "avatar-fallback" });
    }
  }, [env, lowFps]);

  const bg = backgroundFor(viewRect(framing, IMAGE_ASPECT, aspect, face));

  return (
    <div className={cn("relative flex flex-col items-center", className)} data-avatar-state={state}>
      <div ref={box} className="relative size-full min-h-0 flex-1 overflow-hidden">
        {/* 静态立绘：占位与降级形态 */}
        <AnimatePresence initial={false}>
          {!showLive && (
            <motion.div
              key={`static-${character}`}
              className="absolute inset-0"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduce ? 0.15 : 0.4 }}
              role="img"
              aria-label={`${name}（${character}）`}
              style={{
                backgroundImage: `url(${avatarAssetUrl(character, "base.webp")})`,
                backgroundRepeat: "no-repeat",
                backgroundSize: bg.size,
                backgroundPosition: bg.position,
                maskImage: framing === "bust" ? "linear-gradient(to bottom, #000 86%, transparent)" : undefined,
              }}
            />
          )}
        </AnimatePresence>
        {!live && (
          <span aria-hidden className={cn("pointer-events-none absolute inset-0 transition-opacity duration-300 mix-blend-soft-light", STATE_GLOW[state])} />
        )}
        {live && (
          <motion.div
            key={`live-${character}`}
            className="absolute inset-0"
            initial={{ opacity: 0 }}
            animate={{ opacity: showLive ? 1 : 0 }}
            transition={{ duration: 0.3 }}
          >
            <PortraitRig
              character={character}
              state={state}
              signals={signals}
              framing={framing}
              interactive={interactive}
              greetKey={greetKey}
              onReady={() => setReady(character)}
              onError={() => setFailed(character)}
              onLowFps={() => setLowFps(true)}
            />
          </motion.div>
        )}
      </div>
      <p className={cn("sr-only", showLabel && "not-sr-only mt-2 text-xs text-muted-foreground")} aria-live="polite">
        {name} {AVATAR_STATE_LABEL[state]}
      </p>
    </div>
  );
}
