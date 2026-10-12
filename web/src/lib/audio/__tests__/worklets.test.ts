import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

/** 在模拟的 AudioWorkletGlobalScope 中载入 public/worklets 下的处理器 */
function loadProcessor(file: string, sampleRate: number, options?: unknown) {
  const code = readFileSync(fileURLToPath(new URL(`../../../../public/worklets/${file}`, import.meta.url)), "utf8");
  const registered: Record<string, new (o?: unknown) => unknown> = {};
  const messages: unknown[] = [];
  class AudioWorkletProcessor {
    port = {
      postMessage: (m: unknown) => messages.push(m),
      onmessage: null as ((e: { data: unknown }) => void) | null,
    };
  }
  const ctx = vm.createContext({
    sampleRate,
    AudioWorkletProcessor,
    registerProcessor: (name: string, cls: new () => unknown) => (registered[name] = cls),
    Math,
    Float32Array,
    Int16Array,
  });
  vm.runInContext(code, ctx);
  const name = Object.keys(registered)[0];
  const proc = new registered[name](options) as {
    process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
    port: { onmessage: ((e: { data: unknown }) => void) | null };
  };
  return { name, proc, messages };
}

type Frame = { type: "frame"; pcm: ArrayBuffer; rms: number };

describe("pcm-capture.js", () => {
  it("48 kHz 输入抽取为 16 kHz，每 40 ms 一帧 1280 字节并报告 RMS", () => {
    const { name, proc, messages } = loadProcessor("pcm-capture.js", 48000);
    expect(name).toBe("pcm-capture");
    // 100 ms 的 300 Hz 正弦，按 128 样本渲染量子送入
    const total = 4800;
    for (let off = 0; off < total; off += 128) {
      const block = Float32Array.from({ length: 128 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 300 * (off + i)) / 48000));
      expect(proc.process([[block]], [[new Float32Array(128)]])).toBe(true);
    }
    const frames = messages as Frame[];
    // 1600 个 16 kHz 样本 → 2 个完整帧
    expect(frames).toHaveLength(2);
    expect(frames[0].type).toBe("frame");
    expect(frames[0].pcm.byteLength).toBe(1280);
    expect(frames[0].rms).toBeGreaterThan(0.3);
    expect(frames[0].rms).toBeLessThan(0.4);
    const pcm = new Int16Array(frames[1].pcm);
    expect(Math.max(...pcm)).toBeGreaterThan(14000);
  });

  it("44.1 kHz 输入：1 秒约产出 25 帧", () => {
    const { proc, messages } = loadProcessor("pcm-capture.js", 44100);
    for (let off = 0; off < 44100; off += 128) proc.process([[new Float32Array(128).fill(0.01)]], [[new Float32Array(128)]]);
    expect(messages.length).toBeGreaterThanOrEqual(24);
    expect(messages.length).toBeLessThanOrEqual(25);
  });

  it("收到 stop 后 process 返回 false", () => {
    const { proc } = loadProcessor("pcm-capture.js", 48000);
    proc.port.onmessage?.({ data: { type: "stop" } });
    expect(proc.process([[new Float32Array(128)]], [[new Float32Array(128)]])).toBe(false);
  });
});

describe("pcm-player.js", () => {
  it("24 kHz 样本在 48 kHz 输出中线性插值连续播放，读空后回报 drained 与 push 次数", () => {
    const { name, proc, messages } = loadProcessor("pcm-player.js", 48000, { processorOptions: { inputRate: 24000 } });
    expect(name).toBe("pcm-player");
    proc.port.onmessage?.({ data: { type: "push", samples: Float32Array.from({ length: 64 }, (_, i) => (i % 2 ? 1 : 0)) } });
    const out = new Float32Array(128);
    proc.process([], [[out]]);
    expect(messages[0]).toEqual({ type: "playing" });
    // 0 → 1 之间插出 0.5
    expect(out[0]).toBeCloseTo(0);
    expect(out[1]).toBeCloseTo(0.5);
    expect(out[2]).toBeCloseTo(1);
    // 64 个源样本约 128 个输出样本后读空
    const out2 = new Float32Array(128);
    proc.process([], [[out2]]);
    expect(messages).toContainEqual({ type: "drained", pushes: 1 });
    expect(out2[127]).toBe(0);
  });

  it("clear 清空缓冲并立即回报 drained", () => {
    const { proc, messages } = loadProcessor("pcm-player.js", 48000, { processorOptions: { inputRate: 24000 } });
    proc.port.onmessage?.({ data: { type: "push", samples: new Float32Array(2400).fill(0.2) } });
    proc.process([], [[new Float32Array(128)]]);
    proc.port.onmessage?.({ data: { type: "clear" } });
    expect(messages.at(-1)).toEqual({ type: "drained", pushes: 1 });
    const out = new Float32Array(128);
    proc.process([], [[out]]);
    expect(out.every((v) => v === 0)).toBe(true);
  });
});
