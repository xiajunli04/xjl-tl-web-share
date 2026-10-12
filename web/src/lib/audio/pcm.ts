/**
 * PCM 纯函数工具（与 public/worklets/pcm-capture.js 的算法一致，便于单测与主线程复用）。
 * 约定：上行 PCM16LE / 16 kHz / 单声道；下行 pcm16 为 24 kHz。
 */

export const CAPTURE_RATE = 16000;
export const FRAME_MS = 40;
/** 每帧样本数（40 ms @ 16 kHz = 640） */
export const FRAME_SAMPLES = (CAPTURE_RATE * FRAME_MS) / 1000;
export const PLAYBACK_PCM_RATE = 24000;

/**
 * 流式抽取器：把 inRate 抽取到 outRate，每个输出样本取对应输入区间的均值（盒式低通）。
 * 支持非整数比例（44.1 kHz → 16 kHz）；跨多次 push 保持相位连续。
 */
export class Decimator {
  readonly ratio: number;
  private acc = 0;
  private sum = 0;
  private count = 0;

  constructor(inRate: number, outRate = CAPTURE_RATE) {
    if (inRate <= 0 || outRate <= 0) throw new Error("采样率必须为正数");
    this.ratio = inRate / outRate;
  }

  push(input: ArrayLike<number>): Float32Array {
    if (this.ratio <= 1) return Float32Array.from(input);
    const out = new Float32Array(Math.ceil((input.length + this.acc) / this.ratio) + 1);
    let n = 0;
    for (let i = 0; i < input.length; i++) {
      this.sum += input[i];
      this.count++;
      this.acc += 1;
      if (this.acc >= this.ratio) {
        out[n++] = this.sum / this.count;
        this.acc -= this.ratio;
        this.sum = 0;
        this.count = 0;
      }
    }
    return out.subarray(0, n);
  }
}

/** 一次性抽取（非流式） */
export function resample(input: ArrayLike<number>, inRate: number, outRate = CAPTURE_RATE): Float32Array {
  return new Decimator(inRate, outRate).push(input);
}

/** 浮点 [-1,1] → Int16（越界截断） */
export function floatToInt16(input: ArrayLike<number>): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/** Int16 → 浮点 [-1,1) */
export function int16ToFloat(input: Int16Array): Float32Array<ArrayBuffer> {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[i] / 0x8000;
  return out;
}

/** 均方根（浮点样本） */
export function rms(samples: ArrayLike<number>): number {
  if (!samples.length) return 0;
  let sq = 0;
  for (let i = 0; i < samples.length; i++) sq += samples[i] * samples[i];
  return Math.min(1, Math.sqrt(sq / samples.length));
}

/**
 * RMS → 0–1 视觉电平：按分贝映射（-60 dB 为 0，-12 dB 及以上为 1），让轻声说话也有明显反馈。
 */
export function levelFromRms(value: number): number {
  if (!(value > 0)) return 0;
  const db = 20 * Math.log10(value);
  return Math.max(0, Math.min(1, (db + 60) / 48));
}

/**
 * 分帧器：累积任意长度的 Int16 片段，凑满 frameSize 即输出一帧；flush() 返回不足一帧的余量。
 */
export class Framer {
  private buf: Int16Array;
  private offset = 0;

  constructor(readonly frameSize = FRAME_SAMPLES) {
    this.buf = new Int16Array(frameSize);
  }

  push(chunk: Int16Array): Int16Array[] {
    const frames: Int16Array[] = [];
    let i = 0;
    while (i < chunk.length) {
      const n = Math.min(this.frameSize - this.offset, chunk.length - i);
      this.buf.set(chunk.subarray(i, i + n), this.offset);
      this.offset += n;
      i += n;
      if (this.offset === this.frameSize) {
        frames.push(this.buf);
        this.buf = new Int16Array(this.frameSize);
        this.offset = 0;
      }
    }
    return frames;
  }

  flush(): Int16Array | null {
    if (!this.offset) return null;
    const rest = this.buf.slice(0, this.offset);
    this.offset = 0;
    return rest;
  }
}

/** 拼接多个 Int16 片段 */
export function concatInt16(chunks: Int16Array[]): Int16Array {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Int16Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** base64 → 字节 */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 字节 → base64 */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** PCM16LE 字节 → Int16Array（与平台字节序无关） */
export function bytesToInt16LE(bytes: Uint8Array): Int16Array {
  const n = bytes.length >> 1;
  const out = new Int16Array(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

/** Int16Array → PCM16LE 字节 */
export function int16ToBytesLE(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i], true);
  return out;
}

/** 线性插值重采样（用于下行 PCM 采样率与播放缓冲不一致时；上采样或下采样均可） */
export function linearResample(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate || input.length === 0) return input;
  const outLen = Math.max(1, Math.round((input.length * outRate) / inRate));
  const out = new Float32Array(outLen);
  const step = inRate / outRate;
  for (let i = 0; i < outLen; i++) {
    const pos = i * step;
    const j = Math.floor(pos);
    const a = input[Math.min(j, input.length - 1)];
    const b = input[Math.min(j + 1, input.length - 1)];
    out[i] = a + (b - a) * (pos - j);
  }
  return out;
}

/** 合并多个字节片段 */
export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
