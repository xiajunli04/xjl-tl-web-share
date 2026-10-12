/**
 * 播报队列（与具体音频 API 解耦，便于单测）：
 * - pcm16：同句的包按到达顺序流式推入连续播放缓冲（边收边播）；最后一包推入且缓冲读空后该句结束
 * - mp3（improve-speech-playback-latency D1 / D3）：轮到该句时打开一个编码流（MediaSource 渐进播放，或按段整解码的降级），
 *   分包到达即追加，不再等整句 last；segLast 标记一次独立合成（段）的结束；last（可能是 data 为空的终止包）后结束编码流
 * - speech：浏览器朗读兜底（ttsFallback / ttsEngine=browser）
 * 句与句按入队顺序串行；队列由空变为非空 / 由非空变为空时回调 onPlayingChange，驱动半双工门控（design D8）。
 * pause / resume：重播字幕时暂停实时播报，结束后继续（D8 重播互斥）。
 * 开播门（improve-speech-endpointing-and-live-ux D7）：setStartGate 后，开始新的一句前先问门是否允许（如本机用户正在说话
 * 时推迟），不允许则每 100 ms 复查，自该句首包到达起超过 maxDeferMs 后照常开播；已开始的句子不受影响。
 * drop(utteranceId)：丢弃尚未开始播放的一句（AI 回复让位）。
 */
import type { EncodedStream } from "./streaming";
import { base64ToBytes, bytesToInt16LE, int16ToFloat } from "./pcm";

export type AudioFormat = "pcm16" | "mp3";

export interface AudioChunk {
  utteranceId: string;
  lang: string;
  format: AudioFormat;
  sampleRate: number;
  seq: number;
  /** 段号（同一 utteranceId + lang 内从 0 递增）；旧协议没有 */
  seg?: number;
  /** 本段最后一包 */
  segLast?: boolean;
  /** track 结束（新协议下通常是 data 为空的终止包） */
  last: boolean;
  /** base64，可能为空 */
  data: string;
}

export interface AudioMeta {
  utteranceId: string;
  lang: string;
  format: AudioFormat;
  sampleRate: number;
}

export interface PlaybackSink {
  /** 推入连续播放缓冲（浮点样本，采样率 sampleRate） */
  pushPcm: (samples: Float32Array, sampleRate: number) => void;
  /** 清空连续播放缓冲 */
  clearPcm: () => void;
  /** 打开一个编码音频（mp3）流 */
  openEncoded: () => EncodedStream;
  /** 浏览器朗读，读完 resolve */
  speak: (text: string, lang: string) => Promise<void>;
  /** 停止正在进行的编码音频与朗读 */
  stopAll: () => void;
  /** 暂停 / 恢复输出（连续播放缓冲与朗读） */
  pause?: () => void;
  resume?: () => void;
}

interface Chunk {
  bytes: Uint8Array;
  segLast: boolean;
}

interface Item {
  key: string;
  utteranceId: string;
  lang: string;
  kind: "pcm" | "mp3" | "speech";
  chunks: Chunk[];
  last: boolean;
  text?: string;
  sampleRate: number;
  /** 已交给输出的包数 */
  pushed: number;
  /** pcm：已推入的样本数 */
  samples: number;
  startedAt?: number;
  /** 入队时间（开播门推迟上限从这里算起） */
  queuedAt: number;
  /** mp3：编码流 */
  stream?: EncodedStream;
  streamEnded?: boolean;
}

/** pcm 句结束的保护超时：缓冲未回报读空时（如 AudioContext 被挂起），按时长 + 余量强制结束 */
export const PCM_GRACE_MS = 1500;
/** 开播门：推迟开播的上限与复查间隔 */
export const MAX_DEFER_MS = 4000;
const RECHECK_MS = 100;
const STARTED_KEEP = 64;

export class PlaybackQueue {
  private items: Item[] = [];
  private current: Item | null = null;
  private generation = 0;
  private enabled = true;
  private playing = false;
  private paused = false;
  private pausedAt = 0;
  private guard: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<(playing: boolean) => void>();
  private currentListeners = new Set<(utteranceId: string | null) => void>();
  private startGate: (() => boolean) | null = null;
  private maxDeferMs = MAX_DEFER_MS;
  private recheckTimer: ReturnType<typeof setTimeout> | null = null;
  /** 已开始播放过的句子（让位只针对还没开播的回复） */
  private startedIds: string[] = [];

  constructor(
    private sink: PlaybackSink,
    private now: () => number = Date.now,
  ) {}

  /** 设置开播门（null 表示不限制） */
  setStartGate(canStart: (() => boolean) | null, maxDeferMs = MAX_DEFER_MS) {
    this.startGate = canStart;
    this.maxDeferMs = maxDeferMs;
    this.pump();
  }

  /** 开播门的条件可能已变化：立即尝试开播 */
  recheck() {
    this.pump();
  }

  /** 该句是否已经开始播放过 */
  hasStarted(utteranceId: string) {
    return this.startedIds.includes(utteranceId);
  }

  /** 是否有等待开播的句子（被开播门推迟） */
  get deferred() {
    return !this.current && this.items.length > 0 && !this.paused;
  }

  /** 丢弃尚未开始播放的一句；已在播放或播放过时不处理，返回是否丢弃了 */
  drop(utteranceId: string) {
    if (this.current?.utteranceId === utteranceId || this.hasStarted(utteranceId)) return false;
    const before = this.items.length;
    this.items = this.items.filter((i) => i.utteranceId !== utteranceId);
    return this.items.length < before;
  }

  get isPlaying() {
    return this.playing;
  }

  get isPaused() {
    return this.paused;
  }

  get currentUtterance(): string | null {
    return this.current?.utteranceId ?? null;
  }

  /** 队列中（含正在播放）的句数 */
  get size() {
    return this.items.length;
  }

  onPlayingChange(fn: (playing: boolean) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 正在播报的句子变化（开始播报新句 / 播完 / 停止），用于在对应气泡上显示声波 */
  onCurrentChange(fn: (utteranceId: string | null) => void) {
    this.currentListeners.add(fn);
    return () => this.currentListeners.delete(fn);
  }

  private setCurrent(item: Item | null) {
    const before = this.current?.utteranceId ?? null;
    this.current = item;
    const after = item?.utteranceId ?? null;
    if (before !== after) this.currentListeners.forEach((fn) => fn(after));
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (!on) this.stop();
  }

  /** 收到 audio 事件 */
  enqueue(chunk: AudioChunk) {
    this.enqueueBytes(chunk, chunk.data ? base64ToBytes(chunk.data) : new Uint8Array(0), {
      segLast: !!chunk.segLast,
      last: chunk.last,
    });
  }

  /** 直接入队原始音频字节（工作台流式朗读） */
  enqueueBytes(meta: AudioMeta, bytes: Uint8Array, flags: { segLast?: boolean; last: boolean }) {
    if (!this.enabled) return;
    const kind = meta.format === "mp3" ? "mp3" : "pcm";
    const key = `${meta.utteranceId}|${meta.lang}`;
    let item = this.items.find((i) => i.key === key && i.kind === kind);
    if (!item) {
      if (!bytes.length && flags.last) return; // 没有任何音频的终止包
      // 同句已排了浏览器朗读兜底：服务端音频优先，替换掉尚未开始的朗读
      const speechIdx = this.items.findIndex((i) => i.key === key && i.kind === "speech" && i !== this.current);
      item = { key, utteranceId: meta.utteranceId, lang: meta.lang, kind, chunks: [], last: false, sampleRate: meta.sampleRate || 24000, pushed: 0, samples: 0, queuedAt: this.now() };
      if (speechIdx >= 0) this.items.splice(speechIdx, 1, item);
      else this.items.push(item);
    }
    if (item.last) return; // 句已结束，忽略重复包
    if (bytes.length || flags.segLast) item.chunks.push({ bytes, segLast: !!flags.segLast });
    item.last = flags.last;
    if (item === this.current) this.advance(item);
    else this.pump();
  }

  /** 浏览器朗读兜底（同句已有服务端音频时忽略） */
  enqueueSpeech(utteranceId: string, text: string, lang: string) {
    if (!this.enabled || !text.trim()) return;
    const key = `${utteranceId}|${lang}`;
    if (this.items.some((i) => i.key === key)) return;
    this.items.push({ key, utteranceId, lang, kind: "speech", chunks: [], last: true, text, sampleRate: 0, pushed: 0, samples: 0, queuedAt: this.now() });
    this.pump();
  }

  /** 连续播放缓冲已读空（sink 在"最后一次推入之后"的读空时调用） */
  notifyPcmDrained() {
    const cur = this.current;
    if (!this.paused && cur?.kind === "pcm" && cur.last && cur.pushed === cur.chunks.length) this.finish(cur);
  }

  /** 停止并清空 */
  stop() {
    this.generation++;
    const cur = this.current;
    this.items = [];
    this.setCurrent(null);
    this.paused = false;
    this.clearGuard();
    this.clearRecheck();
    cur?.stream?.stop();
    this.sink.clearPcm();
    this.sink.stopAll();
    this.setPlaying(false);
  }

  /** 暂停播报（当前句停在原处，后续句不开始） */
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.pausedAt = Date.now();
    this.clearGuard();
    this.current?.stream?.pause();
    this.sink.pause?.();
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    const cur = this.current;
    if (cur?.startedAt !== undefined) cur.startedAt += Date.now() - this.pausedAt;
    this.sink.resume?.();
    cur?.stream?.resume();
    if (cur?.kind === "pcm" && cur.last) this.armGuard(cur);
    this.pump();
  }

  private pump() {
    if (this.paused || this.current || !this.items.length) return;
    const item = this.items[0];
    if (this.startGate && !this.startGate() && this.now() - item.queuedAt < this.maxDeferMs) {
      this.scheduleRecheck();
      return;
    }
    this.clearRecheck();
    this.startedIds.push(item.utteranceId);
    if (this.startedIds.length > STARTED_KEEP) this.startedIds.shift();
    this.setCurrent(item);
    item.startedAt = Date.now();
    this.setPlaying(true);
    if (item.kind === "speech") {
      const gen = this.generation;
      void this.sink
        .speak(item.text ?? "", item.lang)
        .catch(() => undefined)
        .then(() => gen === this.generation && this.finish(item));
      return;
    }
    this.advance(item);
  }

  private advance(item: Item) {
    if (item.kind === "pcm") {
      while (item.pushed < item.chunks.length) {
        const samples = int16ToFloat(bytesToInt16LE(item.chunks[item.pushed].bytes));
        item.pushed++;
        item.samples += samples.length;
        if (samples.length) this.sink.pushPcm(samples, item.sampleRate);
      }
      if (item.last && !this.paused) this.armGuard(item);
      return;
    }
    if (item.kind !== "mp3") return;
    if (!item.stream) {
      const gen = this.generation;
      const stream = this.sink.openEncoded();
      item.stream = stream;
      void stream.done.then(() => gen === this.generation && this.finish(item));
    }
    while (item.pushed < item.chunks.length) {
      const c = item.chunks[item.pushed];
      item.pushed++;
      item.stream.append(c.bytes, c.segLast);
    }
    if (item.last && !item.streamEnded) {
      item.streamEnded = true;
      item.stream.end();
    }
  }

  private armGuard(item: Item) {
    this.clearGuard();
    const durMs = (item.samples / item.sampleRate) * 1000;
    const due = Math.max((item.startedAt ?? Date.now()) + durMs + PCM_GRACE_MS, Date.now() + 1000);
    this.guard = setTimeout(() => this.current === item && this.finish(item), due - Date.now());
  }

  private clearGuard() {
    if (this.guard) clearTimeout(this.guard);
    this.guard = null;
  }

  private scheduleRecheck() {
    if (this.recheckTimer) return;
    this.recheckTimer = setTimeout(() => {
      this.recheckTimer = null;
      this.pump();
    }, RECHECK_MS);
  }

  private clearRecheck() {
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
    this.recheckTimer = null;
  }

  private finish(item: Item) {
    if (this.current !== item) return;
    this.clearGuard();
    this.items.shift();
    this.setCurrent(null);
    if (this.items.length) this.pump();
    else this.setPlaying(false);
  }

  private setPlaying(p: boolean) {
    if (this.playing === p) return;
    this.playing = p;
    this.listeners.forEach((fn) => fn(p));
  }
}
