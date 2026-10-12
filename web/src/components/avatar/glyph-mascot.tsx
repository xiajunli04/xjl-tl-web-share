"use client";

import { useEffect, useRef } from "react";
import { useTheme } from "next-themes";
import { createGlyphField, type FieldFraming, type GlyphField } from "@/lib/avatar/glyph-field";
import { pseudoVisemes, visemesFromSpectrum } from "@/lib/avatar/lipsync";
import { createMascotAnimator, settledFrame, type MascotMood } from "@/lib/avatar/mascot";
import type { AvatarState } from "@/lib/avatar/state";
import { createFpsMonitor } from "@/lib/avatar/support";
import { createCanvasRenderer, createWebGLRenderer, type GlyphRenderer } from "./glyph-render";
import type { AvatarSignals } from "./types";

export interface GlyphMascotProps {
  state: AvatarState;
  mood?: MascotMood | null;
  signals?: AvatarSignals;
  framing: "stage" | "badge";
  interactive?: boolean;
  greetKey?: number;
  /** 静止：减少动效 / 用户偏好静态时只画稳定的一帧（仍由代码实时生成），情绪变化时重画 */
  still?: boolean;
  onMood?: (mood: MascotMood) => void;
}

/** 低帧率时逐级降低粒子密度与分辨率（画风不变）；最后一级再把帧率限到 30 */
const QUALITY_STEPS = [1, 0.6, 0.35];

/**
 * 字形粒子吉祥物（add-platform-mascot D4）：
 * 字符雨聚拢入场；指针靠近时字形被拨开，眼睛跟随指针；拖动 3D 旋转（惯性 + 回正）；
 * 点击 / 回车问候（开心 + 粒子炸开再聚拢 + 星星）；离开视口或页面隐藏时暂停。
 */
export default function GlyphMascot(props: GlyphMascotProps) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  const darkRef = useRef(dark);
  const greetRef = useRef<(() => void) | null>(null);
  const redrawRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    latest.current = props;
  });
  useEffect(() => {
    darkRef.current = dark;
    redrawRef.current?.();
  }, [dark]);
  useEffect(() => {
    redrawRef.current?.();
  }, [props.state, props.mood]);
  useEffect(() => {
    if (props.greetKey) greetRef.current?.();
  }, [props.greetKey]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const framing: FieldFraming = props.framing;
    const still = !!props.still;
    let disposed = false;
    let raf = 0;
    let level = 0;
    const coarse = window.matchMedia?.("(pointer: coarse)").matches;
    const baseQuality = (framing === "stage" ? 1 : 0.55) * (coarse ? 0.7 : 1);
    let dprCap = 2;

    let renderer: GlyphRenderer;
    const mount = (r: GlyphRenderer) => {
      renderer = r;
      el.appendChild(r.canvas);
    };
    const fallback = () => {
      // WebGL 上下文丢失：换成 Canvas2D，粒子减半，画风不变
      if (disposed || renderer.kind === "canvas") return;
      renderer.dispose();
      mount(createCanvasRenderer());
      level = Math.max(level, 1);
      field = makeField(false);
      layout();
      redraw();
    };
    mount(createWebGLRenderer(fallback) ?? createCanvasRenderer());

    const makeField = (intro: boolean): GlyphField =>
      createGlyphField({ framing, quality: baseQuality * QUALITY_STEPS[level] * (renderer.kind === "canvas" ? 0.6 : 1), intro: intro && !still });
    let field = makeField(true);

    let W = 1;
    let H = 1;
    let rect = el.getBoundingClientRect();
    const layout = () => {
      rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const dpr = Math.min(dprCap, window.devicePixelRatio || 1);
      W = Math.round(rect.width * dpr);
      H = Math.round(rect.height * dpr);
      renderer.resize(W, H);
    };
    const ro = new ResizeObserver(() => {
      layout();
      redraw();
    });
    ro.observe(el);
    layout();

    let lastMood: MascotMood | null = null;
    const reportMood = (m: MascotMood) => {
      if (m !== lastMood) {
        lastMood = m;
        latest.current.onMood?.(m);
      }
    };

    /* ---- 静止模式：只画稳定帧 ---- */
    function redraw() {
      if (!still || disposed) return;
      const p = latest.current;
      const frame = settledFrame(p.mood ?? p.state);
      reportMood(frame.mood);
      const n = field.update({ frame, dt: 0, energy: 0, mic: 0, dark: darkRef.current, width: W, height: H, pointer: null });
      renderer.draw(field.out, n, darkRef.current);
    }
    if (still) {
      redrawRef.current = redraw;
      redraw();
      return () => {
        disposed = true;
        redrawRef.current = null;
        ro.disconnect();
        renderer.dispose();
      };
    }

    /* ---- 实时模式 ---- */
    const anim = createMascotAnimator();
    greetRef.current = () => anim.greet();

    let inView = true;
    const io = new IntersectionObserver(([e]) => {
      inView = e.isIntersecting;
      schedule();
    });
    io.observe(el);
    const onVisibility = () => schedule();
    document.addEventListener("visibilitychange", onVisibility);

    let pointer: { x: number; y: number } | null = null;
    let pointerTimer: ReturnType<typeof setTimeout> | undefined;
    let local: { x: number; y: number } | null = null;
    let hover = false;
    let dragging: { x: number; moved: number; last: number } | null = null;
    let lastGreet = 0;

    const onMove = (e: PointerEvent) => {
      const span = Math.max(window.innerWidth, window.innerHeight) * 0.45;
      pointer = {
        x: Math.max(-1, Math.min(1, (e.clientX - (rect.left + rect.width / 2)) / span)),
        y: Math.max(-1, Math.min(1, -(e.clientY - (rect.top + rect.height * 0.42)) / span)),
      };
      clearTimeout(pointerTimer);
      pointerTimer = setTimeout(() => (pointer = null), 3000);
      const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
      local = inside && latest.current.interactive ? { x: (e.clientX - rect.left) * (W / rect.width), y: (e.clientY - rect.top) * (H / rect.height) } : null;
      if (dragging) {
        const now = performance.now();
        const dx = e.clientX - dragging.x;
        dragging.moved += Math.abs(dx);
        dragging.x = e.clientX;
        anim.drag(dx * 0.012, Math.max(0.001, (now - dragging.last) / 1000));
        dragging.last = now;
      }
    };
    const onScroll = () => (rect = el.getBoundingClientRect());
    const greet = () => {
      const now = performance.now();
      if (now - lastGreet < 1500) return;
      lastGreet = now;
      anim.greet();
    };
    const onDown = (e: PointerEvent) => {
      if (!latest.current.interactive) return;
      dragging = { x: e.clientX, moved: 0, last: performance.now() };
      el.setPointerCapture?.(e.pointerId);
      el.style.cursor = "grabbing";
    };
    const onUp = () => {
      if (!dragging) return;
      if (dragging.moved < 6) greet();
      dragging = null;
      el.style.cursor = latest.current.interactive ? "grab" : "";
    };
    const onEnter = () => (hover = !!latest.current.interactive);
    const onLeave = () => {
      hover = false;
      local = null;
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });
    window.addEventListener("pointerup", onUp);
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerenter", onEnter);
    el.addEventListener("pointerleave", onLeave);
    // 键盘问候由外层可聚焦容器（AiAvatar）处理，经 greetKey 传入

    const spectrum = { data: null as Uint8Array<ArrayBuffer> | null };
    let fps = createFpsMonitor();
    let throttle = false;
    let skip = false;
    let last = performance.now();
    let clock = 0;
    let greeted = false;

    const energyOf = (): number => {
      const s = latest.current.signals;
      if (s?.pseudoSpeaking?.() || !s?.analyser?.()) {
        const v = pseudoVisemes(clock);
        return Math.max(v.aa, v.oh, v.ee);
      }
      const an = s.analyser()!;
      if (!spectrum.data || spectrum.data.length !== an.frequencyBinCount) spectrum.data = new Uint8Array(an.frequencyBinCount);
      an.getByteFrequencyData(spectrum.data);
      const v = visemesFromSpectrum(spectrum.data, an.context.sampleRate);
      return Math.max(v.aa, v.ih, v.ou, v.ee, v.oh);
    };

    const frame = (now: number) => {
      raf = 0;
      const dt = Math.min(0.1, (now - last) / 1000);
      // 最低一级：隔帧渲染（约 30 fps）
      if (throttle && (skip = !skip)) {
        schedule();
        return;
      }
      last = now;
      clock += dt;
      const p = latest.current;
      const mood = p.mood ?? p.state;
      const f = anim.step(dt, { mood, energy: mood === "speaking" ? energyOf() : 0, mic: p.signals?.micLevel?.() ?? 0, pointer, hover });
      reportMood(f.mood);
      const n = field.update({ frame: f, dt, energy: f.mouthOpen, mic: p.signals?.micLevel?.() ?? 0, dark: darkRef.current, width: W, height: H, pointer: local });
      renderer.draw(field.out, n, darkRef.current);
      // 聚形完成后自然地打个招呼
      if (!greeted && field.settled) {
        greeted = true;
        if (p.interactive) anim.greet();
      }
      if (fps.tick(dt)) {
        if (level < QUALITY_STEPS.length - 1) {
          level++;
          dprCap = 1;
          field = makeField(false);
          layout();
        } else throttle = true;
        fps = createFpsMonitor(24, 2, 1);
      }
      schedule();
    };
    function schedule() {
      if (disposed || raf || !inView || document.visibilityState !== "visible") return;
      raf = requestAnimationFrame(frame);
    }
    schedule();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      clearTimeout(pointerTimer);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerenter", onEnter);
      el.removeEventListener("pointerleave", onLeave);
      greetRef.current = null;
      renderer.dispose();
    };
    // 构图与静止模式决定粒子布局，变化时重建；其余属性逐帧从 latest 读取
  }, [props.framing, props.still]);

  return <div ref={host} className="relative size-full" style={{ cursor: props.interactive && !props.still ? "grab" : undefined }} />;
}
