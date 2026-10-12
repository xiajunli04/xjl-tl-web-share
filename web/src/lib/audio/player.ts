/**
 * 浏览器播放器（design D15、契约 §3）：
 * - pcm16（24 kHz）：AudioWorklet（public/worklets/pcm-player.js）环形缓冲连续播放
 * - mp3：MediaSource 渐进播放（分包到达即追加，improve-speech-playback-latency D1），不支持时按段 decodeAudioData
 * - ttsFallback / ttsEngine=browser：speechSynthesis 朗读
 * 播放状态（playing）通过 onPlayingChange 回调驱动半双工门控。
 * 所有 Web Audio 输出经过同一个输出总线（GainNode），并联 AnalyserNode 供数字人口型分析（getOutputAnalyser）。
 */
import { PLAYBACK_PCM_RATE, bytesToInt16LE, int16ToFloat, linearResample } from "./pcm";
import { PlaybackQueue, type AudioChunk, type AudioMeta, type PlaybackSink } from "./queue";
import { MseStream, SegmentStream, mseSupported, type EncodedStream } from "./streaming";

export type { AudioChunk, AudioMeta } from "./queue";

export const PLAYER_WORKLET_URL = "/worklets/pcm-player.js";

const LANG_TAGS: Record<string, string> = {
  zh: "zh-CN",
  yue: "zh-HK",
  en: "en-US",
  ja: "ja-JP",
  ko: "ko-KR",
  fr: "fr-FR",
  de: "de-DE",
  es: "es-ES",
  ru: "ru-RU",
  pt: "pt-BR",
  it: "it-IT",
  ar: "ar-SA",
  th: "th-TH",
  vi: "vi-VN",
  id: "id-ID",
  tr: "tr-TR",
};

/** 平台语种代码 → BCP-47 标签 */
export function speechLangTag(lang: string): string {
  return LANG_TAGS[lang] ?? lang;
}

export function browserSpeechSupported() {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

export interface PlaybackHandle {
  /** 播放结束（或被停止）时 resolve */
  done: Promise<void>;
  stop: () => void;
}

/**
 * 浏览器朗读。部分环境（无语音包 / 无头浏览器）不会触发 onend，
 * 因此按文本长度设置保护超时，保证调用方的状态能恢复。
 */
export function browserSpeak(text: string, lang: string, opts: { gender?: "female" | "male"; rate?: number } = {}): PlaybackHandle {
  if (!browserSpeechSupported() || !text.trim()) return { done: Promise.resolve(), stop: () => undefined };
  const synth = window.speechSynthesis;
  const u = new SpeechSynthesisUtterance(text);
  const tag = speechLangTag(lang);
  u.lang = tag;
  u.rate = opts.rate ?? 1;
  const voices = synth.getVoices().filter((v) => v.lang.toLowerCase().startsWith(tag.slice(0, 2).toLowerCase()));
  const exact = voices.find((v) => v.lang === tag) ?? voices[0];
  if (exact) u.voice = exact;
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  const guard = setTimeout(() => resolve(), Math.min(60_000, 2000 + Array.from(text).length * 220));
  const end = () => {
    clearTimeout(guard);
    resolve();
  };
  u.onend = end;
  u.onerror = end;
  synth.speak(u);
  return {
    done,
    stop: () => {
      synth.cancel();
      end();
    },
  };
}

/** 播放一段服务端合成的音频（audio/mpeg 或 audio/L16;rate=24000），用于工作台朗读 */
export function playAudioBlob(blob: Blob, contentType = blob.type): PlaybackHandle {
  const type = contentType.toLowerCase();
  if (type.startsWith("audio/l16") || type.includes("pcm")) {
    const rate = Number(/rate=(\d+)/.exec(type)?.[1] ?? PLAYBACK_PCM_RATE);
    const ctx = new AudioContext();
    let source: AudioBufferSourceNode | null = null;
    let stopped = false;
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    const finish = () => {
      resolve();
      void ctx.close().catch(() => undefined);
    };
    void blob.arrayBuffer().then((buf) => {
      if (stopped) return finish();
      const samples = int16ToFloat(bytesToInt16LE(new Uint8Array(buf)));
      const audio = ctx.createBuffer(1, Math.max(1, samples.length), rate);
      audio.copyToChannel(samples, 0);
      source = ctx.createBufferSource();
      source.buffer = audio;
      source.connect(ctx.destination);
      source.onended = finish;
      source.start();
    }, finish);
    return {
      done,
      stop: () => {
        stopped = true;
        try {
          source?.stop();
        } catch {
          // 尚未开始
        }
        finish();
      },
    };
  }
  const url = URL.createObjectURL(blob);
  const el = new Audio(url);
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  const finish = () => {
    URL.revokeObjectURL(url);
    resolve();
  };
  el.onended = finish;
  el.onerror = finish;
  void el.play().catch(finish);
  return {
    done,
    stop: () => {
      el.pause();
      finish();
    },
  };
}

/**
 * 同传播放器：队列 + Web Audio 输出。需在用户手势（点击"开始"）中调用 unlock() 创建 AudioContext。
 */
export class AudioPlayer {
  readonly queue: PlaybackQueue;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private ready: Promise<void> | null = null;
  /** AudioWorklet 不可用（非安全上下文或加载失败）：PCM 直接丢弃，不再缓存 */
  private workletUnavailable = false;
  private pending: Float32Array[] = [];
  private pushes = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private speech: PlaybackHandle | null = null;
  private gender: "female" | "male" = "female";
  private bus: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  /** MediaSource 播放所用的 audio 元素：只创建一次并接入输出总线（createMediaElementSource 每个元素只能调用一次） */
  private media: HTMLAudioElement | null = null;
  private mediaSource: MediaElementAudioSourceNode | null = null;

  constructor() {
    const sink: PlaybackSink = {
      pushPcm: (samples, rate) => this.pushPcm(samples, rate),
      clearPcm: () => {
        this.pending = [];
        this.node?.port.postMessage({ type: "clear" });
      },
      openEncoded: () => this.openEncoded(),
      speak: (text, lang) => {
        const handle = browserSpeak(text, lang, { gender: this.gender });
        this.speech = handle;
        return handle.done.finally(() => {
          if (this.speech === handle) this.speech = null;
        });
      },
      stopAll: () => {
        this.sources.forEach((s) => {
          try {
            s.stop();
          } catch {
            // 已停止
          }
        });
        this.sources.clear();
        this.speech?.stop();
        this.speech = null;
      },
      pause: () => {
        void this.ctx?.suspend().catch(() => undefined);
        if (browserSpeechSupported() && this.speech) window.speechSynthesis.pause();
      },
      resume: () => {
        void this.ctx?.resume().catch(() => undefined);
        if (browserSpeechSupported() && this.speech) window.speechSynthesis.resume();
      },
    };
    this.queue = new PlaybackQueue(sink);
  }

  setGender(g: "female" | "male") {
    this.gender = g;
  }

  /** 在用户手势中调用：创建 / 恢复 AudioContext 并加载播放 worklet */
  unlock(): Promise<void> {
    if (typeof window === "undefined" || typeof AudioContext === "undefined") return Promise.resolve();
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.bus = this.ctx.createGain();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.5;
      this.bus.connect(this.ctx.destination);
      this.bus.connect(this.analyser);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => undefined);
    if (!this.ready && !this.ctx.audioWorklet) {
      // 非安全上下文（如手机用 http://局域网 IP 访问）没有 AudioWorklet：PCM 无法播放（由保护超时结束），
      // MP3 仍走 MediaSource，界面照常工作。不能同步抛错，否则会打断"开始 / 加入"的点击流程
      this.workletUnavailable = true;
      this.pending = [];
      this.ready = Promise.resolve();
    }
    if (!this.ready) {
      const ctx = this.ctx;
      this.ready = ctx.audioWorklet
        .addModule(PLAYER_WORKLET_URL)
        .then(() => {
          const node = new AudioWorkletNode(ctx, "pcm-player", {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            processorOptions: { inputRate: PLAYBACK_PCM_RATE },
          });
          node.port.onmessage = (e: MessageEvent<{ type: string; pushes?: number }>) => {
            if (e.data?.type === "drained" && e.data.pushes === this.pushes) this.queue.notifyPcmDrained();
          };
          node.connect(this.bus ?? ctx.destination);
          this.node = node;
          const queued = this.pending;
          this.pending = [];
          queued.forEach((s) => this.post(s));
        })
        .catch(() => {
          // worklet 不可用：PCM 由保护超时结束，界面仍可工作
          this.workletUnavailable = true;
          this.pending = [];
        });
    }
    return this.ready;
  }

  enqueue(chunk: AudioChunk) {
    this.queue.enqueue(chunk);
  }

  /** 直接入队原始音频字节（工作台流式朗读） */
  enqueueBytes(meta: AudioMeta, bytes: Uint8Array, flags: { segLast?: boolean; last: boolean }) {
    this.queue.enqueueBytes(meta, bytes, flags);
  }

  pause() {
    this.queue.pause();
  }

  resume() {
    this.queue.resume();
  }

  /** 输出总线上的频谱分析节点（数字人口型）；尚未 unlock 时为 null */
  getOutputAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  /** 是否正在用浏览器朗读（拿不到音频数据，数字人改用伪口型） */
  get speakingWithBrowser(): boolean {
    return this.speech !== null;
  }

  speakFallback(utteranceId: string, text: string, lang: string) {
    this.queue.enqueueSpeech(utteranceId, text, lang);
  }

  setEnabled(on: boolean) {
    this.queue.setEnabled(on);
  }

  stop() {
    this.queue.stop();
  }

  async close() {
    this.queue.stop();
    this.node?.disconnect();
    this.node = null;
    this.mediaSource?.disconnect();
    this.mediaSource = null;
    this.media = null;
    this.bus = null;
    this.analyser = null;
    await this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.ready = null;
    this.workletUnavailable = false;
  }

  private pushPcm(samples: Float32Array, rate: number) {
    if (this.workletUnavailable) return;
    const s = rate === PLAYBACK_PCM_RATE ? samples : linearResample(samples, rate, PLAYBACK_PCM_RATE);
    if (this.node) this.post(s);
    else {
      this.pending.push(s);
      void this.unlock();
    }
  }

  private post(samples: Float32Array) {
    this.pushes++;
    this.node?.port.postMessage({ type: "push", samples }, [samples.buffer]);
  }

  private openEncoded(): EncodedStream {
    if (mseSupported()) {
      try {
        return new MseStream(this.mediaElement());
      } catch {
        // MediaSource 创建失败：降级为按段解码
      }
    }
    return new SegmentStream((bytes) => this.playEncoded(bytes), {
      stop: () => this.stopSources(),
      pause: () => void this.ctx?.suspend().catch(() => undefined),
      resume: () => void this.ctx?.resume().catch(() => undefined),
    });
  }

  /** 复用的 audio 元素；已有 AudioContext 时接入输出总线，口型分析与 Web Audio 输出一致 */
  private mediaElement(): HTMLAudioElement {
    if (!this.media) {
      this.media = new Audio();
      this.media.preload = "auto";
    }
    if (this.ctx && this.bus && !this.mediaSource) {
      try {
        this.mediaSource = this.ctx.createMediaElementSource(this.media);
        this.mediaSource.connect(this.bus);
      } catch {
        // 已接入或不支持：元素直接输出
      }
    }
    return this.media;
  }

  private stopSources() {
    this.sources.forEach((s) => {
      try {
        s.stop();
      } catch {
        // 已停止
      }
    });
    this.sources.clear();
  }

  private async playEncoded(bytes: Uint8Array): Promise<void> {
    await this.unlock();
    const ctx = this.ctx;
    if (!ctx) return;
    const copy = bytes.slice().buffer;
    const buffer = await ctx.decodeAudioData(copy);
    await new Promise<void>((resolve) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.bus ?? ctx.destination);
      this.sources.add(src);
      const guard = setTimeout(() => done(), buffer.duration * 1000 + 1500);
      const done = () => {
        clearTimeout(guard);
        this.sources.delete(src);
        resolve();
      };
      src.onended = done;
      src.start();
    });
  }
}
