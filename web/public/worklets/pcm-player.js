/**
 * PCM16 连续播放 AudioWorkletProcessor（docs/contracts/speech-image-api.md §3）
 *
 * - 主线程通过 port 投递 {type:"push", samples:Float32Array}（源采样率由 processorOptions.inputRate 指定，默认 24 kHz）
 * - 环形缓冲连续读取，按 inputRate → AudioContext 采样率做线性插值
 * - 状态回报：缓冲由空变为有数据时 {type:"playing"}；读空时 {type:"drained", pushes}（pushes 为已处理的 push 次数，
 *   主线程据此判断"最后一包是否已播完"，避免旧的 drained 消息误判）
 * - {type:"clear"} 清空缓冲（停止播报）
 *
 * 原生 JS，运行在 AudioWorkletGlobalScope；单测通过 vm 载入。
 */

class RingBuffer {
  constructor(capacity) {
    this.buf = new Float32Array(capacity);
    this.capacity = capacity;
    this.read = 0;
    this.size = 0;
  }

  /** 写入；溢出时丢弃最旧的样本 */
  write(samples) {
    const n = samples.length;
    for (let i = 0; i < n; i++) {
      const w = (this.read + this.size) % this.capacity;
      this.buf[w] = samples[i];
      if (this.size < this.capacity) this.size++;
      else this.read = (this.read + 1) % this.capacity;
    }
  }

  /** 读取相对读指针偏移 k 处的样本（不移动指针） */
  peek(k) {
    return this.buf[(this.read + k) % this.capacity];
  }

  skip(n) {
    const m = n > this.size ? this.size : n;
    this.read = (this.read + m) % this.capacity;
    this.size -= m;
  }

  clear() {
    this.read = 0;
    this.size = 0;
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

class PcmPlayerProcessor extends Base {
  constructor(options) {
    super(options);
    const opts = (options && options.processorOptions) || {};
    const outRate = typeof sampleRate === "number" ? sampleRate : 48000;
    this.inputRate = opts.inputRate || 24000;
    this.step = this.inputRate / outRate; // 每个输出样本前进的源样本数
    this.ring = new RingBuffer(Math.ceil(this.inputRate * (opts.seconds || 60)));
    this.frac = 0;
    this.playing = false;
    this.pushes = 0;
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.type === "push" && d.samples) {
        this.ring.write(d.samples);
        this.pushes++;
      } else if (d.type === "clear") {
        this.ring.clear();
        this.frac = 0;
        if (this.playing) {
          this.playing = false;
          this.port.postMessage({ type: "drained", pushes: this.pushes });
        }
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    const ring = this.ring;
    for (let i = 0; i < out.length; i++) {
      // 线性插值需要当前样本与下一个样本
      if (ring.size >= 2 || (ring.size === 1 && this.frac === 0)) {
        if (!this.playing) {
          this.playing = true;
          this.port.postMessage({ type: "playing" });
        }
        const a = ring.peek(0);
        const b = ring.size >= 2 ? ring.peek(1) : a;
        out[i] = a + (b - a) * this.frac;
        this.frac += this.step;
        const whole = Math.floor(this.frac);
        if (whole > 0) {
          ring.skip(whole);
          this.frac -= whole;
        }
      } else {
        out[i] = 0;
        if (ring.size === 1) ring.skip(1);
        if (this.playing) {
          this.playing = false;
          this.frac = 0;
          this.port.postMessage({ type: "drained", pushes: this.pushes });
        }
      }
    }
    // 其余声道复制第一声道
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    return true;
  }
}

if (typeof registerProcessor === "function") {
  registerProcessor("pcm-player", PcmPlayerProcessor);
}
