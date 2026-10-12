import { describe, expect, it } from "vitest";
import { EventBatcher } from "../batcher";
import type { ServerEvent } from "../protocol";
import { initialLiveState, lastReply, localTurnOpen, reduceLive } from "../reducer";

function manualSchedule() {
  const queue: (() => void)[] = [];
  return {
    schedule: (fn: () => void) => {
      queue.push(fn);
      return () => queue.splice(queue.indexOf(fn), 1);
    },
    tick: () => queue.splice(0).forEach((fn) => fn()),
    get size() {
      return queue.length;
    },
  };
}

describe("EventBatcher（按帧合并，improve-speech-endpointing-and-live-ux 4.3）", () => {
  it("100 个 delta 只在下一帧归并一次", () => {
    const calls: ServerEvent[][] = [];
    const s = manualSchedule();
    const b = new EventBatcher((es) => calls.push(es), s.schedule);
    for (let i = 0; i < 100; i++) b.push({ type: "translation.delta", utteranceId: "p1:1", lang: "en", delta: "x" });
    expect(calls).toHaveLength(0);
    expect(s.size).toBe(1);
    s.tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(100);
  });

  it("非高频事件先冲刷队列再立即归并，顺序不变", () => {
    const calls: string[][] = [];
    const s = manualSchedule();
    const b = new EventBatcher((es) => calls.push(es.map((e) => e.type)), s.schedule);
    b.push({ type: "transcript.partial", utteranceId: "p1:1", text: "大" });
    b.push({ type: "transcript.final", utteranceId: "p1:1", text: "大家好", lang: "zh" });
    expect(calls).toEqual([["transcript.partial"], ["transcript.final"]]);
    expect(s.size).toBe(0); // 已冲刷，定时器取消
  });

  it("dispose 丢弃未归并的事件", () => {
    const calls: ServerEvent[][] = [];
    const s = manualSchedule();
    const b = new EventBatcher((es) => calls.push(es), s.schedule);
    b.push({ type: "transcript.partial", utteranceId: "p1:1", text: "大" });
    b.dispose();
    b.flush();
    expect(calls).toEqual([]);
  });
});

describe("localTurnOpen / lastReply（择机开播与让位）", () => {
  const run = (events: ServerEvent[], now: number) => events.reduce((st, e) => reduceLive(st, e, now), initialLiveState());

  it("本人未定稿语句在 3 秒内视为未说完，定稿或过期后不再推迟", () => {
    const s = run([{ type: "transcript.partial", utteranceId: "p1:1", text: "我想", hold: true }], 1000);
    expect(localTurnOpen(s, "p1", 1500)).toBe(true);
    expect(localTurnOpen(s, "p2", 1500)).toBe(false); // 其他成员
    expect(localTurnOpen(s, "p1", 5000)).toBe(false); // 过期
    const done = reduceLive(s, { type: "transcript.final", utteranceId: "p1:1", text: "我想退货", lang: "zh" }, 1200);
    expect(localTurnOpen(done, "p1", 1300)).toBe(false);
  });

  it("lastReply 跳过已打断的回复", () => {
    const s = run(
      [
        { type: "transcript.final", utteranceId: "p1:1", text: "你好", lang: "zh" },
        { type: "transcript.partial", utteranceId: "p1:2", role: "assistant", text: "Hi" },
      ],
      1000,
    );
    expect(lastReply(s)?.id).toBe("p1:2");
    const cut = reduceLive(s, { type: "reply.interrupted", utteranceId: "p1:2", text: "Hi" });
    expect(lastReply(cut)).toBeNull();
  });
});
