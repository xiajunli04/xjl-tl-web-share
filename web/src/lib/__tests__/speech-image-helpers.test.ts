import { describe, expect, it } from "vitest";
import {
  ALLOWED_PROVIDERS,
  coerceProvider,
  extraToRows,
  groupByCapability,
  isAllowedCombination,
  presetOf,
  rowsToExtra,
  validateBaseUrl,
  validateExtraRows,
} from "@/lib/model-capability";
import {
  averageE2e,
  formatDuration,
  formatOffset,
  segmentMatches,
  segmentText,
  sessionLanguages,
  type InterpretSegmentVO,
} from "@/lib/api/interpret-history";
import { ASK_HISTORY_LIMIT, toAskEvent, trimHistory } from "@/lib/api/insights";
import { adoptTranslation, initialRunState, type RunState } from "@/lib/translation-run";
import type { FinalEventData } from "@/lib/api/translate";

describe("模型配置：能力与提供方组合（D12）", () => {
  it("合法组合", () => {
    expect(isAllowedCombination("CHAT", "ANTHROPIC")).toBe(true);
    expect(isAllowedCombination("TTS", "OPENAI_COMPATIBLE")).toBe(true);
    expect(isAllowedCombination("REALTIME_TRANSLATE", "VOLCENGINE")).toBe(true);
    expect(isAllowedCombination("IMAGE_TRANSLATE", "DASHSCOPE")).toBe(true);
    expect(isAllowedCombination("REALTIME_CHAT", "DASHSCOPE")).toBe(true);
    expect(isAllowedCombination("REALTIME_CHAT", "OPENAI_COMPATIBLE")).toBe(true);
  });
  it("非法组合", () => {
    expect(isAllowedCombination("TTS", "ANTHROPIC")).toBe(false);
    expect(isAllowedCombination("CHAT", "DASHSCOPE")).toBe(false);
    expect(isAllowedCombination("IMAGE_TRANSLATE", "OPENAI_COMPATIBLE")).toBe(false);
    expect(isAllowedCombination("ASR", "GOOGLE")).toBe(false);
    expect(isAllowedCombination("REALTIME_CHAT", "VOLCENGINE")).toBe(false);
  });
  it("切换能力时提供方仍合法则保留，否则取第一个允许值", () => {
    expect(coerceProvider("REALTIME_TRANSLATE", "OPENAI_COMPATIBLE")).toBe("OPENAI_COMPATIBLE");
    expect(coerceProvider("IMAGE_TRANSLATE", "ANTHROPIC")).toBe("DASHSCOPE");
    expect(coerceProvider("REALTIME_TRANSLATE", "ANTHROPIC")).toBe(ALLOWED_PROVIDERS.REALTIME_TRANSLATE[0]);
  });
  it("预设：同传给出 wss 地址与音色建议", () => {
    const p = presetOf("REALTIME_TRANSLATE", "DASHSCOPE");
    expect(p.baseUrl.startsWith("wss://")).toBe(true);
    expect(p.extraKeys?.[0].key).toBe("voice");
    expect(presetOf("REALTIME_TRANSLATE", "VOLCENGINE").extraKeys?.map((k) => k.key)).toContain("appId");
  });
  it("baseUrl：只有实时同传允许 ws(s)", () => {
    expect(validateBaseUrl("wss://dashscope.aliyuncs.com/api-ws/v1/realtime", "REALTIME_TRANSLATE")).toBeNull();
    expect(validateBaseUrl("wss://x.com", "TTS")).toMatch(/只有实时同传/);
    expect(validateBaseUrl("wss://dashscope.aliyuncs.com/api-ws/v1/realtime", "REALTIME_CHAT")).toBeNull();
    expect(validateBaseUrl("https://api.openai.com/v1", "ASR")).toBeNull();
    expect(validateBaseUrl("ftp://x", "CHAT")).toMatch(/http/);
    expect(validateBaseUrl("not a url", "CHAT")).toMatch(/合法/);
    expect(validateBaseUrl("", "CHAT")).toMatch(/请输入/);
  });
});

describe("额外参数键值对", () => {
  it("rows ↔ extra 往返，忽略空行并去除空白", () => {
    expect(extraToRows({ voice: "Tina" })).toEqual([{ key: "voice", value: "Tina" }]);
    expect(rowsToExtra([{ key: " voice ", value: " Tina " }, { key: "", value: "" }])).toEqual({ voice: "Tina" });
    expect(rowsToExtra([{ key: "", value: "" }])).toBeUndefined();
  });
  it("校验：缺键名、非法键名、重复、疑似密钥", () => {
    const errors = validateExtraRows([
      { key: "voice", value: "Tina" },
      { key: "", value: "x" },
      { key: "1abc", value: "x" },
      { key: "voice", value: "y" },
      { key: "secretKey", value: "x" },
      { key: "", value: "" },
    ]);
    expect(errors[0]).toBeUndefined();
    expect(errors[1]).toMatch(/参数名/);
    expect(errors[2]).toMatch(/字母开头/);
    expect(errors[3]).toMatch(/重复/);
    expect(errors[4]).toMatch(/密钥/);
    expect(errors[5]).toBeUndefined();
  });
});

describe("列表按能力分组", () => {
  it("按能力顺序分组，组内默认在前、启用在前；缺省能力视为 CHAT", () => {
    const groups = groupByCapability([
      { id: 1, capability: "TTS", isDefault: false, enabled: true },
      { id: 2, isDefault: false, enabled: false },
      { id: 3, capability: "CHAT", isDefault: true, enabled: true },
      { id: 4, capability: "CHAT", isDefault: false, enabled: true },
    ] as never[]) as unknown as { capability: string; items: { id: number }[] }[];
    expect(groups.map((g) => g.capability)).toEqual(["CHAT", "TTS"]);
    expect(groups[0].items.map((x) => x.id)).toEqual([3, 4, 2]);
  });
});

const seg = (p: Partial<InterpretSegmentVO>): InterpretSegmentVO => ({
  seq: 1,
  speakerParticipant: "p1",
  speakerName: "A",
  sourceLang: "zh",
  sourceText: "大家好",
  translations: { en: "Hello everyone" },
  metrics: { e2eMs: 2000 },
  startedMs: 0,
  endedMs: 1000,
  ...p,
});

describe("同传历史工具", () => {
  it("formatDuration / formatOffset", () => {
    expect(formatDuration(65_000)).toBe("1:05");
    expect(formatDuration(3_723_000)).toBe("1:02:03");
    expect(formatDuration(null)).toBe("—");
    expect(formatOffset(125_400)).toBe("02:05");
  });
  it("segmentText：源语言显示原文，其他语言取译文，粤语视为中文", () => {
    expect(segmentText(seg({}), "zh")).toBe("大家好");
    expect(segmentText(seg({}), "en")).toBe("Hello everyone");
    expect(segmentText(seg({}), "ja")).toBeNull();
    expect(segmentText(seg({ sourceLang: "yue" }), "zh")).toBe("大家好");
  });
  it("segmentMatches 匹配原文或任一译文，不区分大小写", () => {
    expect(segmentMatches(seg({}), "hello")).toBe(true);
    expect(segmentMatches(seg({}), "大家")).toBe(true);
    expect(segmentMatches(seg({}), "bye")).toBe(false);
    expect(segmentMatches(seg({}), "  ")).toBe(true);
  });
  it("sessionLanguages 合并会话、统计与转写中的语言并去重", () => {
    const langs = sessionLanguages({ languages: ["zh"], stats: { languages: ["zh", "en"] } }, [
      seg({ sourceLang: "ja", translations: { zh: "…", en: "…" } }),
      seg({ sourceLang: "yue", translations: { en: "…" } }),
    ]);
    expect(langs).toEqual(["zh", "en", "ja"]);
  });
  it("averageE2e 忽略缺失指标", () => {
    expect(averageE2e([seg({ metrics: { e2eMs: 2000 } }), seg({ metrics: { e2eMs: 3000 } }), seg({ metrics: null })])).toBe(2500);
    expect(averageE2e([seg({ metrics: null })])).toBeNull();
  });
});

describe("解读", () => {
  it("trimHistory 只保留最近 6 轮有效问答", () => {
    const turns = Array.from({ length: 9 }, (_, i) => ({ q: `q${i}`, a: i === 8 ? "" : `a${i}` }));
    const h = trimHistory(turns);
    expect(h).toHaveLength(ASK_HISTORY_LIMIT);
    expect(h[0].q).toBe("q2");
    expect(h.at(-1)?.q).toBe("q7");
  });
  it("toAskEvent 只解析 delta / done / error", () => {
    expect(toAskEvent({ event: "delta", data: '{"text":"因为"}' })).toEqual({ event: "delta", data: { text: "因为" } });
    expect(toAskEvent({ event: "node", data: "{}" })).toBeNull();
  });

  const final = { translation: "下着倾盆大雨。", sourceLang: "en", targetLang: "zh" } as FinalEventData;
  const done: RunState = { ...initialRunState, status: "done", final };

  it("adoptTranslation：采用备选后替换译文并记录原译，seq 递增", () => {
    const p1 = adoptTranslation(done, "雨下得很大。")!;
    expect(p1.final?.translation).toBe("雨下得很大。");
    expect(p1.adopted).toEqual({ original: "下着倾盆大雨。", text: "雨下得很大。", seq: 1 });
    const s1 = { ...done, ...p1 };
    const p2 = adoptTranslation(s1, "外面大雨如注。")!;
    expect(p2.adopted).toEqual({ original: "下着倾盆大雨。", text: "外面大雨如注。", seq: 2 });
  });
  it("adoptTranslation：恢复原译；重复采用同一条或无 final 时不变", () => {
    const s1 = { ...done, ...adoptTranslation(done, "雨下得很大。")! };
    expect(adoptTranslation(s1, "雨下得很大。")).toBeNull();
    const back = adoptTranslation(s1, null)!;
    expect(back.final?.translation).toBe("下着倾盆大雨。");
    expect(back.adopted?.text).toBeNull();
    expect(adoptTranslation(done, null)).toBeNull();
    expect(adoptTranslation(initialRunState, "x")).toBeNull();
  });
});
