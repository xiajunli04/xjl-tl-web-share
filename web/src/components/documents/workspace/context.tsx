"use client";

import { createContext, useContext } from "react";
import type { DocTaskStoreApi } from "@/hooks/use-doc-task";

export type SideTab = "overview" | "terms" | "consistency" | "trace";

export interface WorkspaceCtx {
  id: number;
  store: DocTaskStoreApi;
  selectedSeq: number | null;
  select: (seq: number | null) => void;
  /** 滚动到某段并闪烁高亮一次 */
  locate: (seq: number) => void;
  flash: { seq: number; nonce: number } | null;
  editingSeq: number | null;
  setEditingSeq: (seq: number | null) => void;
  tab: SideTab;
  setTab: (t: SideTab) => void;
  follow: boolean;
  setFollow: (v: boolean) => void;
}

export const WorkspaceContext = createContext<WorkspaceCtx | null>(null);

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace 必须在 DocWorkspace 内使用");
  return ctx;
}
