/**
 * 同传 WebSocket 连接控制器（design D15）：
 * - 连接 `ws(s)://…/ws/interpret?ticket=`，解析下行事件
 * - 非主动断开时指数退避重连（1 s / 2 s / 4 s，最多 3 次），每次重连前重新取票据（票据一次性）
 * - 收到 ended 或致命 error 后不再重连
 * - 上行：PCM16 二进制帧与 JSON 控制帧；每 20 s 发送 ping 保活
 * 与 React 无关，便于用模拟 WebSocket 单测。
 */
import { ApiError } from "@/lib/http";
import { parseServerEvent, type ClientControl, type ServerEvent } from "./protocol";

export interface WebSocketLike {
  binaryType: BinaryType;
  readonly readyState: number;
  readonly bufferedAmount: number;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  send: (data: string | ArrayBufferLike | ArrayBufferView) => void;
  close: (code?: number, reason?: string) => void;
}

export type ConnectionStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed" | "failed";

export interface ConnectionOptions {
  createSocket: (url: string) => WebSocketLike;
  buildUrl: (ticket: string) => string;
  /** 重连时重新取票据（创建者：POST /sessions/{id}/ticket；成员：join 带 participantId） */
  renewTicket: () => Promise<string>;
  onEvent: (e: ServerEvent) => void;
  onStatus?: (status: ConnectionStatus, info: { attempt: number; error?: unknown }) => void;
  maxRetries?: number;
  baseDelayMs?: number;
  pingIntervalMs?: number;
}

const OPEN = 1;
/** 重连时这些错误码说明会话已不可恢复，直接放弃 */
const FATAL_RENEW_CODES = new Set(["A0452", "A0404", "A0451", "A0231", "A0232"]);
/** 上行缓冲积压超过该值时丢弃音频帧，避免网络拥塞时延迟无限累积 */
const MAX_BUFFERED = 512 * 1024;

export class InterpretConnection {
  private socket: WebSocketLike | null = null;
  private status: ConnectionStatus = "idle";
  private attempt = 0;
  private closedByUser = false;
  private terminal = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly pingIntervalMs: number;

  constructor(private opts: ConnectionOptions) {
    this.maxRetries = opts.maxRetries ?? 3;
    this.baseDelayMs = opts.baseDelayMs ?? 1000;
    this.pingIntervalMs = opts.pingIntervalMs ?? 20_000;
  }

  get currentStatus() {
    return this.status;
  }

  get isOpen() {
    return this.socket?.readyState === OPEN && this.status === "open";
  }

  /** 用首个票据建立连接 */
  connect(ticket: string) {
    this.closedByUser = false;
    this.terminal = false;
    this.attempt = 0;
    this.open(ticket, "connecting");
  }

  /** 发送控制帧（未连接时丢弃） */
  send(control: ClientControl): boolean {
    if (!this.isOpen) return false;
    this.socket!.send(JSON.stringify(control));
    return true;
  }

  /** 发送一帧 PCM16LE 16 kHz 音频 */
  sendAudio(pcm: Int16Array): boolean {
    if (!this.isOpen || this.socket!.bufferedAmount > MAX_BUFFERED) return false;
    const buf = pcm.byteOffset === 0 && pcm.byteLength === pcm.buffer.byteLength ? pcm.buffer : pcm.slice().buffer;
    this.socket!.send(buf as ArrayBuffer);
    return true;
  }

  /** 主动关闭（不再重连） */
  close(code = 1000) {
    this.closedByUser = true;
    this.clearTimers();
    const s = this.socket;
    this.socket = null;
    if (s) {
      this.detach(s);
      try {
        s.close(code);
      } catch {
        // 已关闭
      }
    }
    this.setStatus("closed");
  }

  private open(ticket: string, status: ConnectionStatus) {
    this.setStatus(status);
    let s: WebSocketLike;
    try {
      s = this.opts.createSocket(this.opts.buildUrl(ticket));
    } catch (e) {
      this.scheduleReconnect(e);
      return;
    }
    s.binaryType = "arraybuffer";
    this.socket = s;
    s.onopen = () => {
      if (this.socket !== s) return;
      this.attempt = 0;
      this.setStatus("open");
      this.startPing();
    };
    s.onmessage = (ev) => {
      if (this.socket !== s || typeof ev.data !== "string") return;
      const e = parseServerEvent(ev.data);
      if (!e) return;
      if (e.type === "ended" || (e.type === "error" && e.fatal)) this.terminal = true;
      this.opts.onEvent(e);
    };
    s.onerror = () => {
      // 浏览器随后会触发 onclose，统一在那里处理
    };
    s.onclose = () => {
      if (this.socket !== s) return;
      this.socket = null;
      this.stopPing();
      if (this.closedByUser || this.terminal) {
        this.setStatus("closed");
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(error?: unknown) {
    if (this.closedByUser) return;
    if (this.attempt >= this.maxRetries) {
      this.setStatus("failed", error);
      return;
    }
    this.attempt++;
    this.setStatus("reconnecting", error);
    const delay = this.baseDelayMs * 2 ** (this.attempt - 1);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.closedByUser) return;
      this.opts.renewTicket().then(
        (ticket) => {
          if (!this.closedByUser) this.open(ticket, "reconnecting");
        },
        (err: unknown) => {
          if (err instanceof ApiError && FATAL_RENEW_CODES.has(err.code)) {
            this.setStatus("failed", err);
            return;
          }
          this.scheduleReconnect(err);
        },
      );
    }, delay);
  }

  private startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => this.send({ type: "ping" }), this.pingIntervalMs);
  }

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private clearTimers() {
    this.stopPing();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private detach(s: WebSocketLike) {
    s.onopen = null;
    s.onmessage = null;
    s.onclose = null;
    s.onerror = null;
  }

  private setStatus(status: ConnectionStatus, error?: unknown) {
    if (this.status === status && status !== "reconnecting") return;
    this.status = status;
    this.opts.onStatus?.(status, { attempt: this.attempt, error });
  }
}
