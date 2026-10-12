import { http } from "@/lib/http";
import type { PageResult } from "./types";

// 同传历史（docs/contracts/speech-image-api.md §2.4 中的 GET / PUT / DELETE；
// 会话创建、加入、票据、结束等 POST 接口在 lib/api/interpret.ts）

export type InterpretMode = "LISTEN" | "CONVERSE" | "ROOM" | "CHAT";

export interface InterpretStats {
  utterances?: number;
  avgE2eMs?: number | null;
  p50E2eMs?: number | null;
  participants?: number;
  languages?: string[];
  [k: string]: unknown;
}

export interface InterpretSessionVO {
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
  options?: Record<string, unknown> | null;
}

export interface InterpretSegmentVO {
  seq: number;
  speakerParticipant: string;
  speakerName: string;
  sourceLang: string;
  sourceText: string;
  translations: Record<string, string>;
  metrics: { e2eMs?: number | null; [k: string]: unknown } | null;
  startedMs: number;
  endedMs: number;
}

export interface InterpretHistoryQuery {
  pageNum: number;
  pageSize: number;
  keyword?: string;
  mode?: InterpretMode;
  favorite?: boolean;
  from?: string;
  to?: string;
}

const BASE = "/api/interpret/sessions";

/** 转写分页上限 */
export const SEGMENT_PAGE_SIZE = 100;

export const interpretHistoryApi = {
  page: (q: InterpretHistoryQuery) => http.get<PageResult<InterpretSessionVO>>(BASE, { ...q }),
  get: (id: number) => http.get<InterpretSessionVO>(`${BASE}/${id}`),
  segments: (id: number, pageNum: number, pageSize = SEGMENT_PAGE_SIZE) =>
    http.get<PageResult<InterpretSegmentVO>>(`${BASE}/${id}/segments`, { pageNum, pageSize }),
  favorite: (id: number, favorite: boolean) => http.put<null>(`${BASE}/${id}/favorite`, { favorite }),
  remove: (id: number) => http.del<null>(`${BASE}/${id}`),
};

export const INTERPRET_HISTORY_QUERY_KEY = ["interpret-sessions"] as const;

export const INTERPRET_MODE_LABEL: Record<InterpretMode, string> = {
  LISTEN: "同传收听",
  CONVERSE: "双向对话",
  ROOM: "多语会议室",
  CHAT: "AI 对话",
};

/** 时长：1:05 / 1:02:03 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return "—";
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** 转写中的相对时间戳 mm:ss */
export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** 一段转写在某种显示语言下的文本：源语言即该语言时显示原文，否则取译文 */
export function segmentText(seg: InterpretSegmentVO, lang: string): string | null {
  if (seg.sourceLang === lang || (seg.sourceLang === "yue" && lang === "zh")) return seg.sourceText;
  return seg.translations[lang] ?? null;
}

/** 关键词匹配原文或任一译文（不区分大小写） */
export function segmentMatches(seg: InterpretSegmentVO, keyword: string): boolean {
  const k = keyword.trim().toLowerCase();
  if (!k) return true;
  return [seg.sourceText, ...Object.values(seg.translations)].some((t) => t.toLowerCase().includes(k));
}

/** 会话涉及的全部语言（会话 languages ∪ 统计 languages ∪ 转写中的源语言与译文语言），保持首次出现顺序 */
export function sessionLanguages(s: Pick<InterpretSessionVO, "languages" | "stats">, segs: readonly InterpretSegmentVO[]): string[] {
  const out: string[] = [];
  const add = (l?: string | null) => {
    const v = l === "yue" ? "zh" : l;
    if (v && !out.includes(v)) out.push(v);
  };
  s.languages.forEach(add);
  s.stats?.languages?.forEach(add);
  for (const seg of segs) {
    add(seg.sourceLang);
    Object.keys(seg.translations).forEach(add);
  }
  return out;
}

/** 由转写计算平均端到端延迟（毫秒）；没有指标时返回 null */
export function averageE2e(segs: readonly InterpretSegmentVO[]): number | null {
  const v = segs.map((s) => s.metrics?.e2eMs).filter((x): x is number => typeof x === "number");
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
}
