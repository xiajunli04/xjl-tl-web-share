/**
 * 立绘绑定的逐帧权重（rework-avatar-portrait-rig D3）：纯函数 + 小状态机，便于单测。
 *
 * - 嘴型：由口型权重得到开口度与主导口型 → 选一帧（闭口 / small / aa / oh / ee），目标帧以 45 ms 时间常数淡入、其余淡出
 * - 眨眼：每 2.5–6 s 一次，140 ms；思考时不眨眼
 * - 思考：eyes-up 250 ms 淡入；开心：happy 持续 1.2 s
 * - 运动：指针视差、idle 摇摆、倾听前倾点头、说话随能量点头、开心轻跳
 */
import type { LayerName } from "./characters";
import type { VisemeWeights } from "./lipsync";
import type { AvatarState } from "./state";

export type MouthFrame = "closed" | "mouth-small" | "mouth-aa" | "mouth-oh" | "mouth-ee";
export const MOUTH_FRAMES: Exclude<MouthFrame, "closed">[] = ["mouth-small", "mouth-aa", "mouth-oh", "mouth-ee"];

const OPEN_MIN = 0.12;
const OPEN_SMALL = 0.32;

/** 口型权重 → 嘴型帧 */
export function mouthFrame(v: VisemeWeights): MouthFrame {
  const open = Math.max(v.aa, v.ih, v.ou, v.ee, v.oh);
  if (open < OPEN_MIN) return "closed";
  if (open < OPEN_SMALL) return "mouth-small";
  const round = v.oh + v.ou;
  const spread = v.ee + v.ih;
  if (round >= v.aa && round >= spread) return "mouth-oh";
  if (spread > v.aa) return "mouth-ee";
  return "mouth-aa";
}

const ease = (cur: number, target: number, dt: number, tau: number) => cur + (target - cur) * (1 - Math.exp(-Math.max(0, dt) / tau));

export interface RigFrame {
  weights: Record<LayerName, number>;
  /** 视差偏移（立绘 uv 单位） */
  offset: [number, number];
  /** 整体缩放（倾听前倾、开心轻跳） */
  scale: number;
  /** 饱和度（error 时降低） */
  saturation: number;
}

export interface RigInput {
  state: AvatarState;
  visemes: VisemeWeights;
  /** 麦克风电平 0–1 */
  mic: number;
  /** 指针 -1..1（y 向上），null 回到正前方 */
  pointer: { x: number; y: number } | null;
}

const zeroWeights = (): Record<LayerName, number> => ({
  "mouth-small": 0,
  "mouth-aa": 0,
  "mouth-oh": 0,
  "mouth-ee": 0,
  "eyes-closed": 0,
  "eyes-up": 0,
  happy: 0,
});

export interface RigAnimator {
  step(dt: number, input: RigInput): RigFrame;
  /** 触发开心表情（就绪问候 / 点击） */
  greet(): void;
}

export function createRigAnimator(random: () => number = Math.random): RigAnimator {
  const w = zeroWeights();
  let t = 0;
  let nextBlink = 1.5 + random() * 3;
  let blinkT = -1;
  let happyT = -1;
  let level = 0;
  let mic = 0;
  const off: [number, number] = [0, 0];
  let scale = 1;
  let sat = 1;
  const frame: RigFrame = { weights: w, offset: off, scale: 1, saturation: 1 };

  return {
    greet() {
      if (happyT < 0) happyT = 0;
    },
    step(dt, { state, visemes, mic: micIn, pointer }) {
      dt = Math.min(Math.max(dt, 0), 0.1);
      t += dt;
      const happy = happyT >= 0 && state !== "speaking";
      if (happyT >= 0) {
        happyT += dt;
        if (happyT > 1.2) happyT = -1;
      }

      // 嘴型：说话时按口型选帧；开心表情自带张嘴微笑，嘴型帧让位
      const target = state === "speaking" ? mouthFrame(visemes) : "closed";
      for (const f of MOUTH_FRAMES) w[f] = ease(w[f], !happy && f === target ? 1 : 0, dt, 0.045);
      w.happy = ease(w.happy, happy ? 1 : 0, dt, 0.12);

      // 眼睛：思考抬眼；其余状态随机眨眼
      w["eyes-up"] = ease(w["eyes-up"], state === "thinking" ? 1 : 0, dt, 0.25 / 3);
      let blink = 0;
      if (state !== "thinking" && !happy) {
        if (blinkT < 0) {
          nextBlink -= dt;
          if (nextBlink <= 0) {
            blinkT = 0;
            nextBlink = 2.5 + random() * 3.5;
          }
        } else {
          blinkT += dt;
          blink = blinkT < 0.14 ? Math.sin((blinkT / 0.14) * Math.PI) : 0;
          if (blinkT >= 0.14) blinkT = -1;
        }
      }
      w["eyes-closed"] = blink;

      // 运动
      const open = Math.max(visemes.aa, visemes.ih, visemes.ou, visemes.ee, visemes.oh);
      level = ease(level, state === "speaking" ? open : 0, dt, 0.12);
      mic = ease(mic, state === "listening" ? micIn : 0, dt, 0.15);
      const px = pointer ? pointer.x : 0;
      const py = pointer ? pointer.y : 0;
      const swayX = Math.sin(t * 0.5) * 0.004 + Math.sin(t * 0.23) * 0.002;
      const swayY = Math.sin(t * 0.37) * 0.003;
      const nod = level * 0.006 + (state === "listening" ? Math.sin(t * 2.6) * 0.003 * (0.4 + mic) : 0);
      const thinkTilt = state === "thinking" ? 0.004 : 0;
      off[0] = ease(off[0], px * 0.012 + swayX - thinkTilt, dt, 0.12);
      off[1] = ease(off[1], py * 0.01 + swayY - nod + thinkTilt * 0.5, dt, 0.12);
      const bounce = happyT >= 0 ? Math.sin(Math.min(1, happyT / 0.5) * Math.PI) * 0.01 : 0;
      scale = ease(scale, 1 + (state === "listening" ? 0.012 * (0.5 + mic) : 0) + bounce, dt, 0.2);
      sat = ease(sat, state === "error" ? 0.45 : 1, dt, 0.3);

      frame.scale = scale;
      frame.saturation = sat;
      return frame;
    },
  };
}
