"use client";

import { useEffect, useState } from "react";

/** 运行中每 100ms 刷新一次的已用时间（毫秒）；结束后固定为 finishedAt - startedAt */
export function useElapsed(startedAt?: number, finishedAt?: number, running?: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [running]);
  if (!startedAt) return 0;
  return Math.max(0, (finishedAt ?? (running ? now : startedAt)) - startedAt);
}
