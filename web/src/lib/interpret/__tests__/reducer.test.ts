import { describe, expect, it } from "vitest";
import type { ServerEvent } from "../protocol";
import { parseServerEvent } from "../protocol";
import {
  awaitingReply,
  converseTarget,
  formatDuration,
  formatLatency,
  initialLiveState,
  MAX_UTTERANCES,
  reduceLive,
  stageStatus,
  summarize,
  textIn,
  isDisplayable,
  liveState,
  visibleText,
  type LiveState,
} from "../reducer";

const speaker = { participantId: "p1", displayName: "主持人", lang: "zh" };

function run(events: ServerEvent[], from: LiveState = initialLiveState()) {
  return events.reduce((s, e) => reduceLive(s, e, 1000), from);
}

describe("reduceLive：按 utteranceId 归并", () => {
  it("一句话的完整事件序列：partial → final → 多语 delta/final → metrics", () => {
    const s = run([
      { type: "transcript.partial", utteranceId: "p1:1", speaker, text: "大家" },
      { type: "transcript.partial", utteranceId: "p1:1", speaker, text: "大家好" },
      { type: "transcript.final", utteranceId: "p1:1", speaker, text: "大家好。", lang: "zh", startedMs: 100, endedMs: 900 },
      { type: "translation.delta", utteranceId: "p1:1", speaker, lang: "en", delta: "Hello " },
      { type: "translation.delta", utteranceId: "p1:1", speaker, lang: "ja", delta: "皆さん" },
      { type: "translation.delta", utteranceId: "p1:1", speaker, lang: "en", delta: "everyone" },
      { type: "translation.final", utteranceId: "p1:1", speaker, lang: "en", text: "Hello everyone.", ttsFallback: false },
      { type: "translation.final", utteranceId: "p1:1", speaker, lang: "ja", text: "皆さん、こんにちは。", ttsFallback: true },
      { type: "metrics", utteranceId: "p1:1", speaker, asrMs: 300, mtFirstMs: 200, mtMs: 600, ttsFirstMs: 400, e2eMs: 2400 },
    ]);
    expect(s.utterances).toHaveLength(1);
    const u = s.utterances[0];
    expect(u).toMatchObject({ id: "p1:1", source: "大家好。", sourceFinal: true, lang: "zh", startedMs: 100, endedMs: 900, receivedAt: 1000 });
    expect(u.speaker).toEqual(speaker);
    expect(u.translations.en).toEqual({ text: "Hello everyone.", final: true, ttsFallback: false });
    expect(u.translations.ja.ttsFallback).toBe(true);
    expect(u.metrics?.e2eMs).toBe(2400);
    expect(s.lastE2eMs).toBe(2400);
  });

  it("多句交错到达时各自归并，顺序按首次出现", () => {
    const s = run([
      { type: "transcript.partial", utteranceId: 1, text: "a" },
      { type: "transcript.partial", utteranceId: 2, text: "b" },
      { type: "transcript.final", utteranceId: 1, text: "A", lang: "en" },
      { type: "translation.delta", utteranceId: 2, lang: "zh", delta: "乙" },
    ]);
    expect(s.utterances.map((u) => u.id)).toEqual(["1", "2"]);
    expect(s.utterances[0].source).toBe("A");
    expect(s.utterances[1].translations.zh.text).toBe("乙");
  });

  it("final 之后到达的迟到 partial / delta 被忽略", () => {
    const s = run([
      { type: "transcript.final", utteranceId: "x", text: "Done", lang: "en" },
      { type: "transcript.partial", utteranceId: "x", text: "Do" },
      { type: "translation.final", utteranceId: "x", lang: "zh", text: "完成" },
      { type: "translation.delta", utteranceId: "x", lang: "zh", delta: "多余" },
    ]);
    expect(s.utterances[0].source).toBe("Done");
    expect(s.utterances[0].translations.zh.text).toBe("完成");
  });

  it("metrics 累计平均延迟；e2eMs 为 null 不计入", () => {
    const s = run([
      { type: "metrics", utteranceId: 1, e2eMs: 2000 },
      { type: "metrics", utteranceId: 2, e2eMs: 3000 },
      { type: "metrics", utteranceId: 3, e2eMs: null },
    ]);
    expect(s.e2eCount).toBe(2);
    expect(s.e2eSum).toBe(5000);
    expect(s.lastE2eMs).toBe(3000);
  });

  it("participants / error / ended / ready", () => {
    let s = run([
      { type: "participants", list: [{ participantId: "p1", displayName: "A", lang: "zh", speaking: true }] },
      { type: "error", code: "C0174", message: "上游中断", fatal: false },
    ]);
    expect(s.participants).toHaveLength(1);
    expect(s.error?.code).toBe("C0174");
    // 重连后 ready 清除非致命错误
    s = run([{ type: "ready", engine: "cascade" }], s);
    expect(s.error).toBeNull();
    s = run([{ type: "ended", reason: "host_left", stats: { utterances: 3 } }], s);
    expect(s.ended).toEqual({ reason: "host_left", stats: { utterances: 3 } });
  });

  it("audio / pong 不改变状态", () => {
    const s0 = initialLiveState();
    expect(reduceLive(s0, { type: "pong" })).toBe(s0);
  });

  it(`最多保留 ${MAX_UTTERANCES} 句`, () => {
    const events: ServerEvent[] = Array.from({ length: MAX_UTTERANCES + 5 }, (_, i) => ({ type: "transcript.final", utteranceId: i, text: String(i), lang: "en" }));
    const s = run(events);
    expect(s.utterances).toHaveLength(MAX_UTTERANCES);
    expect(s.utterances[0].id).toBe("5");
  });
});

describe("派生", () => {
  const s = run([
    { type: "transcript.final", utteranceId: 1, text: "你好", lang: "zh" },
    { type: "translation.final", utteranceId: 1, lang: "en", text: "Hello" },
    { type: "transcript.final", utteranceId: 2, text: "早晨", lang: "yue" },
  ]);

  it("textIn：源语种等于目标时显示原文（yue 视为 zh）", () => {
    expect(textIn(s.utterances[0], "en")).toEqual({ text: "Hello", final: true, isSource: false });
    expect(textIn(s.utterances[0], "zh")).toEqual({ text: "你好", final: true, isSource: true });
    expect(textIn(s.utterances[1], "zh").isSource).toBe(true);
    expect(textIn(s.utterances[1], "ja").text).toBe("");
  });

  it("converseTarget：按识别语种取另一侧", () => {
    expect(converseTarget(s.utterances[0], ["zh", "en"])).toBe("en");
    expect(converseTarget(s.utterances[0], ["en", "zh"])).toBe("en");
  });

  it("stageStatus：播报 > 识别 > 翻译 > 聆听 / 暂停", () => {
    expect(stageStatus(s, { playing: true, muted: false })).toBe("speaking");
    const partial = run([{ type: "transcript.partial", utteranceId: 9, text: "abc" }]);
    expect(stageStatus(partial, { playing: false, muted: false })).toBe("recognizing");
    const translating = run([{ type: "transcript.final", utteranceId: 9, text: "abc", lang: "en" }]);
    expect(stageStatus(translating, { playing: false, muted: false, lang: "zh" })).toBe("translating");
    // 源语种即目标：无需翻译
    expect(stageStatus(translating, { playing: false, muted: false, lang: "en" })).toBe("listening");
    expect(stageStatus(initialLiveState(), { playing: false, muted: true })).toBe("paused");
  });

  it("formatLatency / formatDuration", () => {
    expect(formatLatency(2400)).toBe("2.4 s");
    expect(formatLatency(null)).toBe("--");
    expect(formatDuration(65_000)).toBe("01:05");
    expect(formatDuration(3_725_000)).toBe("1:02:05");
  });

  it("summarize：服务端统计优先，缺失项用本地补齐", () => {
    const st = run([
      { type: "transcript.final", utteranceId: 1, text: "a", lang: "en" },
      { type: "metrics", utteranceId: 1, e2eMs: 2000 },
      { type: "transcript.final", utteranceId: 2, text: "b", lang: "en" },
      { type: "metrics", utteranceId: 2, e2eMs: 3000 },
    ]);
    expect(summarize(st, 0, 60_000)).toEqual({ durationMs: 60_000, utterances: 2, avgE2eMs: 2500 });
    expect(summarize(st, 0, 60_000, { utterances: 5 })).toEqual({ durationMs: 60_000, utterances: 5, avgE2eMs: 2500 });
  });
});

describe("parseServerEvent", () => {
  it("解析已知事件，忽略未知类型与非法 JSON", () => {
    expect(parseServerEvent('{"type":"metrics","utteranceId":"p1:1","e2eMs":1}')?.type).toBe("metrics");
    expect(parseServerEvent('{"type":"unknown"}')).toBeNull();
    expect(parseServerEvent("not json")).toBeNull();
  });
});

describe("AI 对话的角色与打断（add-ai-avatar-and-landing 5.1）", () => {
  const ai = { participantId: "ai", displayName: "Lumi", lang: "en" };
  it("role=assistant 的事件归为 AI 句，打断后定稿并标记", () => {
    let s = initialLiveState();
    s = reduceLive(s, { type: "transcript.final", utteranceId: "p1:1", text: "我想点菜", lang: "zh" });
    expect(s.utterances[0].role).toBe("user");
    expect(awaitingReply(s, "CHAT")).toBe(true);
    s = reduceLive(s, { type: "transcript.partial", utteranceId: "p1:2", speaker: ai, role: "assistant", text: "Sure, what" });
    expect(s.utterances[1]).toMatchObject({ role: "assistant", source: "Sure, what", sourceFinal: false });
    expect(awaitingReply(s, "CHAT")).toBe(false);
    s = reduceLive(s, { type: "reply.interrupted", utteranceId: "p1:2", speaker: ai, role: "assistant", text: "Sure, what" });
    expect(s.utterances[1]).toMatchObject({ interrupted: true, sourceFinal: true, source: "Sure, what" });
  });

  it("AI 回复的 ttsFallback 记录在原文上；其他模式的等待判定沿用翻译状态", () => {
    let s = initialLiveState();
    s = reduceLive(s, { type: "transcript.final", utteranceId: "p1:3", role: "assistant", text: "Hi", lang: "en", ttsFallback: true });
    expect(s.utterances[0].sourceTtsFallback).toBe(true);
    let c = initialLiveState();
    c = reduceLive(c, { type: "transcript.final", utteranceId: "p1:1", text: "你好", lang: "zh" });
    expect(awaitingReply(c, "CONVERSE")).toBe(true);
    c = reduceLive(c, { type: "translation.final", utteranceId: "p1:1", lang: "en", text: "Hello" });
    c = reduceLive(c, { type: "metrics", utteranceId: "p1:1", e2eMs: 1200 });
    expect(awaitingReply(c, "CONVERSE")).toBe(false);
  });
});

describe("实时字幕渲染规则（improve-speech-endpointing-and-live-ux 4.2）", () => {
  it("partial → discard：不残留任何语句", () => {
    const s = run([
      { type: "transcript.partial", utteranceId: "p1:1", speaker, text: "嗯", hold: true },
      { type: "transcript.discard", utteranceId: "p1:1", speaker },
    ]);
    expect(s.utterances).toEqual([]);
  });

  it("hold 标记随 partial 更新，定稿后清除", () => {
    let s = run([{ type: "transcript.partial", utteranceId: "p1:1", speaker, text: "我想问一下", hold: true }]);
    expect(s.utterances[0].hold).toBe(true);
    expect(liveState(s.utterances[0])).toBe("hold");
    s = run([{ type: "transcript.partial", utteranceId: "p1:1", speaker, text: "我想问一下这个" }], s);
    expect(s.utterances[0].hold).toBe(false);
    expect(liveState(s.utterances[0])).toBe("live");
    s = run([{ type: "transcript.final", utteranceId: "p1:1", speaker, text: "我想问一下这个。", lang: "zh" }], s);
    expect(s.utterances[0].hold).toBe(false);
    expect(liveState(s.utterances[0])).toBeNull();
  });

  it("撤回 AI 回复（让位）", () => {
    const s = run([
      { type: "transcript.final", utteranceId: "p1:1", speaker, text: "我想订一张", lang: "zh" },
      { type: "transcript.partial", utteranceId: "p1:2", role: "assistant", text: "Sure" },
      { type: "transcript.discard", utteranceId: "p1:2", role: "assistant" },
    ]);
    expect(s.utterances.map((u) => u.id)).toEqual(["p1:1"]);
  });

  it("迟到的用户转写排在它触发的 AI 回复之前", () => {
    const s = run([
      { type: "transcript.partial", utteranceId: "p1:6", role: "assistant", text: "Hi" },
      { type: "transcript.final", utteranceId: "p1:6", role: "assistant", text: "Hi there", lang: "en" },
      { type: "transcript.final", utteranceId: "p1:5", speaker, text: "你好", lang: "zh" },
    ]);
    expect(s.utterances.map((u) => u.id)).toEqual(["p1:5", "p1:6"]);
  });

  it("不同发言流按到达顺序；无法解析的 id 追加", () => {
    const s = run([
      { type: "transcript.final", utteranceId: "p2:3", text: "B", lang: "en" },
      { type: "transcript.final", utteranceId: "p1:1", text: "A", lang: "zh" },
      { type: "transcript.final", utteranceId: 7, text: "C", lang: "zh" },
    ]);
    expect(s.utterances.map((u) => u.id)).toEqual(["p2:3", "p1:1", "7"]);
  });

  it("过期收尾：移除没有译文的未定稿句，冻结已有译文的句子", () => {
    const s = run([
      { type: "transcript.partial", utteranceId: "p1:1", speaker, text: "咳" },
      { type: "transcript.partial", utteranceId: "p1:2", speaker, text: "大家" },
      { type: "translation.delta", utteranceId: "p1:2", speaker, lang: "en", delta: "Every" },
      { type: "transcript.partial", utteranceId: "p2:1", text: "Hi" },
      { type: "transcript.final", utteranceId: "p1:3", speaker, text: "下一句。", lang: "zh" },
    ]);
    expect(s.utterances.map((u) => u.id)).toEqual(["p1:2", "p2:1", "p1:3"]);
    expect(s.utterances[0].sourceFinal).toBe(true);
    expect(s.utterances[1].sourceFinal).toBe(false); // 其他发言流不受影响
  });

  it("isDisplayable / visibleText：没有文字的语句不渲染", () => {
    const s = run([
      { type: "metrics", utteranceId: "p1:1", e2eMs: 100 },
      { type: "transcript.partial", utteranceId: "p1:2", speaker, text: "你好" },
    ]);
    const [ghost, partial] = s.utterances;
    expect(isDisplayable(ghost)).toBe(false);
    expect(isDisplayable(ghost, "en")).toBe(false);
    expect(isDisplayable(partial, "en")).toBe(true); // 译文未到时先显示原文
    expect(visibleText(partial, "en")).toBe("你好");
  });

  it("metrics 记录 holdMs", () => {
    const s = run([{ type: "metrics", utteranceId: "p1:1", e2eMs: 1500, holdMs: 700 }]);
    expect(s.utterances[0].metrics?.holdMs).toBe(700);
  });

  it("解析 transcript.discard", () => {
    expect(parseServerEvent('{"type":"transcript.discard","utteranceId":"p1:1"}')?.type).toBe("transcript.discard");
  });
});
