import { http } from "@/lib/http";
import { streamSse, type SseMessage } from "@/lib/sse";
import type { Usage } from "./translate";

// 与 docs/contracts/speech-image-api.md §1.6 / §1.7 / §2.2 一一对应

export type Register = "正式" | "中性" | "口语" | "书面" | "文学" | string;

export interface Alternative {
  text: string;
  register: Register;
  note: string;
}

export interface KeyExpression {
  source: string;
  target: string;
  meaning: string;
  note?: string | null;
}

export interface Insights {
  alternatives: Alternative[];
  expressions: KeyExpression[];
  summary: string;
  usage?: Usage | null;
}

export interface InsightsRequest {
  source: string;
  translation: string;
  sourceLang: string;
  targetLang: string;
  recordId?: number | null;
}

export interface AskTurn {
  q: string;
  a: string;
}

export interface AskRequest extends Omit<InsightsRequest, "recordId"> {
  question: string;
  /** 最近至多 6 轮 */
  history: AskTurn[];
}

export type AskEvent =
  | { event: "delta"; data: { text: string } }
  | { event: "done"; data: { usage?: Usage | null } }
  | { event: "error"; data: { code: string; message: string; traceId?: string } };

export const ASK_HISTORY_LIMIT = 6;

export function toAskEvent(m: SseMessage): AskEvent | null {
  if (m.event !== "delta" && m.event !== "done" && m.event !== "error") return null;
  return { event: m.event, data: JSON.parse(m.data) } as AskEvent;
}

/** 只保留最近 ASK_HISTORY_LIMIT 轮、且回答非空的问答 */
export function trimHistory(turns: readonly AskTurn[]): AskTurn[] {
  return turns.filter((t) => t.q.trim() && t.a.trim()).slice(-ASK_HISTORY_LIMIT);
}

// 开发 mock 开关就地展开，生产构建中整段被移除（见 lib/mock/flags.ts）
export const insightsApi = {
  get: (req: InsightsRequest) => http.post<Insights>("/api/translations/insights", req),
  /** 流式追问：流建立前的错误以 ApiError 抛出，之后的错误以 error 事件给出 */
  ask: async (req: AskRequest, opts: { signal?: AbortSignal; onEvent: (e: AskEvent) => void }) => {
    const onMessage = (m: SseMessage) => {
      const e = toAskEvent(m);
      if (e) opts.onEvent(e);
    };
    const body: AskRequest = { ...req, history: trimHistory(req.history) };
    if (process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_MOCK_API === "1") {
      const { mockAskStream } = await import("@/lib/mock/insights");
      return mockAskStream(body, { signal: opts.signal, onMessage });
    }
    return streamSse("/api/translations/insights/ask", body, { signal: opts.signal, onMessage });
  },
};

export const INSIGHTS_QUERY_KEY = ["translation-insights"] as const;

/** 预置快捷问题 */
export const QUICK_QUESTIONS = ["为什么这样译？", "更口语一点怎么说？", "有没有更正式的说法？", "这个词还能怎么译？"];
