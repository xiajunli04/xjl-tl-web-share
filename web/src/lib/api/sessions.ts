import { http } from "@/lib/http";
import type { PageResult } from "./types";
import type { Clarification, MemoryEntity, TranslatePath, TranslateStyle } from "./translate";

// 与 add-session-context-and-memory 三端契约 F 一一对应

export interface SessionSummaryVO {
  id: number;
  title: string;
  sourceLang: string;
  targetLang: string;
  turnCount: number;
  /** 是否有等待回答的追问 */
  hasPending: boolean;
  updatedAt: string;
  createdAt: string;
}

export interface SessionVO extends SessionSummaryVO {
  style: TranslateStyle | null;
  domain: string | null;
  glossaryIds: number[] | null;
  modelConfigId: number | null;
  clarifyEnabled: boolean;
}

export interface PendingClarify {
  threadId: string;
  question: string;
  options: string[];
  span: string;
  reason?: string | null;
  /** 被追问的原文 */
  source: string;
}

/** 一轮中的一个版本（v1 为原始翻译，之后为修订） */
export interface RecordBrief {
  id: number;
  sourceText: string;
  targetText: string;
  mode: string;
  path: TranslatePath | string;
  reviseInstruction: string | null;
  clarification: Clarification | null;
  revisionOf: number | null;
  adopted: boolean;
  reviewScore: number | null;
  createdAt: string;
}

export interface Turn {
  seq: number;
  /** 按 createdAt 升序 */
  versions: RecordBrief[];
  adoptedRecordId: number | null;
}

export interface SessionDetailVO extends SessionVO {
  memorySummary: string | null;
  memoryEntities: MemoryEntity[];
  memorizedUntil: number;
  pending: PendingClarify | null;
  turns: Turn[];
}

export interface SessionSaveRequest {
  title?: string;
  sourceLang?: string;
  targetLang?: string;
  style?: TranslateStyle;
  domain?: string;
  glossaryIds?: number[];
  modelConfigId?: number;
  clarifyEnabled?: boolean;
}

export interface SessionQuery {
  pageNum: number;
  pageSize: number;
  keyword?: string;
}

const BASE = "/api/translate/sessions";

export const sessionsApi = {
  page: (q: SessionQuery) => http.get<PageResult<SessionSummaryVO>>(BASE, { ...q }),
  get: (id: number) => http.get<SessionDetailVO>(`${BASE}/${id}`),
  create: (body: SessionSaveRequest & { sourceLang: string; targetLang: string }) =>
    http.post<SessionVO>(BASE, body),
  update: (id: number, body: SessionSaveRequest) => http.put<SessionVO>(`${BASE}/${id}`, body),
  remove: (id: number) => http.del<null>(`${BASE}/${id}`),
  adopt: (id: number, recordId: number) =>
    http.put<SessionDetailVO>(`${BASE}/${id}/records/${recordId}/adopt`),
};

/** react-query 键 */
export const SESSIONS_QUERY_KEY = ["sessions"] as const;
export const sessionDetailKey = (id: number | null) => [...SESSIONS_QUERY_KEY, "detail", id] as const;
