import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/http";
import type { InterpretJoinVO } from "@/lib/api/interpret";
import { MockInterpretSocket, mockInterpret, mockMicLevel } from "@/lib/mock/interpret";
import { InterpretConnection } from "../connection";
import type { ServerEvent } from "../protocol";
import { awaitingReply, initialLiveState, reduceLive, textIn } from "../reducer";

async function create(body: object) {
  return mockInterpret<InterpretJoinVO>("/api/interpret/sessions", { method: "POST", body });
}

function drive(join: InterpretJoinVO) {
  const events: ServerEvent[] = [];
  const conn = new InterpretConnection({
    createSocket: (url) => new MockInterpretSocket(url),
    buildUrl: (t) => `ws://mock/ws/interpret?ticket=${t}`,
    renewTicket: async () => (await mockInterpret<InterpretJoinVO>(`/api/interpret/sessions/${join.sessionId}/ticket`, { method: "POST" })).wsTicket,
    onEvent: (e) => events.push(e),
  });
  conn.connect(join.wsTicket);
  return { conn, events };
}

describe("同传 mock", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("创建会话的校验：不可用引擎 C0173、对话语言相同 A0410、S2S + 自动 A0410", async () => {
    await expect(create({ mode: "LISTEN", engine: "openai-realtime", languages: ["zh"] })).rejects.toMatchObject({ code: "C0173" });
    await expect(create({ mode: "CONVERSE", engine: "cascade", languages: ["en", "en"] })).rejects.toMatchObject({ code: "A0410" });
    await expect(create({ mode: "CONVERSE", engine: "qwen-livetranslate", languages: ["zh", "en"], converseRouting: "auto" })).rejects.toBeInstanceOf(ApiError);
  });

  it("加入房间：000000 不存在、999999 已满、其他房间码可加入", async () => {
    const join = (code: string) => mockInterpret<InterpretJoinVO>(`/api/interpret/rooms/${code}/join`, { method: "POST", body: { displayName: "Emma", lang: "en" } });
    await expect(join("000000")).rejects.toMatchObject({ code: "A0452" });
    await expect(join("999999")).rejects.toMatchObject({ code: "A0451" });
    const vo = await join("K7M2QX");
    expect(vo).toMatchObject({ mode: "ROOM", roomCode: "K7M2QX", isHost: false, languages: ["en"] });
  });

  it("收听脚本：partial → final → 译文 → audio → metrics，按句归并后目标语有译文", async () => {
    const join = await create({ mode: "LISTEN", engine: "cascade", languages: ["zh"], tts: true });
    const { conn, events } = drive(join);
    await vi.advanceTimersByTimeAsync(12_000);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("ready");
    const firstFinal = types.indexOf("transcript.final");
    expect(types.indexOf("transcript.partial")).toBeLessThan(firstFinal);
    expect(types.indexOf("translation.final")).toBeGreaterThan(firstFinal);
    expect(types).toContain("audio");
    expect(types).toContain("metrics");
    const state = events.reduce((s, e) => reduceLive(s, e), initialLiveState());
    const u = state.utterances[0];
    expect(u.lang).toBe("en");
    expect(textIn(u, "zh").text).toBe("大家早上好，欢迎来到我们的产品发布会。");
    expect(state.lastE2eMs).toBeGreaterThan(1000);
    conn.close();
  });

  it("会议室脚本：成员陆续加入，消息带发言人且包含多语译文；结束时下发 ended", async () => {
    const join = await create({ mode: "ROOM", engine: "cascade", languages: ["zh"], displayName: "主持人" });
    expect(join.roomCode).toMatch(/^[A-Z0-9]{6}$/);
    const { conn, events } = drive(join);
    await vi.advanceTimersByTimeAsync(20_000);
    const parts = events.filter((e): e is Extract<ServerEvent, { type: "participants" }> => e.type === "participants");
    expect(parts.length).toBeGreaterThan(2);
    expect(Math.max(...parts.map((p) => p.list.length))).toBe(4);
    const finals = events.filter((e): e is Extract<ServerEvent, { type: "translation.final" }> => e.type === "translation.final");
    expect(new Set(finals.map((f) => f.lang)).size).toBeGreaterThan(1);
    expect(finals.every((f) => f.speaker?.participantId)).toBe(true);
    conn.send({ type: "end" });
    await vi.advanceTimersByTimeAsync(200);
    expect(events.at(-1)?.type).toBe("ended");
  });

  it("按键对话：按下后松开才产生该侧语言的句子", async () => {
    const join = await create({ mode: "CONVERSE", engine: "qwen-livetranslate", languages: ["zh", "en"], converseRouting: "ptt" });
    const { conn, events } = drive(join);
    await vi.advanceTimersByTimeAsync(3000);
    expect(events.filter((e) => e.type === "transcript.final")).toHaveLength(0);
    conn.send({ type: "ptt", side: "B" });
    expect(mockMicLevel()).toBeGreaterThan(0.02);
    conn.send({ type: "ptt", side: null });
    await vi.advanceTimersByTimeAsync(4000);
    const final = events.find((e): e is Extract<ServerEvent, { type: "transcript.final" }> => e.type === "transcript.final");
    expect(final?.lang).toBe("en");
    expect(events.some((e) => e.type === "translation.final" && e.lang === "zh")).toBe(true);
    conn.close();
  });
  it("AI 对话：只允许级联引擎；AI 先开口、带 role 与母语字幕；打断后标记已打断并继续对话", async () => {
    await expect(create({ mode: "CHAT", engine: "qwen-livetranslate", languages: ["zh", "en"] })).rejects.toMatchObject({ code: "A0410" });
    const join = await create({ mode: "CHAT", engine: "cascade", languages: ["zh", "en"], tts: true, chatScenario: "restaurant" });
    const { conn, events } = drive(join);
    // 开场白：0.7 s 后开始，思考 1.1 s
    await vi.advanceTimersByTimeAsync(1500);
    let state = events.reduce((st, e) => reduceLive(st, e), initialLiveState());
    expect(awaitingReply(state, "CHAT")).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    state = events.reduce((st, e) => reduceLive(st, e), initialLiveState());
    const greet = state.utterances[0];
    expect(greet.role).toBe("assistant");
    expect(greet.speaker?.displayName).toBe("Lumi");
    expect(greet.lang).toBe("en");
    expect(textIn(greet, "zh").text).toContain("欢迎光临");
    expect(events.some((e) => e.type === "audio" && e.role === "assistant")).toBe(true);

    // 第二轮 AI 回复中途打断
    await vi.advanceTimersByTimeAsync(12_000);
    const replyStarted = () => events.filter((e) => e.type === "transcript.partial" && e.role === "assistant").length;
    const before = replyStarted();
    while (replyStarted() === before) await vi.advanceTimersByTimeAsync(100);
    conn.send({ type: "interrupt" });
    await vi.advanceTimersByTimeAsync(10);
    state = events.reduce((st, e) => reduceLive(st, e), initialLiveState());
    const cut = state.utterances.filter((u) => u.role === "assistant").at(-1)!;
    expect(cut.interrupted).toBe(true);
    expect(cut.sourceFinal).toBe(true);
    const user = state.utterances.find((u) => u.role === "user");
    expect(user?.lang).toBe("zh");
    expect(Object.keys(user?.translations ?? {})).toEqual([]);
    conn.close();
  });
});
