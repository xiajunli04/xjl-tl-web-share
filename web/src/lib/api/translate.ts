import { http } from "@/lib/http";
import { streamSse, type SseMessage } from "@/lib/sse";
import type { ModelCapability, Provider } from "./types";

// 与 design.md D5 / D7 契约一一对应

export type LangCode = string;
export type TranslateMode = "auto" | "fast" | "standard";
export type TranslateStyle = "faithful" | "fluent" | "creative";
/** revise：会话修订路径（add-session-context-and-memory） */
export type TranslatePath = "fast" | "standard" | "revise";
export type AgentNode =
  | "analyze"
  | "plan"
  | "retrieve"
  | "translate"
  | "review"
  | "refine"
  | "finalize"
  /** 会话歧义追问（中断时 status=interrupted） */
  | "clarify"
  /** 会话记忆压缩 */
  | "memorize";

export interface Language {
  code: LangCode;
  name: string;
  nativeName: string;
}

export interface DetectResult {
  lang: LangCode;
  confidence: number;
  method: "lingua" | "llm";
  candidates: { lang: LangCode; confidence: number }[];
}

export interface TranslateRequest {
  text: string;
  sourceLang: "auto" | LangCode;
  targetLang: LangCode;
  mode: TranslateMode;
  style: TranslateStyle;
  domain?: string;
  glossaryIds?: number[];
  modelConfigId?: number;
  /** 会话 id：带上时未显式给出的参数取会话默认值 */
  sessionId?: number;
}

export interface ModelOption {
  id: number;
  name: string;
  provider: Provider;
  isDefault: boolean;
  /** 是否为评审模型（旧后端没有该字段时按 false 处理） */
  isReviewDefault?: boolean;
  /** 能力类型（add-speech-and-image-translation；缺省视为 CHAT） */
  capability?: ModelCapability;
  /** 是否支持图片输入 */
  supportsVision?: boolean;
}

export type { ModelCapability } from "./types";

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export type ReviewCategory = "accuracy" | "fluency" | "terminology" | "style";

export interface ReviewIssue {
  category: ReviewCategory | string;
  severity: "minor" | "major" | "critical" | string;
  span?: string;
  suggestion?: string;
}

export interface TermHit {
  source: string;
  target: string;
  glossaryId: number;
}

export interface TermCompliance {
  source: string;
  target: string;
  compliant: boolean;
}

/** 翻译记忆命中（契约 C）：fuzzy / semantic 为 0–1 浮点 */
export interface TmHit {
  id: number;
  source: string;
  target: string;
  fuzzy: number;
  semantic: number;
  origin: "workbench" | "document" | string;
  /** workbench：记录 id；document："taskId:seq" */
  originRef: string | null;
}

/** 会话实体（专名表） */
export interface MemoryEntity {
  source: string;
  target: string;
  note?: string | null;
}

/** 追问问答（final.clarification / 记录的 clarification） */
export interface Clarification {
  question: string;
  options: string[];
  span: string;
  answer: string;
}

/** retrieve 节点 completed 事件的 detail（其余节点可能带任意 detail） */
export interface NodeDetail {
  tmHits?: TmHit[];
  sessionTurns?: number;
  [k: string]: unknown;
}

/* ---------- SSE 事件 data ---------- */

export interface StartEventData {
  requestId: string;
  path?: TranslatePath;
}
export interface NodeEventData {
  seq: number;
  node: AgentNode;
  /** interrupted：clarify 节点中断等待用户回答 */
  status: "started" | "completed" | "skipped" | "interrupted";
  summary?: string;
  latencyMs?: number;
  usage?: Usage;
  detail?: NodeDetail;
}
export interface DetectEventData {
  lang: LangCode;
  confidence: number;
  method: "lingua" | "llm";
}
export interface TermsEventData {
  hits: TermHit[];
  skippedGlossaries: number[];
}
export interface PlanEventData {
  path: TranslatePath;
  domain: string;
  reason: string;
}
export interface DeltaEventData {
  round: number;
  text: string;
}
export interface ReviewEventData {
  round: number;
  /** 评审输出无法解析时为 null（视为通过） */
  score: number | null;
  passed: boolean;
  issues: ReviewIssue[];
}
export interface FinalEventData {
  translation: string;
  sourceLang: LangCode;
  targetLang: LangCode;
  path: TranslatePath;
  domain: string;
  compliance: TermCompliance[];
  usage: Usage;
  latencyMs: number;
  recordId?: number;
  /** 恢复后完成时带上追问问答 */
  clarification?: Clarification | null;
  tmHits?: TmHit[];
  /** Spring 追加 */
  sessionId?: number | null;
  revisionOf?: number | null;
}
/** 终止事件：之后不发 final，连接关闭 */
export interface ClarifyEventData {
  threadId: string;
  question: string;
  options: string[];
  span: string;
  reason?: string;
}
/** 会话记忆压缩结果（在 final 之前） */
export interface MemoryEventData {
  summary: string | null;
  entities: MemoryEntity[];
  memorizedUntil: number;
}
export interface ErrorEventData {
  code: string;
  message: string;
  traceId?: string;
}

export type TranslateEvent =
  | { event: "start"; data: StartEventData }
  | { event: "node"; data: NodeEventData }
  | { event: "detect"; data: DetectEventData }
  | { event: "terms"; data: TermsEventData }
  | { event: "plan"; data: PlanEventData }
  | { event: "delta"; data: DeltaEventData }
  | { event: "review"; data: ReviewEventData }
  | { event: "final"; data: FinalEventData }
  | { event: "clarify"; data: ClarifyEventData }
  | { event: "memory"; data: MemoryEventData }
  | { event: "error"; data: ErrorEventData };

const EVENT_NAMES = new Set([
  "start",
  "node",
  "detect",
  "terms",
  "plan",
  "delta",
  "review",
  "final",
  "clarify",
  "memory",
  "error",
]);

/** 把原始 SSE 消息转换为类型化事件；未知事件名返回 null，data 不是合法 JSON 时抛错 */
export function toTranslateEvent(msg: SseMessage): TranslateEvent | null {
  if (!EVENT_NAMES.has(msg.event)) return null;
  return { event: msg.event, data: JSON.parse(msg.data) } as TranslateEvent;
}

export interface ReviseRequest {
  recordId: number;
  instruction: string;
}

export interface ClarifyAnswerRequest {
  threadId: string;
  answer: string;
}

export interface StreamOptions {
  signal?: AbortSignal;
  onEvent: (e: TranslateEvent) => void;
}

/** 原始 SSE 消息 → 类型化事件回调（未知事件忽略） */
function eventSink(opts: StreamOptions) {
  return (m: SseMessage) => {
    const e = toTranslateEvent(m);
    if (e) opts.onEvent(e);
  };
}

// 开发 mock 开关在各方法内就地展开，生产构建中整段被移除（见 lib/mock/flags.ts）
export const translateApi = {
  languages: () => http.get<Language[]>("/api/translate/languages"),
  detect: (text: string) => http.post<DetectResult>("/api/translate/detect", { text }),
  modelOptions: () => http.get<ModelOption[]>("/api/model-configs/options"),
  /**
   * 发起流式翻译。流建立之前的错误（参数校验 / 限流 / 鉴权）以 ApiError 抛出；
   * 流建立之后的错误以 error 事件交给 onEvent。
   */
  stream: async (req: TranslateRequest, opts: StreamOptions) => {
    const onMessage = eventSink(opts);
    if (process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_MOCK_STREAM === "1") {
      const { mockTranslateStream } = await import("@/lib/mock/stream");
      return mockTranslateStream(req, { signal: opts.signal, onMessage });
    }
    return streamSse("/api/translate/stream", req, { signal: opts.signal, onMessage });
  },
  /** 会话修订：对某条记录提出修订要求（走 revise 路径） */
  revise: async (sessionId: number, body: ReviseRequest, opts: StreamOptions) => {
    const onMessage = eventSink(opts);
    if (process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_MOCK_STREAM === "1") {
      const { mockReviseStream } = await import("@/lib/mock/stream");
      return mockReviseStream(sessionId, body, { signal: opts.signal, onMessage });
    }
    return streamSse(`/api/translate/sessions/${sessionId}/revise`, body, { signal: opts.signal, onMessage });
  },
  /** 回答追问：从断点继续执行（事件流以 start 开始） */
  clarify: async (sessionId: number, body: ClarifyAnswerRequest, opts: StreamOptions) => {
    const onMessage = eventSink(opts);
    if (process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_MOCK_STREAM === "1") {
      const { mockClarifyStream } = await import("@/lib/mock/stream");
      return mockClarifyStream(sessionId, body, { signal: opts.signal, onMessage });
    }
    return streamSse(`/api/translate/sessions/${sessionId}/clarify`, body, { signal: opts.signal, onMessage });
  },
};
