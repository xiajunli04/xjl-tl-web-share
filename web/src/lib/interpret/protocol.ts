/**
 * 实时音频通道事件（docs/contracts/speech-image-api.md §1.8 / §2.6，design D7）。
 */
import type { AudioChunk } from "@/lib/audio/queue";
import type { InterpretMode } from "@/lib/api/interpret";

export interface Speaker {
  participantId: string;
  displayName: string;
  lang: string;
}

export interface Participant {
  participantId: string;
  displayName: string;
  lang: string;
  speaking: boolean;
  isHost?: boolean;
  online?: boolean;
}

export interface UtteranceMetrics {
  asrMs: number | null;
  mtFirstMs: number | null;
  mtMs: number | null;
  ttsFirstMs: number | null;
  e2eMs: number | null;
  /** 级联两段式断句：该句在续说等待中累计停留的时长（improve-speech-endpointing-and-live-ux） */
  holdMs?: number | null;
}

export interface EndedStats {
  durationMs?: number;
  utterances?: number;
  avgE2eMs?: number | null;
}

/** 发言角色：AI 对话（CHAT）中 AI 回复的事件带 role=assistant，其余缺省为 user */
export type UtteranceRole = "user" | "assistant";

type WithUtt = { utteranceId: string | number; speaker?: Speaker | null; role?: UtteranceRole };

export type ServerEvent =
  | {
      type: "ready";
      sessionId?: number;
      participantId?: string;
      mode?: InterpretMode;
      engine: string;
      languages?: string[];
      sourceLangs?: string[];
      targetLangs?: string[];
      roomCode?: string | null;
      isHost?: boolean;
    }
  | { type: "participants"; list: Participant[] }
  | (WithUtt & {
      type: "transcript.partial";
      text: string;
      /** 服务端判为未说完、正在等待续说 */
      hold?: boolean;
    })
  /** 撤回一条尚未定稿的语句（语气词 / 噪声，或让位撤回的 AI 回复）；此后该 utteranceId 不再有事件 */
  | (WithUtt & { type: "transcript.discard" })
  | (WithUtt & {
      type: "transcript.final";
      text: string;
      lang: string;
      startedMs?: number;
      endedMs?: number;
      /** AI 回复的服务端合成不可用：由浏览器朗读原文 */
      ttsFallback?: boolean;
    })
  | (WithUtt & { type: "translation.delta"; lang: string; delta: string })
  | (WithUtt & { type: "translation.final"; lang: string; text: string; ttsFallback?: boolean })
  | (WithUtt & Omit<AudioChunk, "utteranceId"> & { type: "audio" })
  | (WithUtt & Partial<UtteranceMetrics> & { type: "metrics" })
  | (WithUtt & { type: "reply.interrupted"; text: string })
  | { type: "error"; code: string; message: string; fatal: boolean }
  | { type: "ended"; reason: string; stats?: EndedStats | null }
  | { type: "pong" };

export type ServerEventType = ServerEvent["type"];

export type ClientControl =
  | { type: "ptt"; side: "A" | "B" | null }
  | { type: "flush" }
  | { type: "mute"; muted: boolean }
  /** yield=true：让位，撤回最近一条尚未开始播放的 AI 回复 */
  | { type: "interrupt"; yield?: boolean }
  | { type: "end" }
  | { type: "ping" };

const KNOWN = new Set<string>([
  "ready",
  "participants",
  "transcript.partial",
  "transcript.final",
  "transcript.discard",
  "translation.delta",
  "translation.final",
  "audio",
  "metrics",
  "reply.interrupted",
  "error",
  "ended",
  "pong",
]);

/** 解析一条文本帧；无法识别时返回 null（前向兼容：忽略未知事件） */
export function parseServerEvent(raw: string): ServerEvent | null {
  try {
    const obj = JSON.parse(raw) as { type?: unknown };
    if (!obj || typeof obj.type !== "string" || !KNOWN.has(obj.type)) return null;
    return obj as ServerEvent;
  } catch {
    return null;
  }
}

/** 识别结果 yue 在路由与显示上视为 zh（契约 §0） */
export function normLang(lang: string | null | undefined): string | null {
  if (!lang) return null;
  return lang === "yue" ? "zh" : lang;
}
