/**
 * 编码音频（MP3）流式播放（improve-speech-playback-latency D1 / D3）：
 * - MseStream：MediaSource / ManagedMediaSource 渐进播放，分包到达即追加，首包即可出声；
 *   多段（每段是一次独立合成、各自带 ID3 头的完整 MP3）以 sequence 模式拼接，段首剥离 ID3 头
 * - SegmentStream：不支持 MediaSource 时的降级——按段（segLast）整段解码、依次播放，至少做到逐句出声
 * 两者实现同一个 EncodedStream 接口，由 PlaybackQueue 驱动。开关 NEXT_PUBLIC_AUDIO_MSE=false 强制降级。
 */

export interface EncodedStream {
  /** 追加一个分包；segLast 表示本段结束（下一个分包是新段的开头） */
  append: (bytes: Uint8Array, segLast?: boolean) => void;
  /** 不再追加：播完全部已追加内容后 done resolve */
  end: () => void;
  /** 立即停止并释放 */
  stop: () => void;
  pause: () => void;
  resume: () => void;
  done: Promise<void>;
}

const MPEG = "audio/mpeg";

type MediaSourceCtor = typeof MediaSource;

function mediaSourceCtor(): MediaSourceCtor | null {
  const w = globalThis as unknown as { ManagedMediaSource?: MediaSourceCtor; MediaSource?: MediaSourceCtor };
  return w.ManagedMediaSource ?? w.MediaSource ?? null;
}

/** 是否可以用 MediaSource 渐进播放 MP3 */
export function mseSupported(): boolean {
  if (process.env.NEXT_PUBLIC_AUDIO_MSE === "false") return false;
  const ctor = mediaSourceCtor();
  try {
    return !!ctor && typeof ctor.isTypeSupported === "function" && ctor.isTypeSupported(MPEG);
  } catch {
    return false;
  }
}

/** 剥离 MP3 开头的 ID3v2 标签（各段拼接时，中间段的 ID3 头会让部分浏览器解码报错） */
export function stripId3(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return bytes;
  // 标签体长度为 4 字节 synchsafe 整数（每字节低 7 位）；flags 第 4 位表示带 10 字节页脚
  const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
  const total = 10 + size + (bytes[5] & 0x10 ? 10 : 0);
  return total >= bytes.length ? new Uint8Array(0) : bytes.subarray(total);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** 播放结束保护：浏览器没有触发 ended（如媒体被挂起）时按已缓冲时长 + 余量结束 */
const END_GRACE_MS = 1500;

export class MseStream implements EncodedStream {
  readonly done: Promise<void>;
  private resolveDone: () => void;
  private ms: MediaSource;
  private url: string;
  private sb: SourceBuffer | null = null;
  private queue: Uint8Array<ArrayBuffer>[] = [];
  private segStart = true;
  private ended = false;
  private finished = false;
  private started = false;
  private paused = false;
  private guard: ReturnType<typeof setTimeout> | null = null;

  constructor(private el: HTMLAudioElement) {
    const d = deferred();
    this.done = d.promise;
    this.resolveDone = d.resolve;
    const Ctor = mediaSourceCtor();
    if (!Ctor) throw new Error("MediaSource 不可用");
    this.ms = new Ctor();
    this.url = URL.createObjectURL(this.ms);
    // ManagedMediaSource（iOS Safari）要求关闭远程播放
    (el as HTMLAudioElement & { disableRemotePlayback?: boolean }).disableRemotePlayback = true;
    el.onended = () => this.finish();
    el.onerror = () => this.finish();
    this.ms.addEventListener("sourceopen", this.onOpen, { once: true });
    el.src = this.url;
  }

  append(bytes: Uint8Array, segLast = false) {
    if (this.finished) return;
    const data = this.segStart ? stripId3(bytes) : bytes;
    this.segStart = segLast;
    if (data.length) this.queue.push(data.slice());
    this.pump();
  }

  end() {
    this.ended = true;
    this.pump();
  }

  pause() {
    this.paused = true;
    this.clearGuard();
    this.el.pause();
  }

  resume() {
    this.paused = false;
    if (this.started) void this.el.play().catch(() => this.finish());
    this.armGuard();
  }

  stop() {
    this.finish();
  }

  private onOpen = () => {
    if (this.finished) return;
    try {
      const sb = this.ms.addSourceBuffer(MPEG);
      sb.mode = "sequence";
      sb.addEventListener("updateend", () => this.pump());
      this.sb = sb;
    } catch {
      this.finish();
      return;
    }
    this.pump();
  };

  private pump() {
    const sb = this.sb;
    if (this.finished || !sb || sb.updating) return;
    const next = this.queue.shift();
    if (next) {
      try {
        sb.appendBuffer(next);
      } catch {
        this.finish();
      }
      return;
    }
    if (!this.started && sb.buffered.length) {
      this.started = true;
      if (!this.paused) void this.el.play().catch(() => this.finish());
    }
    if (this.ended && this.ms.readyState === "open") {
      try {
        this.ms.endOfStream();
      } catch {
        // 已结束
      }
      if (!this.started) this.finish(); // 没有任何可播放的数据
      else this.armGuard();
    }
  }

  private armGuard() {
    if (!this.ended || this.paused || this.finished) return;
    this.clearGuard();
    const sb = this.sb;
    const end = sb && sb.buffered.length ? sb.buffered.end(sb.buffered.length - 1) : 0;
    const remaining = Math.max(0, end - (this.el.currentTime || 0));
    this.guard = setTimeout(() => this.finish(), remaining * 1000 + END_GRACE_MS);
  }

  private clearGuard() {
    if (this.guard) clearTimeout(this.guard);
    this.guard = null;
  }

  private finish() {
    if (this.finished) return;
    this.finished = true;
    this.clearGuard();
    this.queue = [];
    this.el.onended = null;
    this.el.onerror = null;
    this.el.pause();
    this.el.removeAttribute("src");
    this.el.load();
    URL.revokeObjectURL(this.url);
    this.resolveDone();
  }
}

/** 降级：按段整段解码播放（play 负责解码并播完一段） */
export class SegmentStream implements EncodedStream {
  readonly done: Promise<void>;
  private resolveDone: () => void;
  private current: Uint8Array[] = [];
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;
  private ended = false;

  constructor(
    private play: (bytes: Uint8Array) => Promise<void>,
    private control: { stop: () => void; pause?: () => void; resume?: () => void } = { stop: () => undefined },
  ) {
    const d = deferred();
    this.done = d.promise;
    this.resolveDone = d.resolve;
  }

  append(bytes: Uint8Array, segLast = false) {
    if (this.stopped || this.ended) return;
    if (bytes.length) this.current.push(bytes.slice());
    if (segLast) this.flushSegment();
  }

  end() {
    if (this.ended) return;
    this.flushSegment(); // 旧协议：last 落在数据包上、没有 segLast
    this.ended = true;
    void this.chain.then(() => this.resolveDone());
  }

  pause() {
    this.control.pause?.();
  }

  resume() {
    this.control.resume?.();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.current = [];
    this.control.stop();
    this.resolveDone();
  }

  private flushSegment() {
    if (!this.current.length) return;
    const parts = this.current;
    this.current = [];
    const total = parts.reduce((n, p) => n + p.length, 0);
    const bytes = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      bytes.set(p, off);
      off += p.length;
    }
    this.chain = this.chain.then(() => (this.stopped ? undefined : this.play(bytes).catch(() => undefined)));
  }
}
