/**
 * 平台吉祥物 Lumi（add-platform-mascot D2）：情绪 → 配色 / 五官 / 手势 / 配件的配置，以及逐帧动画器（纯函数，便于单测）。
 * 字形粒子场（glyph-field.ts）、实时形象（glyph-mascot.tsx）与小图标（mascot-icon.tsx）共用这套配置。
 */
import type { AvatarState } from "./state";

export type MascotMood = AvatarState | "happy" | "sleepy";
export type EyeShape = "round" | "happy" | "cross" | "sleepy";
export type MouthShape = "smile" | "o" | "flat" | "grin" | "frown" | "small";
export type HandPose = "rest" | "cup" | "chin" | "up" | "droop";

export const MOODS: MascotMood[] = ["idle", "listening", "thinking", "speaking", "happy", "error", "sleepy"];
export const EYES: EyeShape[] = ["round", "happy", "cross", "sleepy"];
export const MOUTHS: MouthShape[] = ["smile", "o", "flat", "grin", "frown", "small"];

export interface MoodStyle {
  label: string;
  /** 身体顶部 / 底部渐变色、强调色（天线光球、轮廓光、声波）、腮红 */
  top: string;
  bottom: string;
  accent: string;
  eye: EyeShape;
  /** 眼睛张开度（圆眼时，1 为正常，>1 睁大） */
  eyeOpen: number;
  /** 视线偏移（-1..1，y 向上） */
  gaze: [number, number];
  mouth: MouthShape;
  hands: HandPose;
  /** 字符环可见度与转速（圈 / 秒） */
  ring: number;
  ringSpeed: number;
  /** 前倾（正为前倾）与下垂（0..1） */
  lean: number;
  droop: number;
  /** 漂浮速度倍率 */
  float: number;
}

export const MOOD_STYLE: Record<MascotMood, MoodStyle> = {
  idle: { label: "在这里", top: "#a78bfa", bottom: "#7c8cf3", accent: "#c4b5fd", eye: "round", eyeOpen: 1, gaze: [0, 0], mouth: "smile", hands: "rest", ring: 0.55, ringSpeed: 0.06, lean: 0, droop: 0, float: 1 },
  listening: { label: "正在倾听", top: "#7dd8c0", bottom: "#8597ef", accent: "#34d399", eye: "round", eyeOpen: 1.12, gaze: [0, 0.05], mouth: "o", hands: "cup", ring: 0.4, ringSpeed: 0.05, lean: 0.12, droop: 0, float: 0.8 },
  thinking: { label: "正在思考", top: "#7cc0f8", bottom: "#8a8ff2", accent: "#60a5fa", eye: "round", eyeOpen: 0.95, gaze: [0.35, 0.7], mouth: "flat", hands: "chin", ring: 1, ringSpeed: 0.28, lean: -0.04, droop: 0, float: 0.7 },
  speaking: { label: "正在说话", top: "#c58af6", bottom: "#8d7cf3", accent: "#e879f9", eye: "round", eyeOpen: 1, gaze: [0, 0], mouth: "smile", hands: "rest", ring: 0.8, ringSpeed: 0.16, lean: 0.04, droop: 0, float: 1.1 },
  happy: { label: "很开心", top: "#f7a6c8", bottom: "#a18cf5", accent: "#fbbf24", eye: "happy", eyeOpen: 1, gaze: [0, 0.1], mouth: "grin", hands: "up", ring: 0.7, ringSpeed: 0.35, lean: 0, droop: 0, float: 1.4 },
  error: { label: "遇到了问题", top: "#aab3c5", bottom: "#8e98ae", accent: "#fb7185", eye: "cross", eyeOpen: 1, gaze: [0, -0.2], mouth: "frown", hands: "droop", ring: 0, ringSpeed: 0, lean: -0.08, droop: 1, float: 0.5 },
  sleepy: { label: "打瞌睡中", top: "#b9a9f2", bottom: "#9aa2e8", accent: "#c7d2fe", eye: "sleepy", eyeOpen: 1, gaze: [0, -0.2], mouth: "small", hands: "rest", ring: 0.25, ringSpeed: 0.02, lean: -0.03, droop: 0.4, float: 0.45 },
};

/** 手势目标（身体局部坐标，身体半径约 1） */
export const HAND_POSE: Record<HandPose, { left: Vec3; right: Vec3 }> = {
  rest: { left: [-1.18, -0.28, 0.18], right: [1.18, -0.28, 0.18] },
  cup: { left: [-1.18, -0.3, 0.18], right: [1.02, 0.32, 0.3] },
  chin: { left: [-1.18, -0.3, 0.18], right: [0.5, -0.78, 0.74] },
  up: { left: [-1.22, 0.42, 0.22], right: [1.22, 0.42, 0.22] },
  droop: { left: [-1.06, -0.66, 0.12], right: [1.06, -0.66, 0.12] },
};

export type Vec3 = [number, number, number];
export type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** 数字人状态 + 外部情绪覆盖 → 情绪（覆盖优先） */
export function moodOf(state: AvatarState, override?: MascotMood | null): MascotMood {
  return override ?? state;
}

/* ---------------- 动画器 ---------------- */

export interface MascotInput {
  mood: MascotMood;
  /** 说话能量 0–1（播放输出） */
  energy: number;
  /** 麦克风电平 0–1 */
  mic: number;
  /** 指针 -1..1（y 向上），null 回正 */
  pointer: { x: number; y: number } | null;
  hover: boolean;
}

export interface MascotFrame {
  /** 实际呈现的情绪（含问候、瞌睡） */
  mood: MascotMood;
  top: Rgb;
  bottom: Rgb;
  accent: Rgb;
  eyes: Record<EyeShape, number>;
  /** 圆眼的纵向张开度（含眨眼，0 为闭合） */
  eyeOpen: number;
  gaze: [number, number];
  mouth: Record<MouthShape, number>;
  /** 说话张嘴程度 0–1（与 mouth 叠加） */
  mouthOpen: number;
  hands: { left: Vec3; right: Vec3 };
  /** 手的摆动角（举手挥动） */
  wave: number;
  /** 漂浮高度、整体缩放（squash & stretch） */
  floatY: number;
  scale: Vec3;
  /** 身体朝向：偏航（含拖拽 / 转圈）、俯仰（含前倾）、翻滚（扭动） */
  yaw: number;
  pitch: number;
  roll: number;
  ring: number;
  ringAngle: number;
  /** 天线光球亮度 0–1 */
  glow: number;
  /** 声波强度 0–1 */
  waves: number;
  blush: number;
  /** 本帧新迸发的星星数量（渲染器据此生成粒子） */
  sparkles: number;
  /** 是否冒 z */
  zzz: boolean;
}

const ease = (cur: number, target: number, dt: number, tau: number) => cur + (target - cur) * (1 - Math.exp(-Math.max(0, dt) / tau));
const lerp3 = (cur: Rgb, target: Rgb, dt: number, tau: number): Rgb => [ease(cur[0], target[0], dt, tau), ease(cur[1], target[1], dt, tau), ease(cur[2], target[2], dt, tau)];

export const SLEEP_AFTER = 25;
const GREET_SECONDS = 1.1;
const RETURN_AFTER = 3;

export interface MascotAnimator {
  step(dt: number, input: MascotInput): MascotFrame;
  /** 点击 / 键盘 / 就绪时的问候（开心 + 跳 + 转圈 + 星星） */
  greet(): void;
  /** 任意交互：唤醒并重置瞌睡计时 */
  poke(): void;
  /** 拖拽：累加偏航角速度（弧度 / 秒） */
  drag(deltaYaw: number, dt: number): void;
}

export function createMascotAnimator(random: () => number = Math.random): MascotAnimator {
  const s0 = MOOD_STYLE.idle;
  const f: MascotFrame = {
    mood: "idle",
    top: hexToRgb(s0.top),
    bottom: hexToRgb(s0.bottom),
    accent: hexToRgb(s0.accent),
    eyes: { round: 1, happy: 0, cross: 0, sleepy: 0 },
    eyeOpen: 1,
    gaze: [0, 0],
    mouth: { smile: 1, o: 0, flat: 0, grin: 0, frown: 0, small: 0 },
    mouthOpen: 0,
    hands: { left: [...HAND_POSE.rest.left], right: [...HAND_POSE.rest.right] },
    wave: 0,
    floatY: 0,
    scale: [1, 1, 1],
    yaw: 0,
    pitch: 0,
    roll: 0,
    ring: s0.ring,
    ringAngle: 0,
    glow: 0.5,
    waves: 0,
    blush: 0.55,
    sparkles: 0,
    zzz: false,
  };
  let t = 0;
  let floatPhase = 0;
  let idleFor = 0;
  let lastMood: MascotMood = "idle";
  let greetT = -1;
  let pendingSparkles = 0;
  let nextBlink = 1.5 + random() * 3;
  let blinkT = -1;
  let dragVel = 0;
  let dragYaw = 0;
  let sinceDrag = 99;
  let spinT = -1;
  let energy = 0;
  let mic = 0;
  let wiggleT = -1;
  let wasHover = false;
  let pointerYaw = 0;

  const wake = () => {
    idleFor = 0;
  };

  return {
    greet() {
      wake();
      if (greetT < 0 || greetT > 0.6) {
        greetT = 0;
        spinT = 0;
        pendingSparkles += 12;
      }
    },
    poke: wake,
    drag(deltaYaw, dt) {
      wake();
      dragYaw += deltaYaw;
      dragVel = dt > 0 ? deltaYaw / dt : dragVel;
      sinceDrag = 0;
    },
    step(dt, input) {
      dt = Math.min(Math.max(dt, 0), 0.1);
      t += dt;

      // 情绪：问候期间为 happy；idle 久了打瞌睡
      if (input.mood !== lastMood) {
        wake();
        lastMood = input.mood;
      }
      if (input.pointer || input.hover) wake();
      idleFor = input.mood === "idle" ? idleFor + dt : 0;
      let mood: MascotMood = input.mood === "idle" && idleFor > SLEEP_AFTER ? "sleepy" : input.mood;
      if (greetT >= 0) {
        greetT += dt;
        if (greetT > GREET_SECONDS) greetT = -1;
        else mood = "happy";
      }
      f.mood = mood;
      const st = MOOD_STYLE[mood];

      // 颜色
      f.top = lerp3(f.top, hexToRgb(st.top), dt, 0.12);
      f.bottom = lerp3(f.bottom, hexToRgb(st.bottom), dt, 0.12);
      f.accent = lerp3(f.accent, hexToRgb(st.accent), dt, 0.12);

      // 眼睛
      for (const e of Object.keys(f.eyes) as EyeShape[]) f.eyes[e] = ease(f.eyes[e], e === st.eye ? 1 : 0, dt, 0.06);
      let blink = 1;
      if (st.eye === "round" && mood !== "thinking") {
        if (blinkT < 0) {
          nextBlink -= dt;
          if (nextBlink <= 0) {
            blinkT = 0;
            nextBlink = 2.5 + random() * 3.5;
          }
        } else {
          blinkT += dt;
          blink = blinkT < 0.14 ? 1 - Math.sin((blinkT / 0.14) * Math.PI) : 1;
          if (blinkT >= 0.14) blinkT = -1;
        }
      }
      f.eyeOpen = ease(f.eyeOpen, st.eyeOpen, dt, 0.08) * blink;
      const px = input.pointer?.x ?? 0;
      const py = input.pointer?.y ?? 0;
      f.gaze = [ease(f.gaze[0], st.gaze[0] * 0.8 + px * 0.6, dt, 0.1), ease(f.gaze[1], st.gaze[1] * 0.8 + py * 0.5, dt, 0.1)];

      // 嘴：说话时张嘴程度跟随能量；平时按表情
      energy = ease(energy, mood === "speaking" ? input.energy : 0, dt, 0.05);
      for (const m of Object.keys(f.mouth) as MouthShape[]) f.mouth[m] = ease(f.mouth[m], m === st.mouth ? 1 : 0, dt, 0.06);
      f.mouthOpen = Math.min(1, energy * 1.35);

      // 手
      const pose = HAND_POSE[st.hands];
      const k = 1 - Math.exp(-dt / 0.12);
      for (let i = 0; i < 3; i++) {
        f.hands.left[i] += (pose.left[i] - f.hands.left[i]) * k;
        f.hands.right[i] += (pose.right[i] - f.hands.right[i]) * k;
      }
      f.wave = st.hands === "up" ? Math.sin(t * 14) * 0.25 : ease(f.wave, 0, dt, 0.1);

      // 漂浮、弹动、开心跳
      floatPhase += dt * st.float * ((2 * Math.PI) / 1.6);
      const jump = greetT >= 0 ? Math.sin(Math.min(1, greetT / 0.55) * Math.PI) * 0.35 : 0;
      f.floatY = Math.sin(floatPhase) * 0.06 + jump - st.droop * 0.08;
      mic = ease(mic, mood === "listening" ? input.mic : 0, dt, 0.12);
      const bounce = energy * 0.06 * Math.sin(t * 18);
      const breathe = Math.sin(floatPhase * 0.5) * 0.012;
      const land = greetT >= 0 && greetT > 0.5 && greetT < 0.75 ? Math.sin(((greetT - 0.5) / 0.25) * Math.PI) * 0.08 : 0;
      f.scale = [1 + bounce * 0.5 + land + breathe * 0.5, 1 - bounce + breathe - land - st.droop * 0.04, 1 + bounce * 0.5 + land];

      // 朝向：指针跟随 + 拖拽惯性 + 回正 + 开心转圈
      sinceDrag += dt;
      if (sinceDrag > 0.02) {
        dragYaw += dragVel * dt;
        dragVel *= Math.exp(-dt / 0.6);
      }
      if (sinceDrag > RETURN_AFTER) {
        // 回到最近的正面朝向（2π 的整数倍）
        const home = Math.round(dragYaw / (2 * Math.PI)) * 2 * Math.PI;
        dragYaw = ease(dragYaw, home, dt, 0.35);
      }
      let spin = 0;
      if (spinT >= 0) {
        spinT += dt;
        const p = Math.min(1, spinT / 0.9);
        spin = (1 - Math.pow(1 - p, 3)) * 2 * Math.PI;
        if (p >= 1) {
          spinT = -1;
          dragYaw += 2 * Math.PI; // 转完一圈并入累计角，避免跳变
          spin = 0;
        }
      }
      pointerYaw = ease(pointerYaw, px * 0.35, dt, 0.15);
      f.pitch = ease(f.pitch, -py * 0.18 + st.lean + mic * 0.08, dt, 0.15);
      // 悬停时轻扭一下
      if (input.hover && !wasHover) wiggleT = 0;
      wasHover = input.hover;
      let wiggle = 0;
      if (wiggleT >= 0) {
        wiggleT += dt;
        wiggle = Math.sin(wiggleT * 16) * 0.08 * Math.max(0, 1 - wiggleT / 0.6);
        if (wiggleT > 0.6) wiggleT = -1;
      }
      f.roll = ease(f.roll, (mood === "thinking" ? 0.1 : 0) - px * 0.05, dt, 0.2) + wiggle;
      f.yaw = pointerYaw + dragYaw + spin;

      // 配件
      f.ring = ease(f.ring, st.ring, dt, 0.15);
      f.ringAngle += dt * st.ringSpeed * 2 * Math.PI;
      const pulse = 0.5 + 0.5 * Math.sin(t * (mood === "thinking" ? 3 : 2));
      f.glow = ease(f.glow, mood === "listening" ? 0.35 + mic * 0.65 : mood === "speaking" ? 0.4 + energy * 0.6 : 0.3 + pulse * 0.4, dt, 0.08);
      f.waves = ease(f.waves, mood === "speaking" ? 0.35 + energy : 0, dt, 0.1);
      f.blush = ease(f.blush, input.hover ? 0.95 : mood === "happy" ? 0.85 : mood === "error" ? 0.25 : 0.55, dt, 0.15);
      f.sparkles = pendingSparkles;
      pendingSparkles = 0;
      f.zzz = mood === "sleepy";
      return f;
    },
  };
}

/** 某情绪下静止的一帧（静态模式、小图标）：用固定随机源推进到配色与五官稳定 */
export function settledFrame(mood: MascotMood): MascotFrame {
  const anim = createMascotAnimator(() => 0.5);
  const input: MascotInput = { mood, energy: 0, mic: 0, pointer: null, hover: false };
  let f = anim.step(0, input);
  for (let i = 0; i < 40; i++) f = anim.step(0.1, input);
  return f;
}
