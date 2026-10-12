import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HalfDuplexGate, RESUME_DELAY_MS } from "../half-duplex";
import { bytesToBase64, int16ToBytesLE } from "../pcm";
import { PlaybackQueue, type AudioChunk, type PlaybackSink } from "../queue";
import type { EncodedStream } from "../streaming";

/** 假编码流：记录追加的分包（字节数与段尾标记），end 后由测试调用 finish 模拟播完 */
function fakeStream(log: string[]) {
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  const stream: EncodedStream & { finish: () => void } = {
    append: (bytes, segLast) => log.push(`mp3+${bytes.length}${segLast ? "|seg" : ""}`),
    end: () => log.push("mp3:end"),
    stop: () => {
      log.push("mp3:stop");
      resolve();
    },
    pause: () => log.push("mp3:pause"),
    resume: () => log.push("mp3:resume"),
    done,
    finish: () => resolve(),
  };
  return stream;
}

function fakeSink() {
  const log: string[] = [];
  const pending: { resolve: () => void; what: string }[] = [];
  const streams: ReturnType<typeof fakeStream>[] = [];
  const sink: PlaybackSink = {
    pushPcm: (s, rate) => log.push(`pcm:${s.length}@${rate}`),
    clearPcm: () => log.push("clear"),
    openEncoded: () => {
      log.push("mp3:open");
      const st = fakeStream(log);
      streams.push(st);
      return st;
    },
    pause: () => log.push("pause"),
    resume: () => log.push("resume"),
    speak: (text, lang) =>
      new Promise<void>((resolve) => {
        log.push(`speak:${lang}:${text}`);
        pending.push({ resolve, what: "speak" });
      }),
    stopAll: () => log.push("stopAll"),
  };
  return { sink, log, pending, streams };
}

const pcm = (utt: string, seq: number, last: boolean, samples = 240): AudioChunk => ({
  utteranceId: utt,
  lang: "en",
  format: "pcm16",
  sampleRate: 24000,
  seq,
  last,
  data: bytesToBase64(int16ToBytesLE(new Int16Array(samples))),
});

const mp3 = (utt: string, seq: number, last: boolean, bytes: number[], segLast = false): AudioChunk => ({
  utteranceId: utt,
  lang: "en",
  format: "mp3",
  sampleRate: 24000,
  seq,
  segLast,
  last,
  data: bytes.length ? bytesToBase64(Uint8Array.from(bytes)) : "",
});

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("PlaybackQueue", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }));
  afterEach(() => vi.useRealTimers());

  it("pcm 边收边播；最后一包后读空才结束，并驱动播放状态", () => {
    const { sink, log } = fakeSink();
    const q = new PlaybackQueue(sink);
    const states: boolean[] = [];
    q.onPlayingChange((p) => states.push(p));
    q.enqueue(pcm("p1:1", 1, false));
    expect(log).toEqual(["pcm:240@24000"]);
    expect(q.isPlaying).toBe(true);
    // 中途读空（网络抖动）不结束
    q.notifyPcmDrained();
    expect(q.isPlaying).toBe(true);
    q.enqueue(pcm("p1:1", 2, true));
    q.notifyPcmDrained();
    expect(q.isPlaying).toBe(false);
    expect(states).toEqual([true, false]);
  });

  it("句与句串行：第二句的包在第一句结束前只缓存", () => {
    const { sink, log } = fakeSink();
    const q = new PlaybackQueue(sink);
    q.enqueue(pcm("p1:1", 1, true));
    q.enqueue(pcm("p1:2", 1, false, 100));
    q.enqueue(pcm("p1:2", 2, true, 100));
    expect(log).toEqual(["pcm:240@24000"]);
    expect(q.currentUtterance).toBe("p1:1");
    q.notifyPcmDrained();
    expect(q.currentUtterance).toBe("p1:2");
    expect(log).toEqual(["pcm:240@24000", "pcm:100@24000", "pcm:100@24000"]);
  });

  it("mp3 首包到达即开始播放（不等整句 last），段尾与终止包依次传给编码流", async () => {
    const { sink, log, streams } = fakeSink();
    const q = new PlaybackQueue(sink);
    q.enqueue(mp3("p1:1", 0, false, [1, 2, 3]));
    expect(log).toEqual(["mp3:open", "mp3+3"]);
    expect(q.isPlaying).toBe(true);
    q.enqueue(mp3("p1:1", 1, false, [4, 5], true));
    q.enqueue(mp3("p1:1", 2, false, [6]));
    q.enqueue(mp3("p1:1", 3, true, [])); // 终止包
    expect(log).toEqual(["mp3:open", "mp3+3", "mp3+2|seg", "mp3+1", "mp3:end"]);
    streams[0].finish();
    await flush();
    expect(q.isPlaying).toBe(false);
  });

  it("mp3 旧协议：last 落在数据包上，同样结束编码流", async () => {
    const { sink, log, streams } = fakeSink();
    const q = new PlaybackQueue(sink);
    q.enqueue(mp3("p1:1", 0, false, [1, 2]));
    q.enqueue(mp3("p1:1", 1, true, [3]));
    expect(log).toEqual(["mp3:open", "mp3+2", "mp3+1", "mp3:end"]);
    streams[0].finish();
    await flush();
    expect(q.isPlaying).toBe(false);
  });

  it("第二句的 mp3 在第一句播完前只缓存，轮到时一次性追加", async () => {
    const { sink, log, streams } = fakeSink();
    const q = new PlaybackQueue(sink);
    q.enqueue(mp3("p1:1", 0, false, [1]));
    q.enqueue(mp3("p1:2", 0, false, [2, 2], true));
    q.enqueue(mp3("p1:2", 1, true, []));
    expect(log).toEqual(["mp3:open", "mp3+1"]);
    q.enqueue(mp3("p1:1", 1, true, []));
    streams[0].finish();
    await flush();
    expect(log.slice(-3)).toEqual(["mp3:open", "mp3+2|seg", "mp3:end"]);
    expect(q.currentUtterance).toBe("p1:2");
  });

  it("只有终止包、没有任何音频时不排队", () => {
    const { sink } = fakeSink();
    const q = new PlaybackQueue(sink);
    q.enqueue(mp3("p1:1", 0, true, []));
    q.enqueue(pcm("p1:2", 0, true, 0));
    expect(q.size).toBe(0);
  });

  it("pause 暂停当前句与后续句，resume 后继续", async () => {
    const { sink, log, streams } = fakeSink();
    const q = new PlaybackQueue(sink);
    q.enqueue(mp3("p1:1", 0, true, [1]));
    q.pause();
    expect(log).toContain("mp3:pause");
    expect(log).toContain("pause");
    q.enqueue(mp3("p1:2", 0, true, [2]));
    streams[0].finish();
    await flush();
    expect(q.currentUtterance).toBeNull(); // 暂停期间不开始下一句
    expect(q.isPlaying).toBe(true);
    q.resume();
    expect(log).toContain("resume");
    expect(q.currentUtterance).toBe("p1:2");
  });

  it("onCurrentChange：开始播报新句、播完与停止时通知当前句（气泡声波）", () => {
    const { sink } = fakeSink();
    const q = new PlaybackQueue(sink);
    const seen: (string | null)[] = [];
    q.onCurrentChange((id) => seen.push(id));
    q.enqueue(pcm("p1:1", 1, true));
    q.enqueue(pcm("p1:2", 1, true));
    q.notifyPcmDrained();
    q.stop();
    expect(seen).toEqual(["p1:1", null, "p1:2", null]);
  });

  it("stop 会停止正在播放的编码流", () => {
    const { sink, log } = fakeSink();
    const q = new PlaybackQueue(sink);
    q.enqueue(mp3("p1:1", 0, false, [1]));
    q.stop();
    expect(log).toContain("mp3:stop");
    expect(q.isPlaying).toBe(false);
  });

  it("浏览器朗读兜底：同句已有服务端音频时忽略；服务端音频后到时替换未开始的朗读", async () => {
    const { sink, log, pending } = fakeSink();
    const q = new PlaybackQueue(sink);
    q.enqueue(pcm("p1:1", 1, true));
    q.enqueueSpeech("p1:1", "Hello", "en");
    q.enqueueSpeech("p1:2", "World", "en");
    expect(q.size).toBe(2);
    q.enqueue(pcm("p1:2", 1, true, 10));
    expect(q.size).toBe(2);
    q.notifyPcmDrained();
    expect(log.at(-1)).toBe("pcm:10@24000");
    q.notifyPcmDrained();
    q.enqueueSpeech("p1:3", "Bye", "en");
    expect(log.at(-1)).toBe("speak:en:Bye");
    pending[0].resolve();
    await flush();
    expect(q.isPlaying).toBe(false);
  });

  it("关闭播报时丢弃新包并停止当前播放", () => {
    const { sink, log } = fakeSink();
    const q = new PlaybackQueue(sink);
    q.enqueue(pcm("p1:1", 1, false));
    q.setEnabled(false);
    expect(log).toContain("clear");
    expect(log).toContain("stopAll");
    expect(q.isPlaying).toBe(false);
    q.enqueue(pcm("p1:2", 1, true));
    expect(q.size).toBe(0);
  });

  it("缓冲始终未回报读空时，按时长 + 余量强制结束（保护超时）", () => {
    const { sink } = fakeSink();
    const q = new PlaybackQueue(sink);
    q.enqueue(pcm("p1:1", 1, true, 24000)); // 1 s
    vi.advanceTimersByTime(2000);
    expect(q.isPlaying).toBe(true);
    vi.advanceTimersByTime(600);
    expect(q.isPlaying).toBe(false);
  });

  it("stop 后旧的朗读完成回调不影响新句", async () => {
    const { sink, pending } = fakeSink();
    const q = new PlaybackQueue(sink);
    q.enqueueSpeech("p1:1", "a", "en");
    q.stop();
    q.enqueueSpeech("p1:2", "b", "en");
    pending[0].resolve();
    await flush();
    expect(q.currentUtterance).toBe("p1:2");
  });
});

describe("HalfDuplexGate", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("播报期间关闭，结束 300 ms 后恢复", () => {
    const changes: boolean[] = [];
    const g = new HalfDuplexGate(true, (c) => changes.push(c));
    g.setPlaying(true);
    expect(g.isClosed).toBe(true);
    g.setPlaying(false);
    vi.advanceTimersByTime(RESUME_DELAY_MS - 1);
    expect(g.isClosed).toBe(true);
    vi.advanceTimersByTime(1);
    expect(g.isClosed).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it("300 ms 内再次播报则保持关闭", () => {
    const g = new HalfDuplexGate(true);
    g.setPlaying(true);
    g.setPlaying(false);
    vi.advanceTimersByTime(200);
    g.setPlaying(true);
    vi.advanceTimersByTime(500);
    expect(g.isClosed).toBe(true);
  });

  it("耳机模式（禁用）时不关闭；播报中禁用立即打开", () => {
    const g = new HalfDuplexGate(false);
    g.setPlaying(true);
    expect(g.isClosed).toBe(false);
    g.setEnabled(true);
    expect(g.isClosed).toBe(true);
    g.setEnabled(false);
    expect(g.isClosed).toBe(false);
  });
});

describe("PlaybackQueue 开播门与让位（improve-speech-endpointing-and-live-ux 5.1）", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }));
  afterEach(() => vi.useRealTimers());

  it("用户在说话时推迟开播；门打开后在下一次复查时开播", () => {
    const { sink, log } = fakeSink();
    const q = new PlaybackQueue(sink);
    let speaking = true;
    q.setStartGate(() => !speaking);
    q.enqueue(pcm("p1:1", 1, true));
    expect(log).toEqual([]);
    expect(q.isPlaying).toBe(false);
    expect(q.deferred).toBe(true);
    vi.advanceTimersByTime(500);
    expect(log).toEqual([]);
    speaking = false;
    vi.advanceTimersByTime(100);
    expect(log).toEqual(["pcm:240@24000"]);
    expect(q.isPlaying).toBe(true);
  });

  it("recheck 立即开播", () => {
    const { sink, log } = fakeSink();
    const q = new PlaybackQueue(sink);
    let open = false;
    q.setStartGate(() => open);
    q.enqueue(pcm("p1:1", 1, true));
    open = true;
    q.recheck();
    expect(log).toEqual(["pcm:240@24000"]);
  });

  it("推迟最多 4 秒（从首包到达算起），之后照常开播", () => {
    const { sink, log } = fakeSink();
    const q = new PlaybackQueue(sink);
    q.setStartGate(() => false);
    q.enqueue(pcm("p1:1", 1, true));
    vi.advanceTimersByTime(3900);
    expect(log).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(log).toEqual(["pcm:240@24000"]);
  });

  it("已开始的句子不受开播门影响（同句后续分包照常推入）", () => {
    const { sink, log } = fakeSink();
    const q = new PlaybackQueue(sink);
    let open = true;
    q.setStartGate(() => open);
    q.enqueue(pcm("p1:1", 1, false));
    open = false;
    q.enqueue(pcm("p1:1", 2, true, 100));
    expect(log).toEqual(["pcm:240@24000", "pcm:100@24000"]);
  });

  it("drop 丢弃尚未开播的句子；已开播的不处理", () => {
    const { sink, log } = fakeSink();
    const q = new PlaybackQueue(sink);
    q.setStartGate(() => false);
    q.enqueue(pcm("p1:2", 1, true));
    expect(q.hasStarted("p1:2")).toBe(false);
    expect(q.drop("p1:2")).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(log).toEqual([]);
    q.setStartGate(null);
    q.enqueue(pcm("p1:3", 1, true));
    expect(q.hasStarted("p1:3")).toBe(true);
    expect(q.drop("p1:3")).toBe(false);
  });
});
