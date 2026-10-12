/**
 * PCM16 → WAV（RIFF / WAVE / fmt PCM / data）。听写上传使用 16 kHz 单声道（design D15）。
 */

export const WAV_HEADER_BYTES = 44;

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataBytes: number;
  durationMs: number;
}

function writeAscii(view: DataView, offset: number, s: string) {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}

/** 编码为 WAV 字节（小端） */
export function encodeWav(samples: Int16Array, sampleRate = 16000, channels = 1): ArrayBuffer {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buf);
  const blockAlign = channels * 2;
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // fmt 块长度
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byteRate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bitsPerSample
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(WAV_HEADER_BYTES + i * 2, samples[i], true);
  return buf;
}

/** 编码为 audio/wav Blob */
export function wavBlob(samples: Int16Array, sampleRate = 16000, channels = 1): Blob {
  return new Blob([encodeWav(samples, sampleRate, channels)], { type: "audio/wav" });
}

/** 解析 WAV 头（只支持 44 字节标准 PCM 头）；格式不符时返回 null */
export function readWavInfo(buf: ArrayBuffer): WavInfo | null {
  if (buf.byteLength < WAV_HEADER_BYTES) return null;
  const view = new DataView(buf);
  const ascii = (o: number, n: number) =>
    String.fromCharCode(...Array.from({ length: n }, (_, i) => view.getUint8(o + i)));
  if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE" || ascii(12, 4) !== "fmt " || ascii(36, 4) !== "data") {
    return null;
  }
  if (view.getUint16(20, true) !== 1) return null;
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  const dataBytes = view.getUint32(40, true);
  const bytesPerSec = sampleRate * channels * (bitsPerSample / 8);
  return { sampleRate, channels, bitsPerSample, dataBytes, durationMs: Math.round((dataBytes / bytesPerSec) * 1000) };
}

/** 样本数对应的时长（毫秒） */
export function durationMs(sampleCount: number, sampleRate = 16000) {
  return Math.round((sampleCount / sampleRate) * 1000);
}
