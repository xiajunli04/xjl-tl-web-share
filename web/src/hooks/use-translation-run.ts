"use client";

import { useStore } from "zustand";
import { translateApi } from "@/lib/api/translate";
import { HISTORY_QUERY_KEY } from "@/lib/api/history";
import { SESSIONS_QUERY_KEY } from "@/lib/api/sessions";
import { getQueryClient } from "@/lib/query-client";
import { createRunStore, type RunStore } from "@/lib/translation-run";

/**
 * 工作台的运行状态 store（独立于 react-query 缓存）。
 * 模块级单例：切换路由再回来时，进行中的翻译与结果仍然保留。
 */
export const translationRunStore = createRunStore({
  stream: translateApi.stream,
  onFinal: () => {
    void getQueryClient().invalidateQueries({ queryKey: HISTORY_QUERY_KEY });
  },
  // 会话内的 final / clarify / memory：刷新会话列表与详情（新轮次、版本、pending、会话记忆）
  onSessionEvent: (_e, sessionId) => {
    if (sessionId === undefined) return;
    void getQueryClient().invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
  },
});

export function useTranslationRun(): RunStore;
export function useTranslationRun<T>(selector: (s: RunStore) => T): T;
export function useTranslationRun<T>(selector?: (s: RunStore) => T) {
  return useStore(translationRunStore, selector ?? ((s: RunStore) => s as unknown as T));
}
