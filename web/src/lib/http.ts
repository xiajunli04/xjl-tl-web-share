import { useAuthStore } from "@/stores/auth";
import type { LoginResult, Result } from "@/lib/api/types";

export const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_BASE_URL || ""
).replace(/\/+$/, "");

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public traceId?: string,
    public httpStatus?: number,
    public data?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Query;
  body?: unknown;
  /** multipart 表单（与 body 互斥） */
  form?: FormData;
  /** 不附带令牌、不参与刷新（登录 / 注册 / 刷新） */
  anonymous?: boolean;
}

export function buildUrl(path: string, query?: Query) {
  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
  const url = new URL(API_BASE_URL + path, origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/** 当前访问令牌对应的 Authorization 头 */
export function authHeader(): Record<string, string> {
  const token = useAuthStore.getState().accessToken;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * 把非 2xx / 非 00000 的响应解析为 ApiError。
 * 响应体不是统一 Result 结构时，返回 B0001 并带上响应头中的 traceId。
 */
export async function toApiError(res: Response): Promise<ApiError> {
  let payload: Result<unknown> | null = null;
  try {
    payload = (await res.json()) as Result<unknown>;
  } catch {
    payload = null;
  }
  if (!payload || typeof payload.code !== "string") {
    return new ApiError(
      "B0001",
      `服务响应异常（HTTP ${res.status}）`,
      res.headers.get("X-Trace-Id") ?? undefined,
      res.status,
    );
  }
  return new ApiError(
    payload.code,
    payload.message,
    payload.traceId ?? res.headers.get("X-Trace-Id") ?? undefined,
    res.status,
    payload.data,
  );
}

async function rawRequest<T>(path: string, opts: RequestOptions): Promise<T> {
  // 开发 mock 开关就地展开，生产构建中整段被移除（见 lib/mock/flags.ts）
  if (process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_MOCK_API === "1") {
    const { mockRequest } = await import("@/lib/mock/api");
    return mockRequest<T>(path, opts);
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (!opts.anonymous) Object.assign(headers, authHeader());
  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method: opts.method ?? "GET",
      headers,
      body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    });
  } catch {
    throw new ApiError("B0001", "网络异常，无法连接服务器");
  }
  let payload: Result<T> | null = null;
  try {
    payload = (await res.json()) as Result<T>;
  } catch {
    payload = null;
  }
  if (!payload || typeof payload.code !== "string") {
    throw new ApiError(
      "B0001",
      `服务响应异常（HTTP ${res.status}）`,
      res.headers.get("X-Trace-Id") ?? undefined,
      res.status,
    );
  }
  if (payload.code !== "00000") {
    throw new ApiError(payload.code, payload.message, payload.traceId, res.status, payload.data);
  }
  return payload.data;
}

let refreshPromise: Promise<void> | null = null;

/** 刷新令牌（single-flight：并发请求共享同一次刷新） */
export function refreshSession(): Promise<void> {
  if (!refreshPromise) {
    const refreshToken = useAuthStore.getState().refreshToken;
    refreshPromise = (async () => {
      if (!refreshToken) throw new ApiError("A0232", "刷新令牌无效或已过期");
      const r = await rawRequest<LoginResult>("/api/auth/refresh", {
        method: "POST",
        body: { refreshToken },
        anonymous: true,
      });
      useAuthStore.getState().setSession(r);
    })().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

/** 解析 JWT 的 exp（秒）；无法解析时返回 null */
export function tokenExpiresAt(token: string | null | undefined): number | null {
  if (!token) return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === "number" ? exp : null;
  } catch {
    return null;
  }
}

/**
 * 访问令牌已过期或将在 skewSeconds 内过期时先刷新（用于 SSE 等无法透明重试的长连接）。
 * 刷新失败会清空会话并跳转登录。
 */
export async function ensureFreshToken(skewSeconds = 30): Promise<void> {
  const exp = tokenExpiresAt(useAuthStore.getState().accessToken);
  if (exp === null || exp - Date.now() / 1000 > skewSeconds) return;
  try {
    await refreshSession();
  } catch (e) {
    logoutLocally();
    throw e;
  }
}

/** 清空会话并跳转登录页（带 redirect） */
export function logoutLocally() {
  useAuthStore.getState().clear();
  if (typeof window !== "undefined") {
    const { pathname, search } = window.location;
    if (!pathname.startsWith("/login")) {
      window.location.replace(`/login?redirect=${encodeURIComponent(pathname + search)}`);
    }
  }
}

/** 令牌失效类错误的统一处理：A0230 刷新后重试一次，A0231/A0232 退出登录 */
export async function withAuthRetry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    if (e.code === "A0230") {
      try {
        await refreshSession();
      } catch (re) {
        logoutLocally();
        throw re;
      }
      return run();
    }
    if (e.code === "A0231" || e.code === "A0232") logoutLocally();
    throw e;
  }
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  if (opts.anonymous) return rawRequest<T>(path, opts);
  return withAuthRetry(() => rawRequest<T>(path, opts));
}

/**
 * POST JSON 并以二进制接收响应（附带令牌，A0230 自动刷新重试）；用于语音合成等返回音频的接口。
 * 失败时响应体为统一 Result JSON，解析为 ApiError。
 */
export async function postBlob(path: string, body: unknown): Promise<{ blob: Blob; headers: Headers }> {
  if (process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_MOCK_API === "1") {
    const { mockRequest } = await import("@/lib/mock/api");
    return mockRequest<{ blob: Blob; headers: Headers }>(path, { method: "POST", body });
  }
  return withAuthRetry(async () => {
    let res: Response;
    try {
      res = await fetch(buildUrl(path), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader() },
        body: JSON.stringify(body),
      });
    } catch {
      throw new ApiError("B0001", "网络异常，无法连接服务器");
    }
    if (!res.ok || (res.headers.get("Content-Type") ?? "").includes("application/json")) throw await toApiError(res);
    return { blob: await res.blob(), headers: res.headers };
  });
}

/**
 * POST JSON 并以流的形式接收二进制响应（附带令牌，A0230 自动刷新重试）；用于流式朗读（improve-speech-playback-latency D2）。
 * 响应头到达即返回，响应体由调用方边读边处理；失败时响应体为统一 Result JSON，解析为 ApiError。
 */
export async function postStream(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<{ stream: ReadableStream<Uint8Array>; headers: Headers }> {
  if (process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_MOCK_API === "1") {
    const { mockRequest } = await import("@/lib/mock/api");
    const { blob, headers } = await mockRequest<{ blob: Blob; headers: Headers }>(path, { method: "POST", body });
    return { stream: blob.stream(), headers };
  }
  return withAuthRetry(async () => {
    let res: Response;
    try {
      res = await fetch(buildUrl(path), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader() },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if ((e as Error)?.name === "AbortError") throw e;
      throw new ApiError("B0001", "网络异常，无法连接服务器");
    }
    if (!res.ok || (res.headers.get("Content-Type") ?? "").includes("application/json")) throw await toApiError(res);
    if (!res.body) throw new ApiError("B0001", "浏览器不支持流式响应");
    return { stream: res.body, headers: res.headers };
  });
}

/** 下载文件（附带令牌）；返回 Blob 与服务端建议的文件名 */
export async function download(
  path: string,
  query?: Query,
): Promise<{ blob: Blob; filename: string | null }> {
  // 开发 mock 开关就地展开，生产构建中整段被移除（见 lib/mock/flags.ts）
  if (process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_MOCK_API === "1") {
    const { mockDownload } = await import("@/lib/mock/api");
    return mockDownload(path, query);
  }
  return withAuthRetry(async () => {
    let res: Response;
    try {
      res = await fetch(buildUrl(path, query), { headers: authHeader() });
    } catch {
      throw new ApiError("B0001", "网络异常，无法连接服务器");
    }
    if (!res.ok) throw await toApiError(res);
    const cd = res.headers.get("Content-Disposition") ?? "";
    const m = /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i.exec(cd);
    const filename = m ? decodeURIComponent(m[1] ?? m[2]) : null;
    return { blob: await res.blob(), filename };
  });
}

export const http = {
  get: <T>(path: string, query?: Query) => request<T>(path, { query }),
  post: <T>(path: string, body?: unknown, anonymous = false) =>
    request<T>(path, { method: "POST", body, anonymous }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: "PUT", body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  upload: <T>(path: string, form: FormData) => request<T>(path, { method: "POST", form }),
  download,
};
