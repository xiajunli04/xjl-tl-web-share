import { describe, expect, it } from "vitest";
import type { InterpretEndVO } from "@/lib/api/interpret";
import type { InterpretSegmentVO } from "@/lib/api/interpret-history";
import { DEFAULT_SETUP } from "@/stores/interpret-store";
import { reduceLive, initialLiveState } from "../reducer";
import { elapsedLabel, segmentsToEvents, setupFromSession } from "../resume";

const session = (p: Partial<InterpretEndVO>): InterpretEndVO => ({
  id: 7,
  mode: "CONVERSE",
  engine: "cascade",
  languages: ["zh", "en"],
  roomCode: null,
  status: "ACTIVE",
  title: "双向对话 · 中文 ⇄ 英语",
  startedAt: "2026-10-05T08:00:00Z",
  endedAt: null,
  durationMs: null,
  stats: null,
  favorite: false,
  options: { converseRouting: "ptt", glossaryIds: [3], domainHint: "旅游", tts: false, headphone: true, gender: "male", ttsEngine: null, modelConfigId: 7 },
  ...p,
});

describe("setupFromSession", () => {
  it("还原模式、语言与创建时的选项", () => {
    const s = setupFromSession(session({}), DEFAULT_SETUP);
    expect(s).toMatchObject({
      mode: "CONVERSE", engine: "cascade", converseA: "zh", converseB: "en", converseAuto: false,
      glossaryIds: [3], domainHint: "旅游", tts: false, headphone: true, gender: "male", mtModelConfigId: 7,
    });
  });
  it("收听与会议室取 languages[0]，缺少 options 时沿用默认", () => {
    expect(setupFromSession(session({ mode: "LISTEN", languages: ["en"], options: null }), DEFAULT_SETUP)).toMatchObject({
      mode: "LISTEN", listenTarget: "en", tts: DEFAULT_SETUP.tts,
    });
    expect(setupFromSession(session({ mode: "ROOM", languages: ["ja"] }), DEFAULT_SETUP).roomLang).toBe("ja");
  });
});

describe("segmentsToEvents", () => {
  const seg = (seq: number, text: string, en: string): InterpretSegmentVO => ({
    seq, speakerParticipant: "p1", speakerName: "我", sourceLang: "zh", sourceText: text,
    translations: { en }, metrics: null, startedMs: seq * 1000, endedMs: seq * 1000 + 800,
  });
  it("按 seq 回放为原文与译文定稿，可被 reducer 归并", () => {
    const events = segmentsToEvents([seg(2, "第二句", "Second"), seg(1, "第一句", "First")]);
    expect(events.map((e) => e.type)).toEqual(["transcript.final", "translation.final", "transcript.final", "translation.final"]);
    const live = events.reduce((s, e) => reduceLive(s, e), initialLiveState());
    expect(JSON.stringify(live)).toContain("第一句");
    expect(JSON.stringify(live)).toContain("Second");
  });
});

describe("elapsedLabel", () => {
  const t0 = Date.parse("2026-10-05T08:00:00Z");
  it("分钟与小时", () => {
    expect(elapsedLabel(t0, t0 + 20_000)).toBe("刚刚开始");
    expect(elapsedLabel(t0, t0 + 5 * 60_000)).toBe("已进行 5 分钟");
    expect(elapsedLabel(t0, t0 + 75 * 60_000)).toBe("已进行 1 小时 15 分钟");
  });
});
