"use client";

import { useSyncExternalStore } from "react";

/** 订阅媒体查询；服务端渲染时返回 fallback */
export function useMediaQuery(query: string, fallback = true): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", cb);
      return () => mql.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => fallback,
  );
}
