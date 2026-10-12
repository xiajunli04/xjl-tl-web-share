"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { TranslateMode, TranslateStyle } from "@/lib/api/translate";
import { adoptTranslation } from "@/lib/translation-run";
import { translationRunStore } from "@/hooks/use-translation-run";

export interface WorkbenchSettings {
  sourceLang: "auto" | string;
  targetLang: string;
  mode: TranslateMode;
  style: TranslateStyle;
  /** 空字符串表示由 Agent 自动判定 */
  domain: string;
  glossaryIds: number[];
  /** null 表示使用默认模型 */
  modelConfigId: number | null;
}

/** 单次翻译 / 会话翻译 */
export type WorkMode = "single" | "session";

interface WorkbenchState extends WorkbenchSettings {
  text: string;
  workMode: WorkMode;
  /** 会话模式下当前打开的会话 */
  sessionId: number | null;
  /** 打开会话后需要选中的记录（「打开会话」跳转用，不持久化） */
  focusRecordId: number | null;
  setText: (text: string) => void;
  patch: (p: Partial<WorkbenchSettings>) => void;
  /** 从历史记录带回原文与设置（「在工作台中打开」） */
  load: (p: Partial<WorkbenchSettings> & { text: string }) => void;
  setWorkMode: (m: WorkMode) => void;
  setSessionId: (id: number | null) => void;
  /** 切到会话模式并打开某个会话（可选定位到某条记录所在的轮次） */
  openSession: (id: number, recordId?: number | null) => void;
  clearFocus: () => void;
  /** 「解读」采用备选译法：替换译文区内容（text=null 恢复原译）；返回是否生效 */
  adoptTranslation: (text: string | null) => boolean;
}

export const DEFAULT_SETTINGS: WorkbenchSettings = {
  sourceLang: "auto",
  targetLang: "zh",
  mode: "auto",
  style: "faithful",
  domain: "",
  glossaryIds: [],
  modelConfigId: null,
};

/** 工作台输入与设置（持久化，刷新后保留草稿） */
export const useWorkbenchStore = create<WorkbenchState>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      text: "",
      workMode: "single",
      sessionId: null,
      focusRecordId: null,
      setText: (text) => set({ text }),
      patch: (p) => set(p),
      load: (p) => set({ ...p, workMode: "single" }),
      setWorkMode: (workMode) => set({ workMode }),
      setSessionId: (sessionId) => set({ sessionId, focusRecordId: null }),
      openSession: (id, recordId) => set({ workMode: "session", sessionId: id, focusRecordId: recordId ?? null }),
      clearFocus: () => set({ focusRecordId: null }),
      adoptTranslation: (text) => {
        // 译文保存在翻译运行 store 中：替换 final.translation，复制等操作随之使用新译文
        const patch = adoptTranslation(translationRunStore.getState(), text);
        if (patch) translationRunStore.setState(patch);
        return !!patch;
      },
    }),
    {
      name: "tl-workbench",
      partialize: (s) => ({
        text: s.text,
        sourceLang: s.sourceLang,
        targetLang: s.targetLang,
        mode: s.mode,
        style: s.style,
        domain: s.domain,
        glossaryIds: s.glossaryIds,
        modelConfigId: s.modelConfigId,
        workMode: s.workMode,
        sessionId: s.sessionId,
      }),
    },
  ),
);
