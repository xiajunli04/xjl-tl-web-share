/**
 * 麦克风采集 AudioWorkletProcessor（docs/contracts/speech-image-api.md §3）
 *
 * - 把 AudioContext 采样率（通常 48 kHz / 44.1 kHz）抽取到 16 kHz：每个输出样本取对应输入区间的均值（盒式低通 + 抽取）
 * - 转成 Int16（PCM16LE），每 40 ms（640 样本 = 1280 字节）通过 port 投递一帧：{type:"frame", pcm:ArrayBuffer, rms}
 * - rms 为该帧浮点样本的均方根（0–1），供电平动效使用
 *
 * 注意：该文件以原生 JS 运行在 AudioWorkletGlobalScope 中，不能 import；
 * 单测（src/lib/audio/__tests__/worklets.test.ts）通过 vm 载入本文件验证抽取与分帧。
 */

const OUT_RATE = 16000;
const FRAME_MS = 40;

class Decimator {
  constructor(inRate, outRate) {
    this.ratio = inRate / outRate;
    this.acc = 0; // 当前输出区间已累计的输入样本数（可为小数边界）
    this.sum = 0;
    this.count = 0;
  }

  /** @param {Float32Array} input @param {(v:number)=>void} emit */
  push(input, emit) {
    if (this.ratio <= 1) {
      for (let i = 0; i < input.length; i++) emit(input[i]);
      return;
    }
    for (let i = 0; i < input.length; i++) {
      this.sum += input[i];
      this.count++;
      this.acc += 1;
      if (this.acc >= this.ratio) {
        emit(this.sum / this.count);
        this.acc -= this.ratio;
        this.sum = 0;
        this.count = 0;
      }
    }
  }
}

const Base =
  typeof AudioWorkletProcessor !== "undefined"
    ? AudioWorkletProcessor
    : class {
        constructor() {
          this.port = { postMessage() {}, onmessage: null };
        }
      };

class PcmCaptureProcessor extends Base {
  constructor(options) {
    super(options);
    const inRate = typeof sampleRate === "number" ? sampleRate : 48000;
    this.decimator = new Decimator(inRate, OUT_RATE);
    this.frameSize = (OUT_RATE * FRAME_MS) / 1000;
    this.frame = new Int16Array(this.frameSize);
    this.offset = 0;
    this.sq = 0;
    this.stopped = false;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === "stop") this.stopped = true;
    };
    this.emitSample = (v) => {
      const s = v > 1 ? 1 : v < -1 ? -1 : v;
      this.sq += s * s;
      this.frame[this.offset++] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
      if (this.offset === this.frameSize) {
        const rms = Math.sqrt(this.sq / this.frameSize);
        const buf = this.frame.buffer;
        this.port.postMessage({ type: "frame", pcm: buf, rms: rms > 1 ? 1 : rms }, [buf]);
        this.frame = new Int16Array(this.frameSize);
        this.offset = 0;
        this.sq = 0;
      }
    };
  }

  process(inputs) {
    if (this.stopped) return false;
    const input = inputs[0];
    if (input && input.length > 0) {
      // 多声道时取第一声道（getUserMedia 默认单声道）
      this.decimator.push(input[0], this.emitSample);
    }
    return true;
  }
}

if (typeof registerProcessor === "function") {
  registerProcessor("pcm-capture", PcmCaptureProcessor);
}
