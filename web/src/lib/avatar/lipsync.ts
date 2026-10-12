/**
 * 口型近似（add-ai-avatar-and-landing D3）：用播放输出的频谱能量与三个频段估计 VRM 口型权重。
 * - 低频（200–800 Hz）占优偏 oh/ou，中频（800–2500 Hz）占优偏 aa，高频（2500–5000 Hz）占优偏 ee/ih
 * - 总能量低于噪声门限时全部为 0（闭嘴）
 * - 平滑：attack 60 ms / release 120 ms
 * 浏览器朗读拿不到音频数据时，用 pseudoVisemes(t) 生成 4–6 Hz 叠加的节律口型。
 */

export type Viseme = "aa" | "ih" | "ou" | "ee" | "oh";
export type VisemeWeights = Record<Viseme, number>;

export const VISEMES: Viseme[] = ["aa", "ih", "ou", "ee", "oh"];

export const zeroVisemes = (): VisemeWeights => ({ aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 });

/** AnalyserNode.getByteFrequencyData 的 0–255 能量（归一化后）低于该值视为静音 */
export const NOISE_GATE = 0.06;
/** 开口幅度上限：避免嘴张得过大 */
const MAX_OPEN = 0.9;

const BANDS = { low: [200, 800], mid: [800, 2500], high: [2500, 5000] } as const;

function bandMean(bins: ArrayLike<number>, sampleRate: number, [lo, hi]: readonly [number, number]): number {
  const binHz = sampleRate / 2 / bins.length;
  const start = Math.max(0, Math.floor(lo / binHz));
  const end = Math.min(bins.length, Math.ceil(hi / binHz));
  if (end <= start) return 0;
  let sum = 0;
  for (let i = start; i < end; i++) sum += bins[i];
  return sum / (end - start) / 255;
}

/**
 * 由一帧频谱（getByteFrequencyData，0–255）计算口型权重。
 * @param bins frequencyBinCount 个能量值
 * @param sampleRate AudioContext 采样率
 */
export function visemesFromSpectrum(bins: ArrayLike<number>, sampleRate: number): VisemeWeights {
  const low = bandMean(bins, sampleRate, BANDS.low);
  const mid = bandMean(bins, sampleRate, BANDS.mid);
  const high = bandMean(bins, sampleRate, BANDS.high);
  const energy = (low + mid + high) / 3;
  const out = zeroVisemes();
  if (energy < NOISE_GATE) return out;
  const total = low + mid + high || 1;
  // 开口程度随能量上升，开方让轻声也有可见的开合
  const open = Math.min(MAX_OPEN, Math.sqrt((energy - NOISE_GATE) / (1 - NOISE_GATE)) * 1.6);
  const pl = low / total;
  const pm = mid / total;
  const ph = high / total;
  out.oh = open * pl * 0.75;
  out.ou = open * pl * 0.45;
  out.aa = open * pm;
  out.ee = open * ph * 0.8;
  out.ih = open * ph * 0.5;
  return out;
}

/** 当前权重中占优的口型（无开口时为 null），用于测试与调试 */
export function dominantViseme(w: VisemeWeights): Viseme | null {
  let best: Viseme | null = null;
  let max = 0.01;
  for (const v of VISEMES) {
    if (w[v] > max) {
      max = w[v];
      best = v;
    }
  }
  return best;
}

export interface Smoother {
  /** 输入目标权重与帧间隔（秒），返回平滑后的权重（复用同一对象） */
  next(target: VisemeWeights, dt: number): VisemeWeights;
  reset(): void;
}

/** attack / release 不对称平滑：张嘴快、闭嘴稍慢，避免抖动 */
export function createSmoother(attack = 0.06, release = 0.12): Smoother {
  const cur = zeroVisemes();
  return {
    next(target, dt) {
      for (const v of VISEMES) {
        const tau = target[v] > cur[v] ? attack : release;
        const k = 1 - Math.exp(-Math.max(0, dt) / tau);
        cur[v] += (target[v] - cur[v]) * k;
        if (cur[v] < 1e-3) cur[v] = 0; // 视觉上不可见的残余直接归零
      }
      return cur;
    },
    reset() {
      for (const v of VISEMES) cur[v] = 0;
    },
  };
}

/**
 * 伪口型：无音频数据（浏览器朗读）时的近似节律。t 为秒。
 * 两个不同频率的正弦叠加（约 4.3 Hz 与 5.7 Hz）形成不规则的开合，并在 aa / oh / ee 之间缓慢轮换。
 */
export function pseudoVisemes(t: number): VisemeWeights {
  const open = Math.max(0, 0.5 * Math.sin(t * 2 * Math.PI * 4.3) + 0.35 * Math.sin(t * 2 * Math.PI * 5.7 + 1.3) + 0.15);
  const amp = Math.min(MAX_OPEN, open * 0.85);
  const phase = (Math.sin(t * 1.7) + 1) / 2;
  const out = zeroVisemes();
  out.aa = amp * (0.4 + 0.6 * phase);
  out.oh = amp * 0.5 * (1 - phase);
  out.ee = amp * 0.35 * Math.max(0, Math.sin(t * 2.3));
  return out;
}
