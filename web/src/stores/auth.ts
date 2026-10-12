"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { LoginResult, UserInfo } from "@/lib/api/types";

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  user: UserInfo | null;
  /** localStorage 中的会话是否已恢复 */
  hydrated: boolean;
  setSession: (r: LoginResult) => void;
  setUser: (u: UserInfo) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      hydrated: false,
      setSession: (r) =>
        set({ accessToken: r.accessToken, refreshToken: r.refreshToken, user: r.user }),
      setUser: (user) => set({ user }),
      clear: () => set({ accessToken: null, refreshToken: null, user: null }),
    }),
    {
      name: "tl-auth",
      partialize: (s) => ({
        accessToken: s.accessToken,
        refreshToken: s.refreshToken,
        user: s.user,
      }),
    },
  ),
);

// 同步 localStorage 的恢复可能发生在 create() 内部，因此在创建之后再标记
if (typeof window !== "undefined") {
  if (useAuthStore.persist.hasHydrated()) useAuthStore.setState({ hydrated: true });
  useAuthStore.persist.onFinishHydration(() => useAuthStore.setState({ hydrated: true }));
}

export const isAdmin = (u: UserInfo | null | undefined) => !!u?.roles.includes("ADMIN");
