import { describe, expect, it } from "vitest";
import type { EngineInfo } from "@/lib/api/speech";
import { interpretWsUrl, isRoomCode } from "@/lib/api/interpret";
import {
  buildCreateRequest,
  engineListFor,
  halfDuplexEnabled,
  setupLanguages,
  isMeaningfulSpeech,
  shouldAutoInterrupt,
  supportsAutoConverse,
  validateSetup,
  type SetupInput,
} from "../setup";

const engine = (p: Partial<EngineInfo>): EngineInfo => ({
  id: "cascade",
  type: "interpret",
  name: "平台级联",
  vendor: "本平台",
  kind: "builtin",
  available: true,
  reason: null,
  languages: ["zh", "en", "ja", "ko"],
  modelConfigId: null,
  s2s: false,
  maxTargets: 5,
  autoConverse: true,
  ...p,
});

const base: SetupInput = {
  mode: "CONVERSE",
  engine: "cascade",
  listenTarget: "zh",
  converseA: "zh",
  converseB: "en",
  roomLang: "ja",
  chatMyLang: "zh",
  chatAiLang: "en",
  chatScenario: "travel",
  displayName: " 主持人 ",
  glossaryIds: [3],
  domainHint: "  ",
  gender: "male",
  tts: true,
  headphone: false,
  converseAuto: true,
};

describe("setup", () => {
  it("setupLanguages 按模式取语言", () => {
    expect(setupLanguages({ ...base, mode: "LISTEN" })).toEqual(["zh"]);
    expect(setupLanguages(base)).toEqual(["zh", "en"]);
    expect(setupLanguages({ ...base, mode: "ROOM" })).toEqual(["ja"]);
  });

  it("validateSetup：引擎不可用、语言相同、引擎不支持的语言", () => {
    expect(validateSetup(base, undefined)).toBe("请选择同传引擎");
    expect(validateSetup(base, engine({ available: false, reason: "未配置密钥" }))).toBe("未配置密钥");
    expect(validateSetup({ ...base, converseB: "zh" }, engine({}))).toBe("双向对话的两种语言必须不同");
    expect(validateSetup({ ...base, converseB: "fr" }, engine({}))).toContain("不支持");
    expect(validateSetup(base, engine({}))).toBeNull();
  });

  it("S2S 引擎不支持自动对话，创建请求改为按键说话", () => {
    const s2s = engine({ id: "qwen-livetranslate", s2s: true, autoConverse: false });
    expect(supportsAutoConverse(s2s)).toBe(false);
    expect(buildCreateRequest(base, s2s).converseRouting).toBe("ptt");
    expect(buildCreateRequest(base, engine({})).converseRouting).toBe("auto");
    expect(buildCreateRequest({ ...base, converseAuto: false }, engine({})).converseRouting).toBe("ptt");
  });

  it("buildCreateRequest 字段与契约一致", () => {
    const req = buildCreateRequest({ ...base, mode: "ROOM" }, engine({}));
    expect(req).toMatchObject({
      mode: "ROOM",
      engine: "cascade",
      languages: ["ja"],
      converseRouting: undefined,
      glossaryIds: [3],
      domainHint: null,
      tts: true,
      headphone: true,
      gender: "male",
      displayName: "主持人",
    });
  });

  it("半双工仅在单设备模式且未开耳机时启用", () => {
    expect(halfDuplexEnabled("LISTEN", false)).toBe(true);
    expect(halfDuplexEnabled("CONVERSE", true)).toBe(false);
    expect(halfDuplexEnabled("ROOM", false)).toBe(false);
  });

  it("interpretWsUrl 把 http(s) 换成 ws(s)", () => {
    expect(interpretWsUrl("abc", "/ws/interpret", "http://localhost:8080")).toBe("ws://localhost:8080/ws/interpret?ticket=abc");
    expect(interpretWsUrl("a+b", "/ws/interpret", "https://api.example.com")).toBe("wss://api.example.com/ws/interpret?ticket=a%2Bb");
    expect(interpretWsUrl("t", "wss://x/ws")).toBe("wss://x/ws?ticket=t");
  });

  it("isRoomCode", () => {
    expect(isRoomCode("k7m2qx")).toBe(true);
    expect(isRoomCode("K7M2Q")).toBe(false);
    expect(isRoomCode("K7M2Q!")).toBe(false);
  });
});

describe("buildCreateRequest 翻译模型", () => {
  const base = {
    mode: "LISTEN" as const, engine: "cascade", listenTarget: "en", converseA: "zh", converseB: "en", roomLang: "zh",
    chatMyLang: "zh", chatAiLang: "en", chatScenario: "free" as const,
    displayName: "", glossaryIds: [], domainHint: "", gender: "female" as const, tts: true, headphone: false,
    converseAuto: true, mtModelConfigId: 7,
  };
  it("级联引擎带上所选翻译模型，S2S 引擎忽略", () => {
    expect(buildCreateRequest(base, null).modelConfigId).toBe(7);
    expect(buildCreateRequest({ ...base, engine: "qwen-livetranslate" }, null).modelConfigId).toBeNull();
    expect(buildCreateRequest({ ...base, mtModelConfigId: null }, null).modelConfigId).toBeNull();
  });
});

describe("AI 对话（add-ai-avatar-and-landing 5.2）", () => {
  const chat: SetupInput = { ...base, mode: "CHAT", chatMyLang: "zh", chatAiLang: "en", chatScenario: "travel" };
  it("语言为 [我的语言, 对话语言]，两者可以相同", () => {
    expect(setupLanguages(chat)).toEqual(["zh", "en"]);
    expect(validateSetup({ ...chat, chatAiLang: "zh" }, engine({}))).toBeNull();
  });
  it("只允许平台级联与实时语音模型", () => {
    expect(validateSetup({ ...chat, engine: "qwen-livetranslate" }, engine({ id: "qwen-livetranslate", s2s: true }))).toBe(
      "AI 对话仅支持平台级联或实时语音模型",
    );
    expect(validateSetup(chat, engine({}))).toBeNull();
    const rt = engine({ id: "realtime-chat", type: "chat", kind: "config", s2s: undefined });
    expect(validateSetup({ ...chat, engine: "realtime-chat" }, rt)).toBeNull();
    expect(validateSetup({ ...chat, engine: "realtime-chat" }, { ...rt, available: false, reason: "未配置实时语音对话模型" })).toBe(
      "未配置实时语音对话模型",
    );
  });
  it("实时语音模型：不带术语库、回复模型与响应速度；级联带响应速度", () => {
    const rt = engine({ id: "realtime-chat" });
    const req = buildCreateRequest({ ...chat, engine: "realtime-chat", glossaryIds: [3], mtModelConfigId: 7, latencyMode: "fast" }, rt);
    expect(req).toMatchObject({ engine: "realtime-chat", glossaryIds: [], modelConfigId: null, latencyMode: null });
    const cascade = buildCreateRequest({ ...chat, latencyMode: "fast" }, engine({}));
    expect(cascade.latencyMode).toBe("fast");
    expect(buildCreateRequest(chat, engine({})).latencyMode).toBe("balanced");
  });
  it("engineListFor：AI 对话取 chat 类别，缺失时回退为级联；其他模式取 interpret", () => {
    const interpret = [engine({}), engine({ id: "qwen-livetranslate", s2s: true })];
    const chatList = [engine({ id: "cascade", type: "chat" }), engine({ id: "realtime-chat", type: "chat" })];
    const engines = { asr: [], tts: [], interpret, image: [], chat: chatList };
    expect(engineListFor("CHAT", engines).map((e) => e.id)).toEqual(["cascade", "realtime-chat"]);
    expect(engineListFor("CHAT", { ...engines, chat: undefined }).map((e) => e.id)).toEqual(["cascade"]);
    expect(engineListFor("LISTEN", engines)).toBe(interpret);
    expect(engineListFor("LISTEN", null)).toEqual([]);
  });
  it("创建请求带场景、不带对话路由；其他模式不带场景", () => {
    const req = buildCreateRequest(chat, engine({}));
    expect(req).toMatchObject({ mode: "CHAT", languages: ["zh", "en"], chatScenario: "travel" });
    expect(req.converseRouting).toBeUndefined();
    expect(buildCreateRequest({ ...chat, mode: "LISTEN" }, engine({})).chatScenario).toBeNull();
  });
  it("单设备未开耳机时半双工", () => {
    expect(halfDuplexEnabled("CHAT", false)).toBe(true);
    expect(halfDuplexEnabled("CHAT", true)).toBe(false);
  });
});

describe("shouldAutoInterrupt（AI 对话打断）", () => {
  const on = { mode: "CHAT" as const, role: "user" as const, headphone: true, playing: true, text: "等一下" };
  it("耳机模式、AI 播报中、用户开口时自动打断", () => {
    expect(shouldAutoInterrupt(on)).toBe(true);
    expect(shouldAutoInterrupt({ ...on, role: undefined })).toBe(true);
  });
  it("半双工、未在播报、AI 自己的事件、其他模式都不打断", () => {
    expect(shouldAutoInterrupt({ ...on, headphone: false })).toBe(false);
    expect(shouldAutoInterrupt({ ...on, playing: false })).toBe(false);
    expect(shouldAutoInterrupt({ ...on, role: "assistant" })).toBe(false);
    expect(shouldAutoInterrupt({ ...on, mode: "CONVERSE" })).toBe(false);
  });
});

describe("isMeaningfulSpeech（插话与让位的门槛，improve-speech-endpointing-and-live-ux 4.4）", () => {
  it.each([
    ["嗯", false],
    ["嗯……", false],
    ["那个，啊", false],
    ["um", false],
    ["Uh, hmm.", false],
    ["a", false],
    ["", false],
    ["等一下", true],
    ["好的", true],
    ["嗯，好的", true],
    ["OK", true],
    ["wait", true],
    ["3", true],
    ["えーと", false],
    ["すみません", true],
  ])("%s → %s", (text, expected) => {
    expect(isMeaningfulSpeech(text)).toBe(expected);
  });

  it("咳嗽或语气词不触发插话", () => {
    const on = { mode: "CHAT" as const, role: "user" as const, headphone: true, playing: true };
    expect(shouldAutoInterrupt({ ...on, text: "嗯" })).toBe(false);
    expect(shouldAutoInterrupt({ ...on, text: "um" })).toBe(false);
    expect(shouldAutoInterrupt({ ...on, text: "等一下" })).toBe(true);
  });
});
