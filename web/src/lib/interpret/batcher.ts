/**
 * 下行文本事件的按帧合并（improve-speech-endpointing-and-live-ux D9）：高频的 transcript.partial / translation.delta
 * 先入队，每个动画帧（页面隐藏时 50 ms）批量交给 store 归并一次，减少重渲染；其余事件到达时先冲刷队列再立即归并，
 * 保证顺序不变。读取最新状态前（打断、让位判定、结束摘要）调用 flush()。
 */
import type { ServerEvent } from "./protocol";

export type Schedule = (fn: () => void) => () => void;

/** 浏览器调度：可见时 requestAnimationFrame，隐藏时 50 ms 定时器 */
export const frameSchedule: Schedule = (fn) => {
  if (typeof document !== "undefined" && !document.hidden && typeof requestAnimationFrame === "function") {
    const id = requestAnimationFrame(fn);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(fn, 50);
  return () => clearTimeout(id);
};

const BATCHED = new Set<ServerEvent["type"]>(["transcript.partial", "translation.delta"]);

export class EventBatcher {
  private pending: ServerEvent[] = [];
  private cancel: (() => void) | null = null;

  constructor(
    private apply: (events: ServerEvent[]) => void,
    private schedule: Schedule = frameSchedule,
  ) {}

  push(e: ServerEvent) {
    if (!BATCHED.has(e.type)) {
      this.flush();
      this.apply([e]);
      return;
    }
    this.pending.push(e);
    this.cancel ??= this.schedule(() => {
      this.cancel = null;
      this.flush();
    });
  }

  flush() {
    this.cancel?.();
    this.cancel = null;
    if (!this.pending.length) return;
    const events = this.pending;
    this.pending = [];
    this.apply(events);
  }

  dispose() {
    this.cancel?.();
    this.cancel = null;
    this.pending = [];
  }
}
