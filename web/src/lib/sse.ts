import { ApiError, authHeader, buildUrl, ensureFreshToken, toApiError, withAuthRetry } from "@/lib/http";

/** 一条已分发的 SSE 消息（data 为多行 data 字段以 \n 拼接后的原文） */
export interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

/**
 * 增量 SSE 解析器（遵循 WHATWG EventSource 解析规则）：
 * - 行结束符支持 \n、\r\n、\r，可跨 chunk
 * - 空行分发事件；data 为空的事件不分发
 * - 以 ":" 开头的行是注释（心跳），忽略
 * - "field: value" 去掉冒号后一个前导空格；多个 data 行以 \n 拼接
 * - 未知字段忽略
 */
export function createSseParser(onMessage: (m: SseMessage) => void) {
  let buffer = "";
  let event = "";
  let data: string[] = [];
  let id: string | undefined;
  let pendingCR = false;

  const dispatch = () => {
    if (data.length) {
      onMessage({ event: event || "message", data: data.join("\n"), id });
    }
    event = "";
    data = [];
  };

  const processLine = (line: string) => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return;
    const idx = line.indexOf(":");
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? "" : line.slice(idx + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        event = value;
        break;
      case "data":
        data.push(value);
        break;
      case "id":
        if (!value.includes("\0")) id = value;
        break;
      default:
        // retry 及未知字段忽略
        break;
    }
  };

  return {
    feed(chunk: string) {
      let text = chunk;
      // 上一个 chunk 以 \r 结尾、本 chunk 以 \n 开头：属于同一个 \r\n
      if (pendingCR && text.startsWith("\n")) text = text.slice(1);
      pendingCR = false;
      buffer += text;
      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        const ch = buffer[i];
        if (ch === "\n" || ch === "\r") {
          processLine(buffer.slice(start, i));
          if (ch === "\r") {
            if (i + 1 < buffer.length) {
              if (buffer[i + 1] === "\n") i++;
            } else {
              pendingCR = true;
            }
          }
          start = i + 1;
        }
      }
      buffer = buffer.slice(start);
    },
    /** 流结束：未以空行收尾的残余事件按规范丢弃 */
    end() {
      buffer = "";
      event = "";
      data = [];
    },
  };
}

/**
 * 读取 ReadableStream 并逐条回调 SSE 消息；signal 中断时以 AbortError 结束。
 * onActivity 在每次收到字节时调用（包括 :ping 心跳），用于空闲超时检测。
 */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onMessage: (m: SseMessage) => void,
  signal?: AbortSignal,
  onActivity?: () => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const parser = createSseParser(onMessage);
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw abortError();
      const { value, done } = await reader.read();
      if (done) break;
      onActivity?.();
      parser.feed(decoder.decode(value, { stream: true }));
    }
    if (signal?.aborted) throw abortError();
    parser.feed(decoder.decode());
    parser.end();
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock?.();
  }
}

export function abortError() {
  return new DOMException("The operation was aborted.", "AbortError");
}

export function isAbortError(e: unknown) {
  return e instanceof DOMException && e.name === "AbortError";
}

/**
 * POST 一个 JSON 请求并以 SSE 读取响应。
 * - 发送前若访问令牌已过期或即将过期，先刷新（复用 http.ts 的 single-flight 刷新）
 * - 流建立前的非 2xx 响应解析为 ApiError；A0230 时刷新后重试一次
 * - 支持 AbortSignal
 */
export async function streamSse(
  path: string,
  body: unknown,
  opts: { signal?: AbortSignal; onMessage: (m: SseMessage) => void },
): Promise<void> {
  await ensureFreshToken();
  const res = await withAuthRetry(async () => {
    let r: Response;
    try {
      r = await fetch(buildUrl(path), {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          "Content-Type": "application/json",
          ...authHeader(),
        },
        body: JSON.stringify(body),
        signal: opts.signal,
        cache: "no-store",
      });
    } catch (e) {
      if (isAbortError(e)) throw e;
      throw new ApiError("B0001", "网络异常，无法连接服务器");
    }
    if (!r.ok) throw await toApiError(r);
    const type = r.headers.get("Content-Type") ?? "";
    if (!type.includes("text/event-stream")) {
      // 2xx 但不是事件流：按统一 Result 结构解析错误
      throw await toApiError(r);
    }
    return r;
  });
  if (!res.body) throw new ApiError("B0001", "服务响应异常（空响应体）");
  await readSseStream(res.body, opts.onMessage, opts.signal);
}

/* ---------------- GET 订阅：断线后指数退避重连 ---------------- */

export interface RetryPolicy {
  /** 首次重连等待（毫秒），默认 1000 */
  baseMs?: number;
  /** 等待上限，默认 30000 */
  maxMs?: number;
  /** 退避倍数，默认 2 */
  factor?: number;
  /** 连续失败多少次后放弃（抛出最后一次错误），默认不限 */
  maxAttempts?: number;
  /** 是否加入 ±20% 抖动，默认 true */
  jitter?: boolean;
}

export interface SubscribeOptions {
  signal?: AbortSignal;
  onMessage: (m: SseMessage) => void;
  /** 连接建立（2xx + text/event-stream）；attempt 为 0 表示首次连接，>0 表示第几次重连成功 */
  onOpen?: (info: { attempt: number }) => void;
  /** 即将在 delayMs 后重连；error 为导致断开的原因（服务端正常关闭时为 undefined） */
  onRetry?: (info: { attempt: number; delayMs: number; error?: unknown }) => void;
  /** 返回 true 表示业务已到终结状态：连接关闭后不再重连，正常返回 */
  isDone?: () => boolean;
  retry?: RetryPolicy;
  /** 超过该时长未收到任何字节（含心跳）视为断线并重连；默认 45000（服务端每 15 秒心跳），0 表示关闭 */
  idleTimeoutMs?: number;
  /** 测试注入：可中断的等待 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 第 attempt 次重连（从 1 开始）的等待时长：base × factor^(attempt-1)，不超过 max，可选 ±20% 抖动 */
export function backoffDelay(attempt: number, policy: RetryPolicy = {}, random = Math.random): number {
  const { baseMs = 1000, maxMs = 30_000, factor = 2, jitter = true } = policy;
  const raw = Math.min(maxMs, baseMs * Math.pow(factor, Math.max(0, attempt - 1)));
  if (!jitter) return raw;
  return Math.round(raw * (0.8 + random() * 0.4));
}

/** 不可通过重连恢复的错误：资源不存在、无权限、参数错误、令牌彻底失效等 4xx（408 / 429 除外） */
export function isFatalSseError(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  if (e.code === "A0231" || e.code === "A0232") return true;
  const s = e.httpStatus;
  return s !== undefined && s >= 400 && s < 500 && s !== 408 && s !== 429;
}

export class IdleTimeoutError extends Error {
  constructor() {
    super("SSE 连接空闲超时");
    this.name = "IdleTimeoutError";
  }
}

async function openGetStream(path: string, signal: AbortSignal): Promise<Response> {
  await ensureFreshToken();
  return withAuthRetry(async () => {
    let r: Response;
    try {
      r = await fetch(buildUrl(path), {
        method: "GET",
        headers: { Accept: "text/event-stream", ...authHeader() },
        signal,
        cache: "no-store",
      });
    } catch (e) {
      if (isAbortError(e)) throw e;
      throw new ApiError("B0001", "网络异常，无法连接服务器");
    }
    if (!r.ok) throw await toApiError(r);
    const type = r.headers.get("Content-Type") ?? "";
    if (!type.includes("text/event-stream")) throw await toApiError(r);
    return r;
  });
}

/**
 * GET 订阅一个 SSE 端点（带 Bearer、令牌刷新、AbortSignal）。
 * - 连接断开（网络错误 / 服务端关闭 / 空闲超时）且 isDone() 不为 true 时，按指数退避重连；
 *   重连前会重新检查令牌是否将过期（ensureFreshToken），A0230 时刷新后重试一次
 * - 收到过消息的连接断开后，退避计数归零
 * - 4xx（408/429 除外）视为不可恢复，直接抛出
 * - 正常结束（isDone() 为 true）时 resolve；signal 中断时以 AbortError reject
 */
export async function subscribeSse(path: string, opts: SubscribeOptions): Promise<void> {
  const sleep = opts.sleep ?? abortableSleep;
  const idleMs = opts.idleTimeoutMs ?? 45_000;
  let attempt = 0;
  let connections = 0;
  for (;;) {
    if (opts.signal?.aborted) throw abortError();
    const conn = new AbortController();
    const onOuterAbort = () => conn.abort();
    opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let idled = false;
    const touch = () => {
      if (!idleMs) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idled = true;
        conn.abort();
      }, idleMs);
    };
    let received = false;
    let error: unknown;
    try {
      const res = await openGetStream(path, conn.signal);
      if (!res.body) throw new ApiError("B0001", "服务响应异常（空响应体）");
      opts.onOpen?.({ attempt: connections });
      connections++;
      touch();
      await readSseStream(
        res.body,
        (m) => {
          received = true;
          opts.onMessage(m);
        },
        conn.signal,
        touch,
      );
    } catch (e) {
      if (opts.signal?.aborted) throw abortError();
      if (isAbortError(e) && idled) error = new IdleTimeoutError();
      else if (isFatalSseError(e)) throw e;
      else error = e;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      opts.signal?.removeEventListener("abort", onOuterAbort);
    }
    if (opts.isDone?.()) return;
    attempt = received ? 1 : attempt + 1;
    const max = opts.retry?.maxAttempts;
    if (max !== undefined && attempt > max) {
      throw error ?? new ApiError("B0001", "连接已断开，重连次数已用尽");
    }
    const delayMs = backoffDelay(attempt, opts.retry);
    opts.onRetry?.({ attempt, delayMs, error });
    await sleep(delayMs, opts.signal);
  }
}
