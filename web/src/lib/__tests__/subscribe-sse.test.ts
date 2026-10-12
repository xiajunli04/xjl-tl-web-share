import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backoffDelay, isFatalSseError, subscribeSse, type SseMessage } from "@/lib/sse";
import { ApiError } from "@/lib/http";
import { toDocEvent } from "@/lib/api/documents";
import { useAuthStore } from "@/stores/auth";
import { fullRunEvents, toBrowserEvents, toSseText } from "./doc-helpers";
import { sseResponse } from "./helpers";

const instant = () => Promise.resolve();

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** 一个永不结束的事件流（只发出给定文本） */
function hangingResponse(text: string) {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes);
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

const { events: BROWSER_EVENTS } = toBrowserEvents(fullRunEvents());
const FULL_TEXT = toSseText(BROWSER_EVENTS);

describe("subscribeSse · GET 订阅", () => {
  beforeEach(() => useAuthStore.setState({ accessToken: "tok-1", refreshToken: "r-1" }));
  afterEach(() => vi.unstubAllGlobals());

  it("以 GET 携带 Bearer 与 Accept 请求，解析由契约样例转换而来的完整事件序列", async () => {
    const fetchMock = vi.fn(async () => sseResponse(FULL_TEXT, 29));
    vi.stubGlobal("fetch", fetchMock);
    const msgs: SseMessage[] = [];
    await subscribeSse("/api/doc-tasks/42/events", {
      onMessage: (m) => msgs.push(m),
      isDone: () => msgs.some((m) => m.event === "completed"),
      sleep: instant,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/doc-tasks\/42\/events$/);
    expect(init.method).toBe("GET");
    expect(init.headers).toMatchObject({ Accept: "text/event-stream", Authorization: "Bearer tok-1" });
    const events = msgs.map(toDocEvent);
    expect(events.every((e) => e !== null)).toBe(true);
    expect(msgs.map((m) => m.event)).toEqual(BROWSER_EVENTS.map((e) => e.event));
    expect(msgs[0].event).toBe("snapshot");
    expect(msgs.at(-1)?.event).toBe("completed");
  });

  it("连接在终结前被服务端关闭：退避后重连，onOpen 依次为 0、1，直到 isDone", async () => {
    const half = Math.floor(BROWSER_EVENTS.length / 2);
    const first = toSseText(BROWSER_EVENTS.slice(0, half));
    const second = toSseText([BROWSER_EVENTS[0], ...BROWSER_EVENTS.slice(half)]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sseResponse(first))
      .mockResolvedValueOnce(sseResponse(second));
    vi.stubGlobal("fetch", fetchMock);
    const opens: number[] = [];
    const retries: number[] = [];
    const sleeps: number[] = [];
    const seen: string[] = [];
    await subscribeSse("/api/doc-tasks/42/events", {
      onMessage: (m) => seen.push(m.event),
      onOpen: ({ attempt }) => opens.push(attempt),
      onRetry: ({ attempt }) => retries.push(attempt),
      isDone: () => seen.includes("completed"),
      retry: { baseMs: 500, jitter: false },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(opens).toEqual([0, 1]);
    expect(retries).toEqual([1]);
    expect(sleeps).toEqual([500]);
    // 重连后服务端重新发送 snapshot
    expect(seen.filter((e) => e === "snapshot")).toHaveLength(2);
  });

  it("网络错误按指数退避重连（1×、2×、4×），成功收到消息后计数归零", async () => {
    const fail = () => Promise.reject(new TypeError("Failed to fetch"));
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(fail)
      .mockImplementationOnce(fail)
      .mockImplementationOnce(fail)
      .mockResolvedValueOnce(sseResponse(toSseText(BROWSER_EVENTS.slice(0, 2))))
      .mockImplementationOnce(fail)
      .mockResolvedValueOnce(sseResponse(FULL_TEXT));
    vi.stubGlobal("fetch", fetchMock);
    const sleeps: number[] = [];
    const seen: string[] = [];
    await subscribeSse("/x", {
      onMessage: (m) => seen.push(m.event),
      isDone: () => seen.includes("completed"),
      retry: { baseMs: 100, maxMs: 10_000, jitter: false },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    // 第 4 次连接收到消息后断开：计数归零，从 1× 重新开始；随后网络错误再退避到 2×
    expect(sleeps).toEqual([100, 200, 400, 100, 200]);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("A0404（任务不存在）等 4xx 不重连，直接抛出", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(404, { code: "A0404", message: "资源不存在", data: null, traceId: "t-404" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const err = await subscribeSse("/x", { onMessage: () => {}, sleep: instant }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: "A0404", httpStatus: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("5xx 与 429 视为可恢复；maxAttempts 用尽后抛出最后一次错误", async () => {
    expect(isFatalSseError(new ApiError("C0150", "x", undefined, 502))).toBe(false);
    expect(isFatalSseError(new ApiError("A0213", "x", undefined, 429))).toBe(false);
    expect(isFatalSseError(new ApiError("A0431", "x", undefined, 409))).toBe(true);
    const fetchMock = vi.fn(async () => jsonResponse(502, { code: "B0001", message: "bad gateway", data: null }));
    vi.stubGlobal("fetch", fetchMock);
    const err = await subscribeSse("/x", {
      onMessage: () => {},
      retry: { maxAttempts: 2 },
      sleep: instant,
    }).catch((e) => e);
    expect(err).toMatchObject({ code: "B0001", httpStatus: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("A0230 令牌过期：刷新后用新令牌重试一次", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/api/auth/refresh")) {
        return jsonResponse(200, {
          code: "00000",
          message: "ok",
          data: { accessToken: "tok-2", refreshToken: "r-2", expiresIn: 7200, user: null },
        });
      }
      const auth = (init.headers as Record<string, string>).Authorization;
      if (auth === "Bearer tok-1") return jsonResponse(401, { code: "A0230", message: "访问令牌已过期", data: null });
      return sseResponse(FULL_TEXT);
    });
    vi.stubGlobal("fetch", fetchMock);
    const seen: string[] = [];
    await subscribeSse("/api/doc-tasks/42/events", {
      onMessage: (m) => seen.push(m.event),
      isDone: () => seen.includes("completed"),
      sleep: instant,
    });
    const auths = fetchMock.mock.calls
      .filter(([u]) => !String(u).endsWith("/refresh"))
      .map(([, i]) => (i.headers as Record<string, string>).Authorization);
    expect(auths).toEqual(["Bearer tok-1", "Bearer tok-2"]);
    expect(seen.at(-1)).toBe("completed");
  });

  it("AbortSignal 中断：以 AbortError 结束且不再重连", async () => {
    const fetchMock = vi.fn(async () => hangingResponse(toSseText(BROWSER_EVENTS.slice(0, 1))));
    vi.stubGlobal("fetch", fetchMock);
    const ctrl = new AbortController();
    const p = subscribeSse("/x", {
      signal: ctrl.signal,
      onMessage: () => ctrl.abort(),
      sleep: instant,
      idleTimeoutMs: 0,
    });
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("超过空闲时长没有任何字节（含心跳）：主动断开并重连", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(hangingResponse(toSseText(BROWSER_EVENTS.slice(0, 1))))
      .mockResolvedValueOnce(sseResponse(FULL_TEXT));
    vi.stubGlobal("fetch", fetchMock);
    const seen: string[] = [];
    const errors: unknown[] = [];
    await subscribeSse("/x", {
      onMessage: (m) => seen.push(m.event),
      onRetry: ({ error }) => errors.push(error),
      isDone: () => seen.includes("completed"),
      idleTimeoutMs: 30,
      sleep: instant,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(errors[0]).toMatchObject({ name: "IdleTimeoutError" });
  });

  it("backoffDelay：指数增长、封顶、抖动范围 ±20%", () => {
    const p = { baseMs: 1000, maxMs: 8000, jitter: false };
    expect([1, 2, 3, 4, 5, 6].map((a) => backoffDelay(a, p))).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
    expect(backoffDelay(1, { baseMs: 1000 }, () => 0)).toBe(800);
    expect(backoffDelay(1, { baseMs: 1000 }, () => 0.999999)).toBe(1200);
  });
});
