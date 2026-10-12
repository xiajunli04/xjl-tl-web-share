import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIRM_TERMS,
  DEFAULT_OPTIONS,
  DEFAULT_STRATEGY,
  PRESETS,
  STRATEGY_META,
  estimateGroups,
  estimateSeconds,
  isRecommended,
  normalizeOptions,
  presetLabel,
  presetOf,
} from "@/components/documents/meta";
import type { DocOptions } from "@/lib/api/documents";

/** 第五个参数为翻译记忆：消融组 D0–D6 关闭，推荐配置开启 */
const o = (c: boolean, s: boolean, t: boolean, r: boolean, m = false): DocOptions => ({
  contextWindow: c,
  globalSummary: s,
  termExtraction: t,
  review: r,
  translationMemory: m,
});

describe("新建任务默认值（与接口缺省值一致）", () => {
  it("混合策略、人工确认、评审关闭，其余四项（含翻译记忆）开启", () => {
    expect(DEFAULT_STRATEGY).toBe("hybrid");
    expect(DEFAULT_CONFIRM_TERMS).toBe(true);
    expect(DEFAULT_OPTIONS).toEqual(o(true, true, true, false, true));
  });

  it("默认值即「推荐」预设，混合策略卡片带推荐标识", () => {
    const p = presetOf(DEFAULT_OPTIONS, DEFAULT_STRATEGY);
    expect(p?.key).toBe("R");
    expect(isRecommended(p)).toBe(true);
    expect(presetLabel(p)).toBe("推荐配置");
    expect(STRATEGY_META.hybrid.recommended).toBe(true);
    expect(STRATEGY_META.serial.recommended).toBeFalsy();
    expect(STRATEGY_META.parallel.recommended).toBeFalsy();
  });
});

describe("presetOf · 预设识别", () => {
  it("预设分为推荐（R）与实验对照（D0–D6）两组，键唯一", () => {
    expect(PRESETS.filter((p) => p.group === "recommended").map((p) => p.key)).toEqual(["R"]);
    expect(PRESETS.filter((p) => p.group === "experiment").map((p) => p.key)).toEqual(["D0", "D1", "D2", "D3", "D4", "D5", "D6"]);
    expect(new Set(PRESETS.map((p) => p.key)).size).toBe(PRESETS.length);
  });

  it("任意两个预设的配置都不相同（识别结果唯一）", () => {
    for (const p of PRESETS) expect(presetOf(p.options, p.strategy)?.key).toBe(p.key);
  });

  it("同样四项开关：串行且关闭记忆识别为 D3、混合且开启记忆识别为推荐", () => {
    expect(presetOf(o(true, true, true, false), "serial")?.key).toBe("D3");
    expect(presetOf(o(true, true, true, false, true), "hybrid")?.key).toBe("R");
    // 混合 + 关闭记忆不再是推荐配置
    expect(presetOf(o(true, true, true, false, false), "hybrid")).toBeUndefined();
  });

  it("兼容旧数据：缺少 translationMemory 时按缺省值 true 识别", () => {
    const legacy = { contextWindow: true, globalSummary: true, termExtraction: true, review: false };
    expect(normalizeOptions(legacy).translationMemory).toBe(true);
    expect(presetOf(legacy, "hybrid")?.key).toBe("R");
    expect(normalizeOptions(null)).toEqual(DEFAULT_OPTIONS);
  });

  it("全部开启：串行 D4、并行 D5、混合 D6；D4 不再标注默认", () => {
    expect(presetOf(o(true, true, true, true), "serial")?.key).toBe("D4");
    expect(presetOf(o(true, true, true, true), "parallel")?.key).toBe("D5");
    expect(presetOf(o(true, true, true, true), "hybrid")?.key).toBe("D6");
    expect(PRESETS.find((p) => p.key === "D4")?.caption).not.toContain("默认");
  });

  it("不匹配任何预设时返回 undefined，展示为自定义", () => {
    const p = presetOf(o(false, true, false, true), "hybrid");
    expect(p).toBeUndefined();
    expect(presetLabel(p)).toBe("自定义");
    expect(presetLabel(PRESETS.find((x) => x.key === "D3"))).toBe("D3 · + 术语抽取");
  });
});

describe("estimateSeconds · 预估耗时", () => {
  it("评审会增加耗时", () => {
    expect(estimateSeconds(6, o(true, true, true, true), "serial")).toBeGreaterThan(
      estimateSeconds(6, o(true, true, true, false), "serial"),
    );
  });

  it("混合策略只有一章时等同串行，多章时按章并发（最多 3 路）", () => {
    const opts = DEFAULT_OPTIONS;
    expect(estimateSeconds(6, opts, "hybrid", 1)).toBe(estimateSeconds(6, opts, "serial"));
    expect(estimateSeconds(6, opts, "hybrid", 2)).toBeLessThan(estimateSeconds(6, opts, "serial"));
    expect(estimateSeconds(6, opts, "hybrid", 10)).toBe(estimateSeconds(6, opts, "parallel"));
  });

  it("estimateGroups 按二级标题计章，纯文本或没有二级标题时为 1", () => {
    expect(estimateGroups("# T\n\n## A\n\ntext\n\n## B\n\n### c\n", "md")).toBe(2);
    expect(estimateGroups("# T\n\ntext", "md")).toBe(1);
    expect(estimateGroups("## A\n## B", "txt")).toBe(1);
  });
});
