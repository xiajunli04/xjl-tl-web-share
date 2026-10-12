"use client";

import { useEffect, useRef } from "react";
import { useTheme } from "next-themes";
import { createGlyphField } from "@/lib/avatar/glyph-field";
import { MOOD_STYLE, settledFrame, type MascotMood } from "@/lib/avatar/mascot";
import { cn } from "@/lib/utils";
import { drawGlyphs2D } from "./glyph-render";

/**
 * 吉祥物小图标（add-platform-mascot D5）：与实时形象同一套字形粒子，用 Canvas2D 画一帧静止画面。
 * 用于气泡头像、模式卡片与设置预览；尺寸 / 情绪 / 主题变化时重画。
 * float：轻微漂浮（motion-safe）；crop="face" 只取头部。
 */
export function MascotIcon({
  mood = "idle",
  className,
  float = false,
  crop = "full",
  title,
}: {
  mood?: MascotMood;
  className?: string;
  float?: boolean;
  crop?: "full" | "face";
  title?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const paint = () => {
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      // 越小粒子越少越大，保证小尺寸下仍是清晰的"点阵脸"
      const quality = Math.min(0.5, Math.max(0.12, Math.min(r.width, r.height) / 380));
      const field = createGlyphField({ framing: crop === "face" ? "icon-face" : "icon", quality, intro: false, seed: 3 });
      const n = field.update({ frame: settledFrame(mood), dt: 0, energy: 0, mic: 0, dark, width: canvas.width, height: canvas.height, pointer: null });
      drawGlyphs2D(ctx, field.out, n, dark);
    };
    paint();
    const ro = new ResizeObserver(paint);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [mood, crop, dark]);

  return (
    <canvas
      ref={ref}
      role="img"
      aria-label={title ?? `Lumi ${MOOD_STYLE[mood].label}`}
      className={cn("block aspect-square", float && "motion-safe:animate-mascot-float", className)}
    />
  );
}
