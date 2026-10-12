import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioMeta } from "../queue";

const h = vi.hoisted(() => ({
  ttsStream: vi.fn(),
  browserOk: true,
  toast: { info: vi.fn(), error: vi.fn(), warning: vi.fn() },
  log: [] as string[],
  streams: [] as { finish: () => void }[],
  speeches: [] as (() => void)[],
}));

vi.mock("sonner", () => ({ toast: h.toast }));
vi.mock("@/lib/api/speech", () => ({ speechApi: { ttsStream: h.ttsStream } }));
vi.mock("../player", async () => {
  const { PlaybackQueue } = await import("../queue");
  class FakePlayer {
    queue = new PlaybackQueue({
      pushPcm: (s) => h.log.push(`pcm:${s.length}`),
      clearPcm: () => undefined,
      openEncoded: () => {
        let resolve!: () => void;
        const done = new Promise<void>((r) => (resolve = r));
        h.streams.push({ finish: () => resolve() });
        return {
          append: (b: Uint8Array) => h.log.push(`mp3+${b.length}`),
          end: () => h.log.push("mp3:end"),
          stop: () => resolve(),
          pause: () => undefined,
          resume: () => undefined,
          done,
        };
      },
      speak: (text: string) =>
        new Promise<void>((r) => {
          h.log.push(`speak:${text}`);
          h.speeches.push(r);
        }),
      stopAll: () => undefined,
    });
    unlock = () => Promise.resolve();
    getOutputAnalyser = () => null;
    setGender = () => undefined;
    enqueueBytes = (meta: AudioMeta, bytes: Uint8Array, flags: { segLast?: boolean; last: boolean }) =>
      this.queue.enqueueBytes(meta, bytes, flags);
    speakFallback = (id: string, text: string, lang: string) => this.queue.enqueueSpeech(id, text, lang);
    stop = () => this.queue.stop();
  }
  return { AudioPlayer: FakePlayer, browserSpeechSupported: () => h.browserOk };
});

import { getSpeakState, speak, stopSpeaking } from "../speak";

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

/** 可控的响应流：push 分块、close 结束 */
function controlledStream() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start: (c) => void (ctrl = c) });
  return { stream, push: (b: number[]) => ctrl.enqueue(Uint8Array.from(b)), close: () => ctrl.close(), error: (e: Error) => ctrl.error(e) };
}

describe("speak 朗读控制器", () => {
  beforeEach(() => {
    h.log.length = 0;
    h.streams.length = 0;
    h.speeches.length = 0;
    h.browserOk = true;
    h.ttsStream.mockReset();
    Object.values(h.toast).forEach((f) => f.mockReset());
  });
  afterEach(() => stopSpeaking());

  it("loading → 首包到达即 playing（边收边播）→ 播完 idle，并回调 onEnd", async () => {
    const s = controlledStream();
    h.ttsStream.mockResolvedValue({ stream: s.stream, headers: new Headers({ "Content-Type": "audio/mpeg" }) });
    const onEnd = vi.fn();
    const ended = speak({ id: "target", text: "Hello", lang: "en", gender: "male", rate: 1.2 }, onEnd);
    expect(getSpeakState()).toEqual({ id: "target", phase: "loading" });
    expect(h.ttsStream.mock.calls[0][0]).toEqual({ text: "Hello", lang: "en", gender: "male", rate: 1.2 });
    s.push([1, 2, 3]);
    await flush();
    expect(getSpeakState().phase).toBe("playing");
    expect(h.log).toEqual(["mp3+3"]); // 首包已交给播放器
    s.push([4]);
    s.close();
    await flush();
    expect(h.log).toEqual(["mp3+3", "mp3+1", "mp3:end"]);
    h.streams[0].finish();
    await ended;
    expect(getSpeakState()).toEqual({ id: null, phase: "idle" });
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it("首包前失败：改用浏览器朗读并提示", async () => {
    h.ttsStream.mockRejectedValue(new Error("C0172"));
    const ended = speak({ id: "t", text: "Hi", lang: "en" });
    await flush();
    expect(h.toast.info).toHaveBeenCalledWith("已改用浏览器朗读");
    expect(h.log).toEqual(["speak:Hi"]);
    expect(getSpeakState().phase).toBe("playing");
    h.speeches[0]();
    await ended;
    expect(getSpeakState().phase).toBe("idle");
  });

  it("浏览器也不支持朗读时报错并回到 idle", async () => {
    h.browserOk = false;
    h.ttsStream.mockRejectedValue(new Error("C0173"));
    await speak({ id: "t", text: "Hi", lang: "en" });
    expect(h.toast.error).toHaveBeenCalled();
    expect(getSpeakState().phase).toBe("idle");
  });

  it("开始新的朗读会停止当前朗读", async () => {
    const a = controlledStream();
    const b = controlledStream();
    h.ttsStream
      .mockResolvedValueOnce({ stream: a.stream, headers: new Headers({ "Content-Type": "audio/mpeg" }) })
      .mockResolvedValueOnce({ stream: b.stream, headers: new Headers({ "Content-Type": "audio/mpeg" }) });
    const first = speak({ id: "source", text: "a", lang: "en" });
    a.push([1]);
    await flush();
    speak({ id: "target", text: "b", lang: "en" });
    await first; // 被停止的朗读立即结束
    expect(getSpeakState()).toEqual({ id: "target", phase: "loading" });
  });

  it("pcm16：跨分块的半个采样被拼接，按完整采样推入", async () => {
    const s = controlledStream();
    h.ttsStream.mockResolvedValue({ stream: s.stream, headers: new Headers({ "Content-Type": "audio/L16;rate=24000" }) });
    speak({ id: "t", text: "x", lang: "en" });
    s.push([1, 0, 2]);
    s.push([0]);
    await flush();
    expect(h.log).toEqual(["pcm:1", "pcm:1"]);
  });

  it("超长文本截断到 2000 字并提示", async () => {
    h.ttsStream.mockReturnValue(new Promise(() => undefined));
    speak({ id: "t", text: "字".repeat(2100), lang: "zh" });
    expect(h.ttsStream.mock.calls[0][0].text).toHaveLength(2000);
    expect(h.toast.info).toHaveBeenCalledWith("仅朗读前 2000 个字符");
  });
});
