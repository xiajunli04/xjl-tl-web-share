import { http } from "@/lib/http";
import { subscribeSse, type SseMessage, type SubscribeOptions } from "@/lib/sse";
import type { PageResult } from "./types";
import type { TermCompliance, TmHit, TranslateStyle, Usage } from "./translate";

// 与 openspec/changes/add-document-translation-agent/design.md D10 / D13 契约一一对应

export type DocStatus =
  | "PENDING"
  | "PARSING"
  | "ANALYZING"
  | "AWAITING_CONFIRM"
  | "TRANSLATING"
  | "CONSISTENCY"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLING"
  | "CANCELLED";

export type DocPhase =
  | "parsing"
  | "analyzing"
  | "awaiting_confirm"
  | "translating"
  | "consistency"
  | "assembling";

export type DocFormat = "md" | "txt";
export type DocStrategy = "serial" | "parallel" | "hybrid";

export interface DocOptions {
  contextWindow: boolean;
  globalSummary: boolean;
  termExtraction: boolean;
  review: boolean;
  /** 翻译记忆（缺省 true；旧后端可能缺失，读取时按 true 处理，见 meta.normalizeOptions） */
  translationMemory: boolean;
}

export interface DocTaskStats {
  chunks: number;
  cachedChunks: number;
  refined: number;
  compliance: { ok: number; total: number };
}

export interface ConsistencyIssue {
  term: string;
  variants: { text: string; count: number }[];
  chosen: string;
  fixedSegs: number[];
  unresolvedSegs: number[];
}

export interface ConsistencyReport {
  issues: ConsistencyIssue[];
}

/** 列表用：DocTaskVO 去掉 summary、consistencyReport、stats */
export interface DocTaskSummaryVO {
  id: number;
  title: string;
  format: DocFormat;
  charCount: number;
  sourceLang: string;
  detectedLang: string | null;
  targetLang: string;
  style: TranslateStyle;
  domain: string | null;
  genre: string | null;
  glossaryIds: number[];
  modelConfigId: number | null;
  strategy: DocStrategy;
  confirmTerms: boolean;
  options: DocOptions;
  status: DocStatus;
  /** 最近一次上报的执行阶段（尚未开始时为 null） */
  phase: DocPhase | null;
  /** 已完成分块数 */
  progressDone: number;
  /** 分块总数（解析完成前为 0） */
  progressTotal: number;
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean | null;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface DocTaskVO extends DocTaskSummaryVO {
  /** 创建时解析出的评审模型；null 表示与译者相同（旧后端没有该字段） */
  reviewModelConfigId?: number | null;
  summary: string | null;
  consistencyReport: ConsistencyReport | null;
  stats: DocTaskStats | null;
}

export type DocBlockType =
  | "heading"
  | "paragraph"
  | "list_item"
  | "blockquote"
  | "table_row"
  | "code"
  | "html"
  | "blank"
  | "hr";

export interface DocSegmentVO {
  seq: number;
  blockType: DocBlockType;
  level: number | null;
  prefix: string;
  source: string;
  suffix: string;
  translatable: boolean;
  chunkIndex: number | null;
  target: string | null;
  /** 段落状态（D9 status varchar(16)，取值以 Spring 为准；前端以 target 是否为空判断是否已译） */
  status: string;
  reviewScore: number | null;
  reviewRounds: number | null;
  compliance: TermCompliance[] | null;
  edited: boolean;
  /** 该段命中的翻译记忆（0–1 条；旧后端缺失） */
  tmHits?: TmHit[] | null;
}

/** user：用户在确认术语时手动新增 */
export type DocTermOrigin = "glossary" | "extracted" | "user";
/** AUTO：未开启人工确认时自动采用的抽取术语（软约束，仅供模型参考） */
export type DocTermStatus = "PENDING" | "CONFIRMED" | "REJECTED" | "AUTO";

export interface DocTermVO {
  id: number;
  source: string;
  target: string;
  origin: DocTermOrigin;
  frequency: number;
  status: DocTermStatus;
}

/* ---------- 请求 ---------- */

export interface DocTaskSettings {
  title?: string;
  sourceLang: "auto" | string;
  targetLang: string;
  style: TranslateStyle;
  domain?: string;
  glossaryIds?: number[];
  modelConfigId?: number;
  /** 显式指定评审模型；缺省时使用管理员设置的评审模型 */
  reviewModelConfigId?: number;
  strategy: DocStrategy;
  confirmTerms: boolean;
  options?: DocOptions;
}

export interface DocTaskCreateRequest extends DocTaskSettings {
  text: string;
  format: DocFormat;
}

export interface DocTermConfirmItem {
  /** 为空表示用户新增的术语 */
  id?: number;
  source: string;
  target: string;
  status: "CONFIRMED" | "REJECTED";
}

/** GET /api/doc-tasks/{id}/traces 的一条记录（doc_task_trace） */
export interface DocTraceVO {
  seq: number;
  node: string;
  chunkIndex: number | null;
  status: string;
  summary: string | null;
  latencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  createdAt: string;
}

export interface RetranslateResult {
  target: string;
  usage: Usage;
  latencyMs: number;
}

export type DocExportFormat = "md" | "bilingual" | "txt";

export interface DocTaskQuery {
  pageNum: number;
  pageSize: number;
  status?: DocStatus;
  keyword?: string;
}

/* ---------- 浏览器 SSE 事件（D13） ---------- */

export interface ChunkSegmentUpdate {
  seq: number;
  target: string;
  reviewScore: number | null;
  reviewRounds: number | null;
  compliance: TermCompliance[] | null;
  tmHits?: TmHit[] | null;
}

/** 可选：Spring 若转发执行轨迹，按 D2 trace 的结构推送（D13 未列出，收到时展示在「轨迹」页） */
export interface DocTraceEventData {
  seq: number;
  node: string;
  status: string;
  summary: string;
  chunk?: number;
  latencyMs?: number;
  usage?: Usage;
}

export type DocEvent =
  | { event: "snapshot"; data: DocTaskVO }
  | { event: "phase"; data: { status: DocStatus; phase: DocPhase } }
  | { event: "parsed"; data: { progressTotal: number; detectedLang: string | null } }
  | { event: "analysis"; data: { summary: string | null; domain: string | null; genre: string | null } }
  | { event: "awaiting_confirm"; data: { terms: DocTermVO[] } }
  | {
      event: "chunk_done";
      data: {
        chunk: number;
        progressDone: number;
        progressTotal: number;
        cached: boolean;
        segments: ChunkSegmentUpdate[];
      };
    }
  | { event: "consistency"; data: { report: ConsistencyReport; segments: { seq: number; target: string }[] } }
  | { event: "completed"; data: DocTaskVO }
  | { event: "failed"; data: { code: string; message: string; retryable: boolean } }
  | { event: "cancelled"; data: Record<string, never> }
  | { event: "trace"; data: DocTraceEventData };

export type DocEventName = DocEvent["event"];

const DOC_EVENTS = new Set<string>([
  "snapshot",
  "phase",
  "parsed",
  "analysis",
  "awaiting_confirm",
  "chunk_done",
  "consistency",
  "completed",
  "failed",
  "cancelled",
  "trace",
]);

/** 原始 SSE 消息 → 类型化事件；未知事件名返回 null，data 不是合法 JSON 时抛错 */
export function toDocEvent(m: SseMessage): DocEvent | null {
  if (!DOC_EVENTS.has(m.event)) return null;
  return { event: m.event, data: JSON.parse(m.data) } as DocEvent;
}

export const TERMINAL_STATUSES: readonly DocStatus[] = ["COMPLETED", "FAILED", "CANCELLED"];
export const isTerminal = (s: DocStatus | null | undefined) => !!s && TERMINAL_STATUSES.includes(s);

export interface DocSubscribeOptions extends Omit<SubscribeOptions, "onMessage"> {
  onEvent: (e: DocEvent) => void;
}

export type DocSubscribeFn = (id: number, opts: DocSubscribeOptions) => Promise<void>;

const BASE = "/api/doc-tasks";

export const docApi = {
  page: (q: DocTaskQuery) => http.get<PageResult<DocTaskSummaryVO>>(BASE, { ...q }),
  get: (id: number) => http.get<DocTaskVO>(`${BASE}/${id}`),
  segments: (id: number) => http.get<DocSegmentVO[]>(`${BASE}/${id}/segments`),
  terms: (id: number) => http.get<DocTermVO[]>(`${BASE}/${id}/terms`),
  traces: (id: number) => http.get<DocTraceVO[]>(`${BASE}/${id}/traces`),

  /** 粘贴文本：JSON 创建 */
  create: (body: DocTaskCreateRequest) => http.post<DocTaskVO>(BASE, body),
  /** 上传文件：multipart（file + settings JSON，format 由扩展名判定） */
  createWithFile: (file: File, settings: DocTaskSettings) => {
    const form = new FormData();
    form.append("file", file);
    form.append("settings", JSON.stringify(settings));
    return http.upload<DocTaskVO>(BASE, form);
  },

  /** 未列出的待确认术语会被置为 REJECTED；返回最新的术语列表 */
  confirmTerms: (id: number, terms: DocTermConfirmItem[]) =>
    http.post<DocTermVO[]>(`${BASE}/${id}/terms/confirm`, { terms }),
  cancel: (id: number) => http.post<unknown>(`${BASE}/${id}/cancel`),
  retry: (id: number) => http.post<unknown>(`${BASE}/${id}/retry`),
  remove: (id: number) => http.del<unknown>(`${BASE}/${id}`),

  updateSegment: (id: number, seq: number, target: string) =>
    http.put<DocSegmentVO>(`${BASE}/${id}/segments/${seq}`, { target }),
  retranslate: (id: number, seq: number, instruction?: string) =>
    http.post<RetranslateResult>(`${BASE}/${id}/segments/${seq}/retranslate`, {
      instruction: instruction?.trim() || undefined,
    }),

  /** 把已完成任务的全部译文写入翻译记忆（非 COMPLETED 返回 A0431） */
  writeMemory: (id: number) => http.post<{ written: number }>(`${BASE}/${id}/memory`),

  export: (id: number, format: DocExportFormat) => http.download(`${BASE}/${id}/export`, { format }),

  /**
   * 订阅任务事件（GET /api/doc-tasks/{id}/events）：先收到 snapshot，再收到增量事件；
   * 断线自动重连（服务端重新发送 snapshot）。
   */
  subscribe: (async (id, opts) => {
    const { onEvent, ...rest } = opts;
    const onMessage = (m: SseMessage) => {
      const e = toDocEvent(m);
      if (e) onEvent(e);
    };
    // 开发 mock 开关就地展开，生产构建中整段被移除（见 lib/mock/flags.ts）。
    // REST 走 mock 时事件流也必须走 mock（真实后端不认识 mock 数据）。
    if (
      process.env.NODE_ENV !== "production" &&
      (process.env.NEXT_PUBLIC_MOCK_STREAM === "1" || process.env.NEXT_PUBLIC_MOCK_API === "1")
    ) {
      const { mockDocSubscribe } = await import("@/lib/mock/doc-engine");
      return mockDocSubscribe(id, { ...rest, onMessage });
    }
    return subscribeSse(`${BASE}/${id}/events`, { ...rest, onMessage });
  }) as DocSubscribeFn,
};
