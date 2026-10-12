"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { normalizeStyle, type AvatarStyle } from "@/lib/avatar/support";

interface UiState {
  sidebarCollapsed: boolean;
  agentPanelOpen: boolean;
  /** 同传中显示 AI 数字人 */
  avatarEnabled: boolean;
  /** 数字人形态：动态立绘 / 静态立绘 */
  avatarStyle: AvatarStyle;
  toggleSidebar: () => void;
  setAgentPanelOpen: (open: boolean) => void;
  setAvatarEnabled: (on: boolean) => void;
  setAvatarStyle: (style: AvatarStyle) => void;
}

/** 持久化字段（不含方法） */
export const persistUi = (s: UiState) => ({
  sidebarCollapsed: s.sidebarCollapsed,
  agentPanelOpen: s.agentPanelOpen,
  avatarEnabled: s.avatarEnabled,
  avatarStyle: s.avatarStyle,
});

/** 界面偏好（持久化）：侧边栏折叠、Agent 面板展开、数字人开关与形态 */
export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      agentPanelOpen: true,
      avatarEnabled: true,
      avatarStyle: "live",
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setAgentPanelOpen: (agentPanelOpen) => set({ agentPanelOpen }),
      setAvatarEnabled: (avatarEnabled) => set({ avatarEnabled }),
      setAvatarStyle: (avatarStyle) => set({ avatarStyle }),
    }),
    {
      name: "tl-ui",
      partialize: persistUi,
      version: 1,
      // v0（VRM 时代）的 "3d" / "simple" 映射为 "live" / "static"
      migrate: (persisted) => {
        const s = (persisted ?? {}) as Partial<UiState>;
        return { ...s, avatarStyle: normalizeStyle(s.avatarStyle) } as UiState;
      },
    },
  ),
);
