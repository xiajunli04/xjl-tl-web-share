import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/http";
import { InterpretConnection, type ConnectionStatus, type WebSocketLike } from "../connection";
import type { ServerEvent } from "../protocol";

/** 模拟 WebSocket：由测试手动触发 open / message / close */
class FakeSocket implements WebSocketLike {
  static all: FakeSocket[] = [];
  binaryType: BinaryType = "blob";
  readyState = 0;
  bufferedAmount = 0;
  sent: unknown[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }
  message(e: object) {
    this.onmessage?.({ data: JSON.stringify(e) } as MessageEvent);
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
}

function setup(renew: () => Promise<string> = async () => `t${FakeSocket.all.length + 1}`) {
  const events: ServerEvent[] = [];
  const statuses: { s: ConnectionStatus; attempt: number }[] = [];
  const renewTicket = vi.fn(renew);
  const conn = new InterpretConnection({
    createSocket: (url) => new FakeSocket(url),
    buildUrl: (t) => `ws://api/ws/interpret?ticket=${t}`,
    renewTicket,
    onEvent: (e) => events.push(e),
    onStatus: (s, i) => statuses.push({ s, attempt: i.attempt }),
  });
  return { conn, events, statuses, renewTicket };
}

const last = () => FakeSocket.all.at(-1)!;

describe("InterpretConnection", () => {
  beforeEach(() => {
    FakeSocket.all = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("连接、分发事件、发送控制帧与音频帧", () => {
    const { conn, events } = setup();
    conn.connect("t0");
    expect(last().url).toBe("ws://api/ws/interpret?ticket=t0");
    expect(last().binaryType).toBe("arraybuffer");
    // 未打开时不发送
    expect(conn.send({ type: "flush" })).toBe(false);
    last().open();
    last().message({ type: "transcript.partial", utteranceId: "p1:1", text: "hi" });
    last().message({ type: "bogus" });
    expect(events).toHaveLength(1);
    expect(conn.send({ type: "ptt", side: "A" })).toBe(true);
    expect(last().sent[0]).toBe('{"type":"ptt","side":"A"}');
    const frame = new Int16Array(640);
    expect(conn.sendAudio(frame)).toBe(true);
    expect((last().sent[1] as ArrayBuffer).byteLength).toBe(1280);
  });

  it("上行积压过多时丢弃音频帧", () => {
    const { conn } = setup();
    conn.connect("t0");
    last().open();
    last().bufferedAmount = 10 * 1024 * 1024;
    expect(conn.sendAudio(new Int16Array(640))).toBe(false);
  });

  it("每 20 s 发送 ping", () => {
    const { conn } = setup();
    conn.connect("t0");
    last().open();
    vi.advanceTimersByTime(20_000);
    expect(last().sent).toContain('{"type":"ping"}');
  });

  it("意外断开后按 1 s / 2 s / 4 s 指数退避重连，每次重新取票据；成功后计数清零", async () => {
    const { conn, statuses, renewTicket } = setup();
    conn.connect("t0");
    last().open();
    last().drop();
    expect(conn.currentStatus).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(999);
    expect(renewTicket).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(renewTicket).toHaveBeenCalledTimes(1);
    expect(FakeSocket.all).toHaveLength(2);
    // 第二次失败：2 s 后再试
    last().drop();
    await vi.advanceTimersByTimeAsync(1999);
    expect(FakeSocket.all).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.all).toHaveLength(3);
    last().open();
    expect(conn.currentStatus).toBe("open");
    // 清零后再断：重新从 1 s 开始
    last().drop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.all).toHaveLength(4);
    expect(statuses.map((x) => x.s)).toEqual(["connecting", "open", "reconnecting", "reconnecting", "reconnecting", "reconnecting", "open", "reconnecting", "reconnecting"]);
  });

  it("最多重连 3 次，之后状态为 failed", async () => {
    const { conn } = setup();
    conn.connect("t0");
    last().drop();
    for (const ms of [1000, 2000, 4000]) {
      await vi.advanceTimersByTimeAsync(ms);
      last().drop();
    }
    expect(FakeSocket.all).toHaveLength(4);
    expect(conn.currentStatus).toBe("failed");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeSocket.all).toHaveLength(4);
  });

  it("取票据返回房间已关闭（A0452）时直接放弃", async () => {
    const { conn } = setup(async () => {
      throw new ApiError("A0452", "房间不存在或已关闭");
    });
    conn.connect("t0");
    last().open();
    last().drop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(conn.currentStatus).toBe("failed");
  });

  it("取票据网络失败计入重试次数", async () => {
    let n = 0;
    const { conn } = setup(async () => {
      n++;
      throw new ApiError("B0001", "网络异常");
    });
    conn.connect("t0");
    last().drop();
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000);
    expect(n).toBe(3);
    expect(conn.currentStatus).toBe("failed");
  });

  it("收到 ended 或致命错误后断开不重连", async () => {
    const a = setup();
    a.conn.connect("t0");
    last().open();
    last().message({ type: "ended", reason: "host_left" });
    last().drop(1000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(a.conn.currentStatus).toBe("closed");

    const b = setup();
    b.conn.connect("t0");
    last().open();
    last().message({ type: "error", code: "A0212", message: "并发超限", fatal: true });
    last().drop(1011);
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it("主动关闭不重连，且忽略旧连接的回调", async () => {
    const { conn, events } = setup();
    conn.connect("t0");
    const s = last();
    s.open();
    conn.close();
    expect(conn.currentStatus).toBe("closed");
    s.message({ type: "pong" });
    s.drop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(events).toHaveLength(0);
    expect(FakeSocket.all).toHaveLength(1);
  });
});
