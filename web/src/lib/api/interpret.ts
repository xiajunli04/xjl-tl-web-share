import { API_BASE_URL, http } from "@/lib/http";

// 与 docs/contracts/speech-image-api.md §2.4（POST 类）一一对应；历史查询接口见 interpret-history.ts

export type InterpretMode = "LISTEN" | "CONVERSE" | "ROOM" | "CHAT";
/** 响应速度档位（仅平台级联）：balanced 均衡 / fast 极速（断句更快） */
export type LatencyMode = "balanced" | "fast";
/** AI 对话场景（add-ai-avatar-and-landing D6） */
export type ChatScenario = "free" | "travel" | "restaurant" | "business" | "interview";
export type ConverseRouting = "auto" | "ptt";
export type VoiceGender = "female" | "male";

export interface InterpretCreateRequest {
  mode: InterpretMode;
  engine: string;
  /** LISTEN: [目标]；CONVERSE: [A, B]；ROOM: [我的语言]；CHAT: [我的语言, 对话语言] */
  languages: string[];
  sourceHints?: string[];
  converseRouting?: ConverseRouting;
  glossaryIds?: number[];
  domainHint?: string | null;
  tts?: boolean;
  headphone?: boolean;
  gender?: VoiceGender;
  voices?: Record<string, string | null>;
  asrEngine?: string | null;
  ttsEngine?: string | null;
  modelConfigId?: number | null;
  displayName?: string | null;
  title?: string | null;
  /** 仅 CHAT */
  chatScenario?: ChatScenario | null;
  /** 响应速度（仅平台级联生效，缺省 balanced） */
  latencyMode?: LatencyMode | null;
}

export interface InterpretJoinRequest {
  displayName: string;
  lang: string;
  /** 30 s 内重连恢复身份 */
  participantId?: string | null;
}

export interface InterpretJoinVO {
  sessionId: number;
  participantId: string;
  wsTicket: string;
  roomCode: string | null;
  mode: InterpretMode;
  engine: string;
  languages: string[];
  isHost: boolean;
  /** 相对路径，默认 /ws/interpret */
  wsUrl: string;
}

export interface InterpretStats {
  utterances: number;
  avgE2eMs: number | null;
  p50E2eMs?: number | null;
  participants?: number;
  languages?: string[];
  durationMs?: number;
}

/** 结束接口返回（字段同 §2.4 InterpretSessionVO） */
export interface InterpretEndVO {
  id: number;
  mode: InterpretMode;
  engine: string;
  languages: string[];
  roomCode: string | null;
  status: "ACTIVE" | "ENDED";
  title: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  stats: InterpretStats | null;
  favorite: boolean;
  /** 创建时的选项（glossaryIds、domainHint、tts、headphone、gender、converseRouting、modelConfigId 等） */
  options?: Record<string, unknown> | null;
}

const BASE = "/api/interpret";

export const interpretApi = {
  /** 当前用户进行中的会话（刷新页面后恢复用）；没有时为 null */
  active: () => http.get<InterpretEndVO | null>(`${BASE}/sessions/active`),
  create: (body: InterpretCreateRequest) => http.post<InterpretJoinVO>(`${BASE}/sessions`, body),
  join: (code: string, body: InterpretJoinRequest) =>
    http.post<InterpretJoinVO>(`${BASE}/rooms/${encodeURIComponent(code.trim().toUpperCase())}/join`, body),
  /** 创建者重连时取新票据 */
  ticket: (sessionId: number) => http.post<InterpretJoinVO>(`${BASE}/sessions/${sessionId}/ticket`),
  end: (sessionId: number) => http.post<InterpretEndVO>(`${BASE}/sessions/${sessionId}/end`),
};

/** `${API_BASE_URL 换成 ws(s)}${wsUrl}?ticket=` */
export function interpretWsUrl(ticket: string, wsUrl = "/ws/interpret", base = API_BASE_URL): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
  const resolvedBase = new URL(base || origin, origin).href.replace(/\/+$/, "");
  const path = wsUrl.startsWith("ws") ? wsUrl : resolvedBase.replace(/^http/i, "ws") + (wsUrl.startsWith("/") ? wsUrl : `/${wsUrl}`);
  return `${path}${path.includes("?") ? "&" : "?"}ticket=${encodeURIComponent(ticket)}`;
}

/** 房间码：6 位大写字母与数字（去掉易混淆字符 0O1IL 由服务端保证，前端只做格式校验） */
export function isRoomCode(code: string) {
  return /^[A-Z0-9]{6}$/.test(code.trim().toUpperCase());
}
