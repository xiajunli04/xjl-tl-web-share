"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** 距底部不超过该距离视为"在底部"，内容增长时跟随 */
export const STICK_THRESHOLD = 96;

export function nearBottom(el: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">, threshold = STICK_THRESHOLD) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

/**
 * 跟随滚动（improve-speech-endpointing-and-live-ux D9）：
 * - 用户在底部附近时，内容增长（ResizeObserver）在下一帧直接贴底，不用平滑滚动（流式逐字更新不会反复重启动画）；
 *   新增条目时平滑滚到底部
 * - 用户上翻后不再抢滚动，新增条目计入 unread，由"新消息"胶囊调用 scrollToBottom 回到底部
 * itemCount 为当前条目数（用于区分"新增条目"与"已有条目变长"）。
 */
export function useStickToBottom<T extends HTMLElement>(itemCount: number, opts: { reduce?: boolean } = {}) {
  const ref = useRef<T>(null);
  const stuck = useRef(true);
  const count = useRef(itemCount);
  const [unread, setUnread] = useState(0);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    stuck.current = nearBottom(el);
    if (stuck.current) setUnread(0);
  }, []);

  const scrollToBottom = useCallback(
    (smooth = true) => {
      const el = ref.current;
      if (!el) return;
      stuck.current = true;
      setUnread(0);
      el.scrollTo({ top: el.scrollHeight, behavior: smooth && !opts.reduce ? "smooth" : "auto" });
    },
    [opts.reduce],
  );

  // 已有内容变高（流式文本增长、展开原文）：在底部时直接贴底。contentRef 挂在滚动容器内始终存在的内容包裹层上
  const observer = useRef<{ ro: ResizeObserver; frame: number } | null>(null);
  const contentRef = useCallback((node: HTMLElement | null) => {
    if (observer.current) {
      cancelAnimationFrame(observer.current.frame);
      observer.current.ro.disconnect();
      observer.current = null;
    }
    if (!node || typeof ResizeObserver === "undefined") return;
    const state = {
      frame: 0,
      ro: new ResizeObserver(() => {
        const el = ref.current;
        if (!el || !stuck.current) return;
        cancelAnimationFrame(state.frame);
        state.frame = requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight;
        });
      }),
    };
    state.ro.observe(node);
    observer.current = state;
  }, []);

  // 新增条目：在底部时平滑跟随，否则计入未读
  useEffect(() => {
    const added = itemCount - count.current;
    count.current = itemCount;
    if (added <= 0) return;
    if (stuck.current) {
      const el = ref.current;
      el?.scrollTo({ top: el.scrollHeight, behavior: opts.reduce ? "auto" : "smooth" });
    } else {
      setUnread((u) => u + added);
    }
  }, [itemCount, opts.reduce]);

  return { ref, contentRef, onScroll, unread, scrollToBottom };
}
