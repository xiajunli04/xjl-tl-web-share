import { http } from "@/lib/http";
import type { PageResult } from "./types";
import type { TmHit } from "./translate";

// 与 add-session-context-and-memory 三端契约 D / F 一一对应

export interface TmEntry {
  id: number;
  sourceLang: string;
  targetLang: string;
  sourceText: string;
  targetText: string;
  origin: "workbench" | "document" | string;
  /** workbench：记录 id；document："taskId:seq" */
  originRef: string | null;
  hitCount: number;
  lastHitAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TmQuery {
  pageNum: number;
  pageSize: number;
  keyword?: string;
  sourceLang?: string;
  targetLang?: string;
}

export interface TmSearchResult {
  available: boolean;
  hits: TmHit[];
}

const BASE = "/api/tm";

export const tmApi = {
  page: (q: TmQuery) => http.get<PageResult<TmEntry>>(BASE, { ...q }),
  remove: (id: number) => http.del<null>(`${BASE}/${id}`),
  /** 把一条翻译记录存入记忆（记录必须属于当前用户） */
  fromRecord: (recordId: number, targetText?: string) =>
    http.post<{ written: number }>(`${BASE}/from-record/${recordId}`, targetText ? { targetText } : undefined),
  search: (body: { text: string; sourceLang: string; targetLang: string }) =>
    http.post<TmSearchResult>(`${BASE}/search`, body),
};

export const TM_QUERY_KEY = ["tm"] as const;
