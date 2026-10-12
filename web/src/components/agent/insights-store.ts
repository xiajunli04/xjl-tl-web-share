"use client";

import { create } from "zustand";
import { insightsApi, trimHistory, type AskTurn, type InsightsRequest } from "@/lib/api/insights";
import { describeError } from "@/lib/errors";
import { isAbortError } from "@/lib/sse";

/** 「问一问」的一轮问答（answer 流式追加） */
export interface ChatTurn {
  id: number;
  question: string;
  answer: string;
  status: "streaming" | "done" | "error" | "stopped";
  error?: string;
}

interface InsightsChatState {
  /** 当前对话所属的翻译（requestId / recordId）；变化时清空 */
  key: string | null;
  turns: ChatTurn[];
  ensureKey: (key: string) => void;
  ask: (ctx: Omit<InsightsRequest, "recordId">, question: string) => Promise<void>;
  stop: () => void;
}

let controller: AbortController | null = null;
let nextId = 1;

/**
 * 解读面板的追问状态（模块级：切换标签页时保留对话；新的翻译完成后自动清空）。
 * 问答不落库（design D11）。
 */
export const useInsightsChat = create<InsightsChatState>()((set, get) => {
  const patchTurn = (id: number, p: Partial<ChatTurn> | ((t: ChatTurn) => Partial<ChatTurn>)) =>
    set((s) => ({ turns: s.turns.map((t) => (t.id === id ? { ...t, ...(typeof p === "function" ? p(t) : p) } : t)) }));

  return {
    key: null,
    turns: [],
    ensureKey: (key) => {
      if (get().key === key) return;
      controller?.abort();
      controller = null;
      set({ key, turns: [] });
    },
    stop: () => {
      controller?.abort();
      controller = null;
    },
    ask: async (ctx, question) => {
      const q = question.trim();
      if (!q || get().turns.some((t) => t.status === "streaming")) return;
      const history: AskTurn[] = trimHistory(
        get().turns.filter((t) => t.status === "done").map((t) => ({ q: t.question, a: t.answer })),
      );
      const id = nextId++;
      const key = get().key;
      set((s) => ({ turns: [...s.turns, { id, question: q, answer: "", status: "streaming" }] }));
      const ac = new AbortController();
      controller = ac;
      // 翻译已切换（key 变化）时丢弃迟到的事件
      const alive = () => get().key === key;
      try {
        await insightsApi.ask(
          { ...ctx, question: q, history },
          {
            signal: ac.signal,
            onEvent: (e) => {
              if (!alive()) return;
              if (e.event === "delta") patchTurn(id, (t) => ({ answer: t.answer + e.data.text }));
              else if (e.event === "done") patchTurn(id, { status: "done" });
              else patchTurn(id, { status: "error", error: e.data.message });
            },
          },
        );
        if (alive()) patchTurn(id, (t) => (t.status === "streaming" ? { status: "done" } : {}));
      } catch (e) {
        if (!alive()) return;
        if (isAbortError(e)) patchTurn(id, { status: "stopped" });
        else patchTurn(id, { status: "error", error: describeError(e) });
      } finally {
        if (controller === ac) controller = null;
      }
    },
  };
});
