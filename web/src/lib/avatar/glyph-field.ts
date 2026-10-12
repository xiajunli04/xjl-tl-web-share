/**
 * 字形粒子生命体（add-platform-mascot D3）：Lumi 的身体由几千个中 / 英 / 日 / 韩字形粒子组成。
 * 纯计算模块：输入动画器的逐帧数据（mascot.ts），输出每个粒子的屏幕坐标、尺寸、字形与颜色，
 * WebGL 与 Canvas2D 渲染器（glyph-render.ts）共用同一份输出，画面一致。
 *
 * 粒子分组：背景字符雨、内核、外壳、字符环、声波、双手、腮红、天线、眼睛、嘴、星星、z。
 * 入场时外壳 / 内核 / 手 / 天线像字符雨一样落下聚拢成形，之后眼睛"睁开"。
 */
import type { MascotFrame, MascotMood, Rgb } from "./mascot";

/** 普通字形（会随机闪变）：译文主题的四种文字 + 数字 */
export const LETTERS = [
  "文", "语", "译", "言", "字", "话", "听", "说", "你", "好", "声", "心",
  "A", "B", "C", "E", "H", "K", "L", "M", "N", "R", "S", "W", "X", "Z", "a", "e", "o", "y",
  "あ", "い", "う", "の", "ん", "ア", "イ", "カ",
  "한", "국", "어", "안", "녕", "말", "ㅎ", "ㄱ",
  "0", "1",
];
/** 特殊字形（不参与闪变）：圆点、小圆点、四角星、Z */
export const DOT = LETTERS.length;
export const SMALL_DOT = DOT + 1;
export const SPARK = DOT + 2;
export const ZED = DOT + 3;
export const GLYPH_COUNT = ZED + 1;
/** 图集网格（ATLAS_GRID × ATLAS_GRID 格） */
export const ATLAS_GRID = 8;
/** 输出步长：x, y, size, glyph, r, g, b, a */
export const STRIDE = 8;

export type FieldFraming = "stage" | "badge" | "icon" | "icon-face";

export interface FieldOptions {
  framing: FieldFraming;
  /** 粒子密度 0.1–1（低性能时下调，画风不变） */
  quality?: number;
  seed?: number;
  /** 是否播放字符雨聚形入场 */
  intro?: boolean;
}

export interface FieldInput {
  frame: MascotFrame;
  dt: number;
  /** 说话能量 0–1 */
  energy: number;
  /** 麦克风电平 0–1 */
  mic: number;
  dark: boolean;
  /** 画布像素尺寸 */
  width: number;
  height: number;
  /** 画布像素坐标的指针（悬停时），粒子会被拨开 */
  pointer: { x: number; y: number } | null;
}

export interface GlyphField {
  readonly capacity: number;
  readonly out: Float32Array;
  /** 入场是否结束 */
  readonly settled: boolean;
  skipIntro(): void;
  /** 写入 out，返回本帧可见粒子数 */
  update(input: FieldInput): number;
}

/* ---------------- 构图 ---------------- */

/** 相机距离 D、取景中心 (cx, cy)、需要容纳的半宽 / 半高（世界单位，身体半径约 1） */
const VIEW: Record<FieldFraming, { D: number; cx: number; cy: number; hw: number; hh: number }> = {
  stage: { D: 6.5, cx: 0, cy: 0.2, hw: 1.95, hh: 1.8 },
  badge: { D: 4.2, cx: 0, cy: 0.06, hw: 1.08, hh: 1.08 },
  icon: { D: 6, cx: 0, cy: 0.2, hw: 1.42, hh: 1.42 },
  "icon-face": { D: 4.2, cx: 0, cy: 0.04, hw: 1.04, hh: 1.04 },
};

/* ---------------- 情绪 → 粒子场参数 ---------------- */

interface Fx {
  /** 背景字符雨强度 */
  rain: number;
  /** 每个字形每秒闪变的概率 */
  flicker: number;
  /** 扫描光带：每秒扫过次数、亮度 */
  scan: number;
  scanA: number;
  /** 内核旋转速度 */
  core: number;
  /** 外壳表面起伏 */
  ripple: number;
  /** 整体亮度 */
  dim: number;
  /** 天线下垂 0–1 */
  droop: number;
}

export const FIELD_FX: Record<MascotMood, Fx> = {
  idle: { rain: 0.2, flicker: 0.25, scan: 0.28, scanA: 0.55, core: 0.5, ripple: 0.012, dim: 1, droop: 0 },
  listening: { rain: 0.28, flicker: 0.45, scan: 0.42, scanA: 0.6, core: 0.8, ripple: 0.02, dim: 1, droop: 0 },
  thinking: { rain: 0.62, flicker: 3.5, scan: 1, scanA: 0.85, core: 2.4, ripple: 0.01, dim: 1, droop: 0 },
  speaking: { rain: 0.32, flicker: 0.9, scan: 0.5, scanA: 0.6, core: 1, ripple: 0.012, dim: 1, droop: 0 },
  happy: { rain: 0.36, flicker: 1.2, scan: 0.65, scanA: 0.7, core: 1.4, ripple: 0.02, dim: 1.08, droop: 0 },
  error: { rain: 0.1, flicker: 0.6, scan: 0.2, scanA: 0.25, core: 0.3, ripple: 0, dim: 0.82, droop: 1 },
  sleepy: { rain: 0.05, flicker: 0.06, scan: 0.12, scanA: 0.15, core: 0.2, ripple: 0.008, dim: 0.62, droop: 0.5 },
};

/* ---------------- 工具 ---------------- */

const G = {
  RAIN: 0,
  CORE: 1,
  SHELL: 2,
  RING: 3,
  WAVE: 4,
  HAND_L: 5,
  HAND_R: 6,
  BLUSH: 7,
  STALK: 8,
  ORB: 9,
  EYE_L: 10,
  EYE_R: 11,
  MOUTH: 12,
  SPARK: 13,
  ZZZ: 14,
} as const;

const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const INTRO_FALL = 0.9;
const INTRO_END = 1.8;
const RAIN_LEN = 11;
const RING_R = 1.6;
const RING_TILT = 0.24;
const RING_ROLL = 0.14;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const ease = (cur: number, target: number, dt: number, tau: number) => cur + (target - cur) * (1 - Math.exp(-dt / tau));

/** 可复现的伪随机（mulberry32） */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 身体表面（椭球 1 × 0.94 × 0.9）在 (x, y) 处的前表面 z */
const surfaceZ = (x: number, y: number) => 0.9 * Math.sqrt(Math.max(0, 1 - x * x - (y / 0.94) * (y / 0.94)));

/* ---------------- 构建 ---------------- */

interface Layout {
  n: number;
  group: Uint8Array;
  /** 每个粒子的三个参数（含义随分组而定） */
  p: Float32Array;
  seed: Float32Array;
  seed2: Float32Array;
  glyph: Uint8Array;
  /** 基础尺寸（世界单位） */
  size: Float32Array;
  sparkSlots: number;
}

function counts(framing: FieldFraming, q: number) {
  const icon = framing === "icon" || framing === "icon-face";
  const stage = framing === "stage";
  const c = (base: number, min = 1) => Math.max(min, Math.round(base * q));
  return {
    rainCols: stage ? c(24, 8) : 0,
    core: icon ? 0 : c(220, 40),
    shell: c(980, 110),
    ring: stage ? c(96, 40) : 0,
    wave: stage ? c(40, 16) : 0,
    hand: framing === "icon-face" ? 0 : c(34, 8),
    blush: c(12, 4),
    stalk: c(18, 6),
    orb: c(24, 6),
    eye: c(64, 16),
    mouth: c(36, 12),
    spark: icon ? 0 : 36,
    zzz: 3,
  };
}

function build(framing: FieldFraming, quality: number, rand: () => number): Layout {
  const k = counts(framing, quality);
  const total =
    k.rainCols * RAIN_LEN + k.core + k.shell + k.ring + k.wave * 3 + k.hand * 2 + k.blush * 2 + k.stalk + k.orb + k.eye * 2 + k.mouth + k.spark + k.zzz;
  const L: Layout = {
    n: 0,
    group: new Uint8Array(total),
    p: new Float32Array(total * 3),
    seed: new Float32Array(total),
    seed2: new Float32Array(total),
    glyph: new Uint8Array(total),
    size: new Float32Array(total),
    sparkSlots: k.spark,
  };
  const letter = () => Math.floor(rand() * DOT);
  // 粒子越少单个越大，保持覆盖面积
  const sz = (base: number, baseCount: number, count: number) => base * Math.min(3, Math.sqrt(baseCount / Math.max(1, count)));
  const push = (g: number, a: number, b: number, c: number, size: number, glyph: number) => {
    const i = L.n++;
    L.group[i] = g;
    L.p[i * 3] = a;
    L.p[i * 3 + 1] = b;
    L.p[i * 3 + 2] = c;
    L.seed[i] = rand();
    L.seed2[i] = rand();
    L.size[i] = size;
    L.glyph[i] = glyph;
  };

  // 背景字符雨：列 x、列内序号、下落速度
  for (let col = 0; col < k.rainCols; col++) {
    const x = -2.7 + (col + 0.5) * (5.4 / k.rainCols) + (rand() - 0.5) * 0.12;
    const speed = 0.16 + rand() * 0.22;
    const offset = rand();
    for (let j = 0; j < RAIN_LEN; j++) {
      push(G.RAIN, x, j, speed, 0.15, letter());
      L.seed[L.n - 1] = offset; // 同列共享相位
    }
  }
  // 内核：球内随机点
  for (let i = 0; i < k.core; i++) {
    let x = 0, y = 0, z = 0;
    do {
      x = rand() * 2 - 1;
      y = rand() * 2 - 1;
      z = rand() * 2 - 1;
    } while (x * x + y * y + z * z > 1);
    push(G.CORE, x * 0.58, y * 0.55, z * 0.52, sz(0.05, 220, k.core), rand() < 0.5 ? SMALL_DOT : letter());
  }
  // 外壳：斐波那契球面
  for (let i = 0; i < k.shell; i++) {
    const y = 1 - (2 * (i + 0.5)) / k.shell;
    const r = Math.sqrt(1 - y * y);
    const th = i * GOLDEN;
    push(G.SHELL, Math.cos(th) * r, y, Math.sin(th) * r, sz(0.105, 980, k.shell), letter());
  }
  for (let i = 0; i < k.ring; i++) push(G.RING, (i / k.ring) * Math.PI * 2, 0, 0, 0.12, letter());
  for (let w = 0; w < 3; w++) for (let i = 0; i < k.wave; i++) push(G.WAVE, ((i + w * 0.5) / k.wave) * Math.PI * 2, w, 0, 0.07, letter());
  // 双手：小球面
  for (const g of [G.HAND_L, G.HAND_R]) {
    for (let i = 0; i < k.hand; i++) {
      const y = 1 - (2 * (i + 0.5)) / k.hand;
      const r = Math.sqrt(1 - y * y);
      push(g, Math.cos(i * GOLDEN) * r, y, Math.sin(i * GOLDEN) * r, sz(0.07, 34, k.hand), letter());
    }
  }
  // 腮红：两块小圆盘（p[2] 为左右）
  for (const side of [-1, 1]) {
    for (let i = 0; i < k.blush; i++) {
      const r = Math.sqrt((i + 0.5) / k.blush);
      push(G.BLUSH, Math.cos(i * GOLDEN) * r, Math.sin(i * GOLDEN) * r, side, sz(0.06, 12, k.blush), DOT);
    }
  }
  for (let i = 0; i < k.stalk; i++) push(G.STALK, i / Math.max(1, k.stalk - 1), 0, 0, sz(0.075, 14, k.stalk), SMALL_DOT);
  for (let i = 0; i < k.orb; i++) {
    const y = 1 - (2 * (i + 0.5)) / k.orb;
    const r = Math.sqrt(1 - y * y);
    push(G.ORB, Math.cos(i * GOLDEN) * r, y, Math.sin(i * GOLDEN) * r, sz(0.06, 24, k.orb), DOT);
  }
  // 眼睛：圆盘参数 (u, v) + 沿线参数 s（-1..1，供 ^ > ‿ 等线形表情用）
  for (const g of [G.EYE_L, G.EYE_R]) {
    for (let i = 0; i < k.eye; i++) {
      const r = Math.sqrt((i + 0.5) / k.eye);
      const s = (((i * 0.618034) % 1) * 2 - 1) * 1.0;
      push(g, Math.cos(i * GOLDEN) * r, Math.sin(i * GOLDEN) * r, s, sz(0.085, 64, k.eye), DOT);
    }
  }
  // 嘴：沿线参数 s + 上下唇标记（咧嘴用）
  for (let i = 0; i < k.mouth; i++) push(G.MOUTH, (i / Math.max(1, k.mouth - 1)) * 2 - 1, i % 2, 0, sz(0.042, 36, k.mouth), DOT);
  for (let i = 0; i < k.spark; i++) push(G.SPARK, i, 0, 0, 0.1, SPARK);
  for (let i = 0; i < k.zzz; i++) push(G.ZZZ, i, 0, 0, 0.14, ZED);
  return L;
}

/* ---------------- 粒子场 ---------------- */

export function createGlyphField(opts: FieldOptions): GlyphField {
  const framing = opts.framing;
  const quality = Math.min(1, Math.max(0.1, opts.quality ?? 1));
  const rand = seeded(opts.seed ?? 7);
  const L = build(framing, quality, rand);
  const out = new Float32Array(L.n * STRIDE);
  const icon = framing === "icon" || framing === "icon-face";

  let t = 0;
  let introT = opts.intro === false ? INTRO_END : 0;
  const fx: Fx = { ...FIELD_FX.idle };
  let scanPhase = 0;
  let flickerAcc = 0;
  let micE = 0;
  let energyE = 0;
  let zzzA = 0;
  let burstT = -1;
  let burst = 0;
  // 星星对象池
  const sp = new Float32Array(Math.max(1, L.sparkSlots) * 7); // x y z vx vy vz life
  // 故障（error）：随机水平错位的条带
  let glitchLeft = 0;
  let glitchWait = 0;
  let glitchY = 0;
  let glitchH = 0;
  let glitchShift = 0;

  return {
    capacity: L.n,
    out,
    get settled() {
      return introT >= INTRO_END;
    },
    skipIntro() {
      introT = INTRO_END;
    },
    update(inp) {
      const f = inp.frame;
      const dt = Math.min(0.1, Math.max(0, inp.dt));
      const dark = inp.dark;
      t += dt;
      introT += dt;
      const intro = introT < INTRO_END;

      // 情绪参数缓动
      const target = FIELD_FX[f.mood];
      for (const key of Object.keys(fx) as (keyof Fx)[]) fx[key] = dt > 0 ? ease(fx[key], target[key], dt, 0.35) : target[key];
      const rainK = intro ? Math.max(fx.rain, 0.75 * (1 - smooth(1.2, INTRO_END, introT))) : fx.rain;
      scanPhase = (scanPhase + dt * fx.scan) % 1;
      const scanY = 1.2 - scanPhase * 2.7;
      micE = dt > 0 ? ease(micE, f.mood === "listening" ? inp.mic : 0, dt, 0.08) : 0;
      energyE = dt > 0 ? ease(energyE, f.mood === "speaking" ? inp.energy : 0, dt, 0.05) : 0;
      zzzA = dt > 0 ? ease(zzzA, f.zzz ? 1 : 0, dt, 0.3) : f.zzz ? 1 : 0;

      // 字形闪变（只换普通字形）
      flickerAcc += fx.flicker * dt * L.n;
      while (flickerAcc >= 1) {
        flickerAcc -= 1;
        const i = Math.floor(rand() * L.n);
        if (L.glyph[i] < DOT) L.glyph[i] = Math.floor(rand() * DOT);
      }

      // 问候：星星迸发 + 身体粒子向外炸开再聚拢
      if (f.sparkles > 0) {
        burstT = 0;
        let n = f.sparkles;
        for (let s = 0; s < L.sparkSlots && n > 0; s++) {
          const o = s * 7;
          if (sp[o + 6] > 0) continue;
          n--;
          const a = rand() * Math.PI * 2;
          const r = rand();
          sp[o] = Math.cos(a) * 0.7;
          sp[o + 1] = 0.15 + Math.sin(a) * 0.6;
          sp[o + 2] = 0.7;
          sp[o + 3] = Math.cos(a) * (1.4 + r);
          sp[o + 4] = Math.sin(a) * (1.2 + r) + 0.9;
          sp[o + 5] = (r - 0.3) * 0.6;
          sp[o + 6] = 1;
        }
      }
      if (burstT >= 0) {
        burstT += dt;
        burst = 0.42 * (1 - Math.exp(-burstT * 16)) * Math.exp(-burstT * 3.2);
        if (burstT > 2.5) {
          burstT = -1;
          burst = 0;
        }
      }
      for (let s = 0; s < L.sparkSlots; s++) {
        const o = s * 7;
        if (sp[o + 6] <= 0) continue;
        sp[o + 6] -= dt * 1.1;
        sp[o + 4] -= dt * 2.2;
        sp[o] += sp[o + 3] * dt;
        sp[o + 1] += sp[o + 4] * dt;
        sp[o + 2] += sp[o + 5] * dt;
      }

      if (f.mood === "error" && dt > 0) {
        if (glitchLeft > 0) glitchLeft -= dt;
        else if ((glitchWait -= dt) <= 0) {
          glitchLeft = 0.07 + rand() * 0.1;
          glitchWait = 0.15 + rand() * 0.6;
          glitchY = rand() * 1.8 - 0.9;
          glitchH = 0.05 + rand() * 0.12;
          glitchShift = (rand() < 0.5 ? -1 : 1) * (0.06 + rand() * 0.1);
        }
      } else glitchLeft = 0;

      // 投影
      const W = inp.width;
      const H = inp.height;
      const v = VIEW[framing];
      const unit = Math.min(W / (2 * v.hw), H / (2 * v.hh));
      const fpx = unit * v.D;
      const ptr = inp.pointer;
      const R = unit * 0.5;

      // 姿态：先翻滚、再偏航、再俯仰
      const cr = Math.cos(f.roll), sr = Math.sin(f.roll);
      const cy = Math.cos(f.yaw), sy = Math.sin(f.yaw);
      const cp = Math.cos(f.pitch), spn = Math.sin(f.pitch);
      let RX = 0, RY = 0, RZ = 0;
      const rotate = (x: number, y: number, z: number) => {
        const x1 = x * cr - y * sr;
        const y1 = x * sr + y * cr;
        const x2 = x1 * cy + z * sy;
        const z2 = -x1 * sy + z * cy;
        RX = x2;
        RY = y1 * cp - z2 * spn;
        RZ = y1 * spn + z2 * cp;
      };
      let glitched = false;
      /** 身体局部坐标 → 世界坐标（挤压缩放、故障错位、旋转、漂浮） */
      const toWorld = (x: number, y: number, z: number) => {
        glitched = false;
        if (glitchLeft > 0 && Math.abs(y - glitchY) < glitchH) {
          x += glitchShift;
          glitched = true;
        }
        rotate(x * f.scale[0], y * f.scale[1], z * f.scale[2]);
        RY += f.floatY;
      };
      rotate(0, 0, 1);
      const faceZ = RZ;
      const faceVis = smooth(-0.15, 0.35, faceZ);
      const appear = smooth(1.2, 1.7, introT);

      const top = f.top, bottom = f.bottom, accent = f.accent;
      const bodyMul = dark ? 1 : 0.8;
      const alphaMul = dark ? 1 : 1.18;
      const ink: Rgb = dark ? [0.97 - accent[0] * 0.06, 0.96 - accent[1] * 0.06, 1] : [0.15, 0.12, 0.32];
      const floor = icon ? 0.42 : 0;
      /** "发光"的去向：暗色往白色提亮，浅色往深色压，保证在白底上仍清晰 */
      const glowTo = dark ? 1 : 0.3;

      let m = 0;
      const emit = (x: number, y: number, z: number, size: number, glyph: number, r: number, g: number, b: number, a: number, repel: boolean) => {
        if (a < 0.01) return;
        const s = fpx / (v.D - z);
        let px = W / 2 + (x - v.cx) * s;
        let py = H / 2 - (y - v.cy) * s;
        if (repel && ptr) {
          const dx = px - ptr.x;
          const dy = py - ptr.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < R * R && d2 > 1e-6) {
            const d = Math.sqrt(d2);
            const k = 1 - d / R;
            px += (dx / d) * k * k * R * 0.45;
            py += (dy / d) * k * k * R * 0.45;
            a += 0.3 * k;
          }
        }
        const o = m * STRIDE;
        out[o] = px;
        out[o + 1] = py;
        out[o + 2] = Math.max(1, size * s);
        out[o + 3] = glyph;
        out[o + 4] = r;
        out[o + 5] = g;
        out[o + 6] = b;
        out[o + 7] = Math.min(1, a * alphaMul);
        m++;
      };
      /** 入场：从上方落下；返回透明度系数，并把 RY 抬高 */
      const fall = (i: number) => {
        if (!intro) return 1;
        const p = clamp01((introT - 0.05 - L.seed2[i] * 0.7) / INTRO_FALL);
        const e = 1 - (1 - p) * (1 - p) * (1 - p);
        RY += (1 - e) * (3.4 + L.seed[i] * 1.6);
        if (p < 1 && L.glyph[i] < DOT && rand() < 0.25) L.glyph[i] = Math.floor(rand() * DOT);
        return p > 0 ? Math.min(1, p * 4) : 0;
      };
      const mix = (a: number, b: number, k: number) => a + (b - a) * k;

      // 嘴、眼中心（局部）
      const tipSway = Math.sin(t * 1.7) * 0.035 - fx.droop * 0.12;
      const tipX = 0.1 + tipSway;
      const tipY = 1.3 - fx.droop * 0.12;

      for (let i = 0; i < L.n; i++) {
        const g = L.group[i];
        const a0 = L.p[i * 3];
        const a1 = L.p[i * 3 + 1];
        const a2 = L.p[i * 3 + 2];
        const seed = L.seed[i];
        const size = L.size[i];
        const glyph = L.glyph[i];

        switch (g) {
          case G.RAIN: {
            const head = 2.5 - ((t * a2 + seed) % 1) * 5.2;
            const y = head + a1 * 0.19;
            const fade = smooth(-2.3, -1.6, y) * (1 - smooth(1.9, 2.5, y));
            const center = 0.35 + 0.65 * smooth(0.8, 1.7, Math.abs(a0));
            const tail = a1 === 0 ? 1 : 0.7 * (1 - a1 / RAIN_LEN);
            if (a1 === 0 && rand() < 0.3) L.glyph[i] = Math.floor(rand() * DOT);
            const w = a1 === 0 ? 0.65 : 0;
            emit(a0, y, -2.3, size, glyph, mix(accent[0], glowTo, w), mix(accent[1], glowTo, w), mix(accent[2], glowTo, w), rainK * tail * fade * center * (dark ? 1.1 : 0.5), true);
            break;
          }
          case G.CORE: {
            const ang = t * fx.core * (0.6 + seed * 0.8);
            const c = Math.cos(ang), s = Math.sin(ang);
            const pulse = 1 + 0.3 * Math.max(micE, energyE) * Math.sin(t * 10 + seed * 6) + burst * 0.6;
            toWorld((a0 * c + a2 * s) * pulse, a1 * pulse, (-a0 * s + a2 * c) * pulse);
            const fa = fall(i);
            const depth = 0.5 + 0.5 * smooth(-1, 1, RZ);
            emit(RX, RY, RZ, size, glyph, mix(accent[0], glowTo, 0.35), mix(accent[1], glowTo, 0.35), mix(accent[2], glowTo, 0.35), (0.2 + 0.25 * Math.max(micE, energyE)) * fx.dim * depth * fa, true);
            break;
          }
          case G.SHELL: {
            const bulge = 1 - 0.07 * a1;
            const rip = fx.ripple * Math.sin(seed * 40 + t * 7 + a1 * 5) + micE * 0.11 * Math.sin(seed * 31 + t * 11);
            const dmx = a0, dmy = a1 * 0.94 + 0.2, dmz = a2 * 0.9 - 0.85;
            const speak = energyE * 0.07 * Math.sin(t * 13 - Math.sqrt(dmx * dmx + dmy * dmy + dmz * dmz) * 9);
            const r = 1 + rip + speak + burst * (0.35 + 0.65 * seed);
            toWorld(a0 * bulge * r, a1 * 0.94 * r, a2 * 0.9 * bulge * r);
            const gl = glitched;
            const fa = fall(i);
            const wx = RX, wy = RY, wz = RZ;
            rotate(a0, a1, a2);
            const nz = RZ;
            const rim = 1 - Math.abs(nz);
            let alpha = Math.max(floor, 0.16 + 0.75 * Math.pow(rim, 1.6)) * (0.45 + 0.55 * smooth(-1, 0.6, nz));
            // 浅色背景上字形是"墨"，内部再淡一些，只留清晰的轮廓
            if (!dark) alpha *= 0.42 + 0.7 * rim;
            // 面板：脸部区域压暗，让五官跳出来
            if (a2 > 0) {
              const d = (a0 / 0.62) ** 2 + ((a1 * 0.94 + 0.05) / 0.45) ** 2;
              alpha *= 0.3 + 0.7 * smooth(0.75, 1.25, d);
            }
            const scan = Math.exp(-(((a1 * 0.94 - scanY) / 0.09) ** 2)) * fx.scanA;
            const k = smooth(0.05, 0.95, (a1 + 1) / 2);
            let cr0 = mix(bottom[0], top[0], k) * bodyMul;
            let cg0 = mix(bottom[1], top[1], k) * bodyMul;
            let cb0 = mix(bottom[2], top[2], k) * bodyMul;
            const lift = scan * (dark ? 0.6 : 0.35);
            const lr = dark ? 1 : accent[0] * 0.7, lg = dark ? 1 : accent[1] * 0.7, lb = dark ? 1 : accent[2] * 0.7;
            cr0 = mix(cr0, lr, lift);
            cg0 = mix(cg0, lg, lift);
            cb0 = mix(cb0, lb, lift);
            if (gl) {
              cr0 = mix(cr0, 0.98, 0.7);
              cg0 = mix(cg0, 0.36, 0.7);
              cb0 = mix(cb0, 0.42, 0.7);
            }
            if (intro && fa < 1) {
              cr0 = mix(cr0, 1, 0.5);
              cg0 = mix(cg0, 1, 0.5);
              cb0 = mix(cb0, 1, 0.5);
            }
            emit(wx, wy, wz, size * (1 + scan * 0.3), glyph, cr0, cg0, cb0, (alpha * fx.dim + scan * 0.5) * fa, true);
            break;
          }
          case G.RING: {
            const ang = a0 + f.ringAngle;
            let x = Math.cos(ang) * RING_R;
            let z = Math.sin(ang) * RING_R;
            let y = -z * Math.sin(RING_TILT);
            z *= Math.cos(RING_TILT);
            const x2 = x * Math.cos(RING_ROLL) - y * Math.sin(RING_ROLL);
            y = x * Math.sin(RING_ROLL) + y * Math.cos(RING_ROLL) - 0.24 + f.floatY * 0.6;
            x = x2;
            const occl = z < 0 ? (Math.abs(x) < 1 ? 0.15 : 0.5) : 1;
            emit(x, y, z, size, glyph, mix(top[0], accent[0], 0.5), mix(top[1], accent[1], 0.5), mix(top[2], accent[2], 0.5), f.ring * 0.8 * occl * fx.dim * smooth(1, 1.7, introT), true);
            break;
          }
          case G.WAVE: {
            const ph = (t * 0.85 + a1 / 3) % 1;
            const r = 1.1 + ph * 0.8;
            emit(Math.cos(a0) * r, Math.sin(a0) * r * 0.92 + f.floatY * 0.7, 0.3, size, glyph, accent[0], accent[1], accent[2], f.waves * 0.55 * (1 - ph) * Math.min(1, ph * 5), false);
            break;
          }
          case G.HAND_L:
          case G.HAND_R: {
            const left = g === G.HAND_L;
            const hp = left ? f.hands.left : f.hands.right;
            toWorld(hp[0] + a0 * 0.16 + f.wave * 0.2 * (left ? -1 : 1), hp[1] + a1 * 0.15, hp[2] + a2 * 0.14);
            const fa = fall(i);
            const depth = 0.45 + 0.55 * smooth(-1.2, 0.8, RZ);
            const k = 0.55 + a1 * 0.2;
            emit(RX, RY, RZ, size, glyph, mix(bottom[0], top[0], k) * bodyMul, mix(bottom[1], top[1], k) * bodyMul, mix(bottom[2], top[2], k) * bodyMul, Math.max(floor, 0.62) * depth * fx.dim * fa, true);
            break;
          }
          case G.BLUSH: {
            const x = a2 * 0.57 + a0 * 0.08;
            const y = -0.1 + a1 * 0.04;
            toWorld(x, y, surfaceZ(x, y) + 0.02);
            emit(RX, RY, RZ, size, glyph, dark ? 0.98 : 0.93, dark ? 0.45 : 0.36, dark ? 0.7 : 0.6, f.blush * 0.6 * appear * faceVis, false);
            break;
          }
          case G.STALK: {
            const s = a0;
            const u = 1 - s;
            const x = u * u * 0 + 2 * u * s * 0.01 + s * s * tipX;
            const y = u * u * 0.9 + 2 * u * s * 1.15 + s * s * tipY;
            toWorld(x, y, 0);
            const fa = fall(i);
            const depth = 0.55 + 0.45 * smooth(-1, 1, RZ);
            emit(RX, RY, RZ, size, glyph, mix(bottom[0], accent[0], s), mix(bottom[1], accent[1], s), mix(bottom[2], accent[2], s), 0.95 * depth * fa * fx.dim, false);
            break;
          }
          case G.ORB: {
            const ang = t * 1.5;
            const c = Math.cos(ang), s = Math.sin(ang);
            const rr = 0.09 * (1 + f.glow * 0.15);
            toWorld(tipX + (a0 * c + a2 * s) * rr, tipY + 0.02 + a1 * rr, (-a0 * s + a2 * c) * rr);
            const w = 0.25 + f.glow * 0.45;
            emit(RX, RY, RZ, size * (1 + f.glow * 0.3), glyph, mix(accent[0], glowTo, w), mix(accent[1], glowTo, w), mix(accent[2], glowTo, w), (0.55 + 0.45 * f.glow) * appear, false);
            break;
          }
          case G.EYE_L:
          case G.EYE_R: {
            const side = g === G.EYE_L ? -1 : 1;
            const e = f.eyes;
            const tot = e.round + e.happy + e.cross + e.sleepy || 1;
            const open = Math.max(0.06, f.eyeOpen) * appear;
            const s = a2;
            // 圆眼（含眨眼、视线）
            let ex = e.round * (a0 * 0.135 + f.gaze[0] * 0.05);
            let ey = e.round * (a1 * 0.16 * open + f.gaze[1] * 0.04);
            // 开心 ^
            ex += e.happy * (s * 0.13);
            ey += e.happy * (0.07 * (1 - s * s) - 0.03 + a1 * 0.016);
            // 难过 > <
            ex += e.cross * (-side * (0.06 - Math.abs(s) * 0.12) + a0 * 0.012);
            ey += e.cross * (s * 0.09);
            // 瞌睡 ‿
            ex += e.sleepy * (s * 0.12);
            ey += e.sleepy * (-0.035 * (1 - s * s) + a1 * 0.012);
            const x = side * 0.35 + ex / tot;
            const y = 0.1 + ey / tot;
            toWorld(x, y, surfaceZ(x, y) + 0.04);
            emit(RX, RY, RZ, size, glyph, ink[0], ink[1], ink[2], 0.95 * appear * faceVis * (f.mood === "sleepy" ? 0.8 : 1), false);
            break;
          }
          case G.MOUTH: {
            const s = a0;
            const w = f.mouth;
            const tot = w.smile + w.o + w.flat + w.grin + w.frown + w.small || 1;
            const ang = s * Math.PI;
            let mx = w.smile * s * 0.09 + w.o * Math.cos(ang) * 0.04 + w.flat * s * 0.065 + w.grin * s * 0.11 + w.frown * s * 0.08 + w.small * Math.cos(ang) * 0.022;
            let my =
              w.smile * (-0.04 * (1 - s * s) + 0.012) +
              w.o * Math.sin(ang) * 0.05 +
              w.grin * (a1 ? 0.012 : 0.012 - 0.08 * (1 - s * s)) +
              w.frown * (0.035 * (1 - s * s) - 0.025) +
              w.small * Math.sin(ang) * 0.02;
            mx /= tot;
            my /= tot;
            // 说话张嘴：向椭圆过渡
            const mo = Math.min(1, f.mouthOpen * 1.6);
            mx = mix(mx, Math.cos(ang) * 0.075, mo);
            my = mix(my, Math.sin(ang) * (0.012 + 0.06 * f.mouthOpen) - 0.01, mo);
            const x = mx;
            const y = -0.2 + my;
            toWorld(x, y, surfaceZ(x, y) + 0.035);
            emit(RX, RY, RZ, size, glyph, ink[0], ink[1], ink[2], 0.92 * appear * faceVis, false);
            break;
          }
          case G.SPARK: {
            const o = a0 * 7;
            const life = sp[o + 6];
            if (life <= 0) break;
            emit(sp[o], sp[o + 1] + f.floatY, sp[o + 2], size * (0.6 + life * 0.6), glyph, mix(accent[0], glowTo, 0.3), mix(accent[1], glowTo, 0.3), mix(accent[2], glowTo, 0.3), life, false);
            break;
          }
          case G.ZZZ: {
            const ph = (t * 0.35 + a0 / 3) % 1;
            emit(0.75 + ph * 0.5, 1.05 + ph * 0.9 + f.floatY, 0.2, size * (0.8 + ph), glyph, mix(accent[0], glowTo, 0.2), mix(accent[1], glowTo, 0.2), mix(accent[2], glowTo, 0.2), zzzA * Math.sin(ph * Math.PI) * 0.9, false);
            break;
          }
        }
      }
      return m;
    },
  };
}
