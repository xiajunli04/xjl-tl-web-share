import { describe, expect, it } from "vitest";
import {
  Decimator,
  FRAME_SAMPLES,
  Framer,
  base64ToBytes,
  bytesToBase64,
  bytesToInt16LE,
  concatInt16,
  floatToInt16,
  int16ToBytesLE,
  int16ToFloat,
  levelFromRms,
  linearResample,
  resample,
  rms,
} from "../pcm";

const sine = (n: number, rate: number, freq: number, amp = 0.5) =>
  Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / rate));

describe("Decimator / resample", () => {
  it("48 kHz → 16 kHz 输出长度为 1/3，且每个样本为对应 3 个输入的均值", () => {
    const input = Float32Array.from({ length: 48 }, (_, i) => i);
    const out = resample(input, 48000, 16000);
    expect(out.length).toBe(16);
    expect(out[0]).toBeCloseTo((0 + 1 + 2) / 3);
    expect(out[15]).toBeCloseTo((45 + 46 + 47) / 3);
  });

  it("44.1 kHz → 16 kHz 跨多次 push 保持相位连续，总长度≈N/2.75625", () => {
    const d = new Decimator(44100, 16000);
    let total = 0;
    for (let i = 0; i < 100; i++) total += d.push(new Float32Array(128)).length;
    const expected = (100 * 128) / (44100 / 16000);
    expect(Math.abs(total - expected)).toBeLessThanOrEqual(1);
  });

  it("抽取后低频正弦的幅度基本保留", () => {
    const out = resample(sine(4800, 48000, 300), 48000);
    expect(rms(out)).toBeCloseTo(0.5 / Math.SQRT2, 1);
  });

  it("同采样率直通", () => {
    const input = Float32Array.from([0.1, 0.2, 0.3]);
    expect(Array.from(resample(input, 16000))).toEqual(Array.from(input));
  });

  it("非法采样率抛错", () => {
    expect(() => new Decimator(0)).toThrow();
  });
});

describe("样本格式转换", () => {
  it("floatToInt16 截断越界并按正负量程取整", () => {
    expect(Array.from(floatToInt16([0, 1, -1, 2, -2, 0.5]))).toEqual([0, 32767, -32768, 32767, -32768, 16384]);
  });

  it("int16ToFloat 与 floatToInt16 往返误差小于 2/32768", () => {
    const src = [0.25, -0.75, 0.999];
    const back = int16ToFloat(floatToInt16(src));
    src.forEach((v, i) => expect(Math.abs(back[i] - v)).toBeLessThan(2 / 32768));
  });

  it("PCM16LE 字节往返", () => {
    const s = Int16Array.from([1, -2, 300, -32768, 32767]);
    expect(Array.from(bytesToInt16LE(int16ToBytesLE(s)))).toEqual(Array.from(s));
    expect(Array.from(int16ToBytesLE(Int16Array.from([0x0102])))).toEqual([0x02, 0x01]);
  });

  it("base64 往返（含大于 32 KB 的分块）", () => {
    const bytes = Uint8Array.from({ length: 70000 }, (_, i) => i % 251);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });

  it("linearResample 24k → 48k 长度翻倍并在样本间插值", () => {
    const out = linearResample(Float32Array.from([0, 1, 0]), 24000, 48000);
    expect(out.length).toBe(6);
    expect(out[1]).toBeCloseTo(0.5);
  });
});

describe("电平", () => {
  it("rms 计算正确且空数组为 0", () => {
    expect(rms([])).toBe(0);
    expect(rms([0.5, -0.5])).toBeCloseTo(0.5);
  });

  it("levelFromRms：-60 dB 为 0，-12 dB 以上为 1，单调递增", () => {
    expect(levelFromRms(0)).toBe(0);
    expect(levelFromRms(0.001)).toBeCloseTo(0);
    expect(levelFromRms(0.3)).toBe(1);
    expect(levelFromRms(0.01)).toBeLessThan(levelFromRms(0.05));
  });
});

describe("Framer", () => {
  it("按 640 样本切帧，余量保留到下次", () => {
    const f = new Framer();
    expect(FRAME_SAMPLES).toBe(640);
    expect(f.push(new Int16Array(500))).toHaveLength(0);
    const frames = f.push(Int16Array.from({ length: 1000 }, (_, i) => i));
    expect(frames).toHaveLength(2);
    expect(frames[0].length).toBe(640);
    // 第二帧从新片段的第 140 个样本开始
    expect(frames[1][0]).toBe(140);
    expect(f.flush()?.length).toBe(1500 - 1280);
    expect(f.flush()).toBeNull();
  });

  it("concatInt16 拼接", () => {
    expect(Array.from(concatInt16([Int16Array.from([1, 2]), Int16Array.from([3])]))).toEqual([1, 2, 3]);
  });
});
