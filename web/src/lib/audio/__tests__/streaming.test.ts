import { afterEach, describe, expect, it, vi } from "vitest";
import { MseStream, SegmentStream, mseSupported, stripId3 } from "../streaming";

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe("stripId3", () => {
  it("剥离 ID3v2 标签头（synchsafe 长度，含页脚标志）", () => {
    const tag = [0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 3, 9, 9, 9];
    expect(Array.from(stripId3(Uint8Array.from([...tag, 0xff, 0xfb])))).toEqual([0xff, 0xfb]);
    const withFooter = [0x49, 0x44, 0x33, 4, 0, 0x10, 0, 0, 0, 1, 7, ...new Array(10).fill(0), 0xff];
    expect(Array.from(stripId3(Uint8Array.from(withFooter)))).toEqual([0xff]);
    const big = [0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 1, 0]; // 128 字节标签体
    expect(stripId3(Uint8Array.from([...big, ...new Array(128).fill(1), 0xff])).length).toBe(1);
  });

  it("没有 ID3 头时原样返回", () => {
    const frame = Uint8Array.from([0xff, 0xfb, 0x90, 0x64]);
    expect(stripId3(frame)).toBe(frame);
  });
});

// ---------------- 假 MediaSource ----------------

class FakeSourceBuffer extends EventTarget {
  mode = "segments";
  updating = false;
  appended: number[][] = [];
  private end = 0;
  get buffered() {
    const end = this.end;
    return { length: end > 0 ? 1 : 0, start: () => 0, end: () => end };
  }
  appendBuffer(data: Uint8Array) {
    this.updating = true;
    this.appended.push(Array.from(data));
    queueMicrotask(() => {
      this.end += 0.5;
      this.updating = false;
      this.dispatchEvent(new Event("updateend"));
    });
  }
}

class FakeMediaSource extends EventTarget {
  static instances: FakeMediaSource[] = [];
  static isTypeSupported = (t: string) => t === "audio/mpeg";
  readyState = "closed";
  sb: FakeSourceBuffer | null = null;
  endCalls = 0;
  constructor() {
    super();
    FakeMediaSource.instances.push(this);
  }
  addSourceBuffer() {
    this.sb = new FakeSourceBuffer();
    return this.sb;
  }
  endOfStream() {
    this.endCalls++;
    this.readyState = "ended";
  }
  open() {
    this.readyState = "open";
    this.dispatchEvent(new Event("sourceopen"));
  }
}

function fakeAudio() {
  return {
    src: "",
    currentTime: 0,
    plays: 0,
    pauses: 0,
    onended: null as null | (() => void),
    onerror: null as null | (() => void),
    play() {
      this.plays++;
      return Promise.resolve();
    },
    pause() {
      this.pauses++;
    },
    removeAttribute() {
      this.src = "";
    },
    load() {},
  };
}

describe("mseSupported / MseStream", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    FakeMediaSource.instances = [];
  });

  it("没有 MediaSource 时不支持；有且支持 audio/mpeg 时支持；开关可强制关闭", () => {
    expect(mseSupported()).toBe(false);
    vi.stubGlobal("MediaSource", FakeMediaSource);
    expect(mseSupported()).toBe(true);
    vi.stubEnv("NEXT_PUBLIC_AUDIO_MSE", "false");
    expect(mseSupported()).toBe(false);
  });

  it("首个分包追加完成即开始播放，段首剥离 ID3，end 后结束流，ended 后 done", async () => {
    vi.stubGlobal("MediaSource", FakeMediaSource);
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:ms", revokeObjectURL: vi.fn() });
    const el = fakeAudio();
    const s = new MseStream(el as unknown as HTMLAudioElement);
    const ms = FakeMediaSource.instances[0];
    const id3 = [0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 1, 0];
    s.append(Uint8Array.from([...id3, 1, 2]));
    ms.open();
    await flush();
    expect(ms.sb?.mode).toBe("sequence");
    expect(ms.sb?.appended).toEqual([[1, 2]]);
    expect(el.plays).toBe(1); // 首包即播
    s.append(Uint8Array.from([3]), true); // 第 1 段结束
    s.append(Uint8Array.from([...id3, 4])); // 第 2 段：段首的 ID3 被剥离
    s.end();
    await flush();
    expect(ms.sb?.appended).toEqual([[1, 2], [3], [4]]);
    expect(ms.endCalls).toBe(1);
    let done = false;
    void s.done.then(() => (done = true));
    el.onended?.();
    await flush();
    expect(done).toBe(true);
    expect(el.src).toBe("");
  });

  it("stop 立即结束；暂停期间不播放", async () => {
    vi.stubGlobal("MediaSource", FakeMediaSource);
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:ms", revokeObjectURL: vi.fn() });
    const el = fakeAudio();
    const s = new MseStream(el as unknown as HTMLAudioElement);
    s.pause();
    s.append(Uint8Array.from([1]));
    FakeMediaSource.instances[0].open();
    await flush();
    expect(el.plays).toBe(0);
    s.resume();
    expect(el.plays).toBe(1);
    s.stop();
    await expect(s.done).resolves.toBeUndefined();
  });
});

describe("SegmentStream（降级）", () => {
  it("按 segLast 逐段解码播放，段间串行；end 时播放剩余部分（旧协议）", async () => {
    const played: number[][] = [];
    const resolvers: (() => void)[] = [];
    const s = new SegmentStream(
      (bytes) =>
        new Promise<void>((r) => {
          played.push(Array.from(bytes));
          resolvers.push(r);
        }),
    );
    s.append(Uint8Array.from([1]));
    s.append(Uint8Array.from([2]), true);
    await flush();
    expect(played).toEqual([[1, 2]]); // 第 1 段完整后即播放
    s.append(Uint8Array.from([3]));
    s.end();
    await flush();
    expect(played).toEqual([[1, 2]]); // 第 2 段等第 1 段播完
    resolvers[0]();
    await flush();
    expect(played).toEqual([[1, 2], [3]]);
    let done = false;
    void s.done.then(() => (done = true));
    resolvers[1]();
    await flush();
    expect(done).toBe(true);
  });

  it("stop 后不再播放后续段", async () => {
    const play = vi.fn(() => Promise.resolve());
    const stop = vi.fn();
    const s = new SegmentStream(play, { stop });
    s.stop();
    s.append(Uint8Array.from([1]), true);
    await flush();
    expect(play).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
  });
});
