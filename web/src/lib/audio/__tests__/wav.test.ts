import { describe, expect, it } from "vitest";
import { WAV_HEADER_BYTES, durationMs, encodeWav, readWavInfo, wavBlob } from "../wav";

const ascii = (buf: ArrayBuffer, o: number, n: number) =>
  String.fromCharCode(...new Uint8Array(buf, o, n));

describe("encodeWav", () => {
  it("写出标准 44 字节 PCM 头（16 kHz 单声道 16 bit）", () => {
    const samples = Int16Array.from({ length: 16000 }, (_, i) => (i % 2 ? 1000 : -1000));
    const buf = encodeWav(samples, 16000, 1);
    const v = new DataView(buf);
    expect(buf.byteLength).toBe(WAV_HEADER_BYTES + 32000);
    expect(ascii(buf, 0, 4)).toBe("RIFF");
    expect(v.getUint32(4, true)).toBe(36 + 32000);
    expect(ascii(buf, 8, 4)).toBe("WAVE");
    expect(ascii(buf, 12, 4)).toBe("fmt ");
    expect(v.getUint32(16, true)).toBe(16);
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint32(28, true)).toBe(32000);
    expect(v.getUint16(32, true)).toBe(2);
    expect(v.getUint16(34, true)).toBe(16);
    expect(ascii(buf, 36, 4)).toBe("data");
    expect(v.getUint32(40, true)).toBe(32000);
    // 样本小端写入
    expect(v.getInt16(44, true)).toBe(-1000);
    expect(v.getInt16(46, true)).toBe(1000);
  });

  it("readWavInfo 解析时长；非 WAV 返回 null", () => {
    const info = readWavInfo(encodeWav(new Int16Array(48000), 16000));
    expect(info).toEqual({ sampleRate: 16000, channels: 1, bitsPerSample: 16, dataBytes: 96000, durationMs: 3000 });
    expect(readWavInfo(new ArrayBuffer(10))).toBeNull();
    expect(readWavInfo(new ArrayBuffer(64))).toBeNull();
  });

  it("空音频也能生成合法头", () => {
    expect(readWavInfo(encodeWav(new Int16Array(0)))?.dataBytes).toBe(0);
  });

  it("wavBlob 类型为 audio/wav", async () => {
    const b = wavBlob(new Int16Array(10));
    expect(b.type).toBe("audio/wav");
    expect(b.size).toBe(WAV_HEADER_BYTES + 20);
  });

  it("durationMs", () => {
    expect(durationMs(8000)).toBe(500);
    expect(durationMs(24000, 24000)).toBe(1000);
  });
});
