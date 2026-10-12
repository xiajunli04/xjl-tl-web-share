import { http } from "@/lib/http";
import type { PageQuery, PageResult } from "./types";
import type {
  AgentNode,
  Clarification,
  TermCompliance,
  TermHit,
  TranslateMode,
  TranslatePath,
  TranslateStyle,
} from "./translate";

// 与 design.md D7 契约一一对应

export interface TranslationSummaryVO {
  id: number;
  sourcePreview: string;
  targetPreview: string;
  sourceLang: string;
  targetLang: string;
  path: TranslatePath;
  reviewScore: number | null;
  favorite: boolean;
  latencyMs: number;
  createdAt: string;
  /** 会话标记（旧后端缺失） */
  sessionId?: number | null;
  revisionOf?: number | null;
  reviseInstruction?: string | null;
  clarification?: Clarification | null;
  adopted?: boolean | null;
}

export interface TraceVO {
  seq: number;
  node: AgentNode;
  status: "started" | "completed" | "skipped" | "interrupted";
  summary: string | null;
  detail: unknown;
  latencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface TranslationDetailVO
  extends Omit<TranslationSummaryVO, "sourcePreview" | "targetPreview"> {
  sourcePreview?: string;
  targetPreview?: string;
  sourceText: string;
  targetText: string;
  detectedLang: string | null;
  mode: TranslateMode;
  style: TranslateStyle;
  domain: string | null;
  glossaryIds: number[] | null;
  modelConfigId: number | null;
  reviewRounds: number;
  compliance: TermCompliance[] | null;
  termHits: (TermHit & { spans?: [number, number][] })[] | null;
  promptTokens: number;
  completionTokens: number;
  traces: TraceVO[];
}

export interface HistoryQuery extends PageQuery {
  keyword?: string;
  sourceLang?: string;
  targetLang?: string;
  favorite?: boolean;
  startTime?: string;
  endTime?: string;
}

const BASE = "/api/translations";

export const historyApi = {
  page: (q: HistoryQuery) => http.get<PageResult<TranslationSummaryVO>>(BASE, { ...q }),
  get: (id: number) => http.get<TranslationDetailVO>(`${BASE}/${id}`),
  favorite: (id: number, favorite: boolean) =>
    http.put<null>(`${BASE}/${id}/favorite`, { favorite }),
  remove: (id: number) => http.del<null>(`${BASE}/${id}`),
};

/** react-query 键：final 之后统一失效 */
export const HISTORY_QUERY_KEY = ["translations"] as const;
