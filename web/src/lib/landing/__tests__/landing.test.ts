import { describe, expect, it } from "vitest";
import {
  COMPARE,
  COMPARE_COLUMNS,
  COMPARE_TABLE,
  estimateDoc,
  estimateMeeting,
  HERO_SCRIPT,
  HERO_TRANSLATION,
  PLAYGROUND,
  STATS,
} from "../fixtures";
import { duration, initialTrace, stateAt, streamText, type Step } from "../script";

describe("脚本时间线（landing-page：脚本化交互演示）", () => {
  type S = { n: number; text: string };
  const steps: Step<S>[] = [
    { at: 100, apply: (s) => ({ ...s, n: s.n + 1 }) },
    { at: 200, dur: 400, apply: (s, p) => ({ ...s, text: streamText("你好世界", p) }) },
  ];
  it("stateAt 只应用已开始的步骤，并按进度取流式文本", () => {
    expect(stateAt(steps, { n: 0, text: "" }, 50)).toEqual({ n: 0, text: "" });
    expect(stateAt(steps, { n: 0, text: "" }, 400)).toEqual({ n: 1, text: "你好" });
    expect(stateAt(steps, { n: 0, text: "" }, 10_000)).toEqual({ n: 1, text: "你好世界" });
    expect(duration(steps)).toBe(600);
  });

  it("Hero 轨迹播完后五个阶段均已结束并输出完整译文", () => {
    const end = stateAt(HERO_SCRIPT, initialTrace(), duration(HERO_SCRIPT));
    expect(Object.values(end.stages).every((s) => s === "done" || s === "skipped")).toBe(true);
    expect(end.output).toBe(HERO_TRANSLATION);
  });

  it("歧义样例：回放到追问后暂停，不同选择得到不同译文", () => {
    const amb = PLAYGROUND.find((p) => p.key === "ambiguity")!;
    const paused = stateAt(amb.script, initialTrace(), duration(amb.script));
    expect(paused.question?.options).toHaveLength(2);
    expect(paused.output).toBe("");
    const outs = amb.branches!.map((b) => {
      const end = stateAt(b.script, paused, duration(b.script));
      expect(end.question).toBeNull();
      return end.output;
    });
    expect(new Set(outs).size).toBe(2);
  });
});

describe("对比与估算（landing-page：与传统方式对比）", () => {
  it("每个场景四列齐全，至少一个问题高亮", () => {
    expect(COMPARE.map((c) => c.key)).toEqual(["doc", "dialog", "meeting"]);
    for (const c of COMPARE) {
      expect(Object.keys(c.cells).sort()).toEqual(COMPARE_COLUMNS.map((x) => x.key).sort());
      expect(Object.values(c.cells).some((cell) => cell.output.some((s) => s.issue))).toBe(true);
    }
    expect(COMPARE_TABLE.length).toBeLessThanOrEqual(6);
  });

  it("文档估算：10,000 词人工约 3.5 天、$1,000–2,200，本平台约 18.6 分钟", () => {
    const e = estimateDoc(10_000);
    expect(e.humanDays).toBeCloseTo(3.5, 1);
    expect(e.humanCost[0]).toBeCloseTo(1000);
    expect(e.humanCost[1]).toBeCloseTo(2200);
    expect(e.agentMinutes).toBeCloseTo(18.6, 1);
  });

  it("会议估算：三语需要 3 个语言方向、6 名译员；半天起算", () => {
    const m = estimateMeeting(1, 3);
    expect(m.interpreters).toBe(6);
    expect(m.cost).toEqual([1800, 3600]);
    expect(estimateMeeting(8, 2).cost).toEqual([1200, 2400]);
  });
});

describe("评测数据（landing-page：评测数据展示）", () => {
  it("至少 4 项，每项带出处", () => {
    expect(STATS.length).toBeGreaterThanOrEqual(4);
    expect(STATS.every((s) => s.source.startsWith("实验报告 §"))).toBe(true);
  });
});
