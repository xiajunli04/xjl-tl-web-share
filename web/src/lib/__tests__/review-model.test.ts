import { describe, expect, it } from "vitest";
import {
  SAME_AS_TRANSLATOR,
  SAME_AS_TRANSLATOR_UNSET,
  reviewNoticeOf,
  reviewOptionOf,
  taskReviewLabel,
} from "@/lib/review-model";
import type { ModelOption } from "@/lib/api/translate";

const cfg = (id: number, p: { isDefault?: boolean; isReviewDefault?: boolean; enabled?: boolean } = {}) => ({
  id,
  name: `M${id}`,
  isDefault: p.isDefault ?? false,
  isReviewDefault: p.isReviewDefault,
  enabled: p.enabled ?? true,
});

describe("reviewNoticeOf · 模型配置页提示条判定", () => {
  it("没有配置时不提示（页面已有空状态）", () => {
    expect(reviewNoticeOf([])).toBeNull();
    expect(reviewNoticeOf(undefined)).toBeNull();
  });

  it("没有评审模型时提示 unset", () => {
    expect(reviewNoticeOf([cfg(1, { isDefault: true }), cfg(2)])).toEqual({ kind: "unset", key: "unset" });
  });

  it("旧后端没有 isReviewDefault 字段时按未设置处理", () => {
    expect(reviewNoticeOf([{ id: 1, name: "A", isDefault: true, enabled: true }])?.kind).toBe("unset");
  });

  it("评审模型已停用时视为未设置", () => {
    expect(reviewNoticeOf([cfg(1, { isDefault: true }), cfg(2, { isReviewDefault: true, enabled: false })])?.kind).toBe("unset");
  });

  it("评审模型与默认模型是同一配置时提示 same，key 带 id", () => {
    expect(reviewNoticeOf([cfg(1, { isDefault: true, isReviewDefault: true }), cfg(2)])).toEqual({
      kind: "same",
      key: "same:1",
      name: "M1",
    });
  });

  it("评审模型与默认模型不同时不提示", () => {
    expect(reviewNoticeOf([cfg(1, { isDefault: true }), cfg(2, { isReviewDefault: true })])).toBeNull();
  });
});

describe("评审模型文案", () => {
  const options: ModelOption[] = [
    { id: 1, name: "DeepSeek", provider: "OPENAI_COMPATIBLE", isDefault: true, isReviewDefault: false },
    { id: 3, name: "gpt-6-luna", provider: "OPENAI_COMPATIBLE", isDefault: false, isReviewDefault: true },
  ];

  it("新建任务：取选项中 isReviewDefault 的那项，没有时为空（显示与译者相同）", () => {
    expect(reviewOptionOf(options)?.name).toBe("gpt-6-luna");
    expect(reviewOptionOf(options.map((o) => ({ ...o, isReviewDefault: false })))).toBeUndefined();
    // 旧后端没有 isReviewDefault 字段
    expect(reviewOptionOf(options.map(({ id, name, provider, isDefault }) => ({ id, name, provider, isDefault })))).toBeUndefined();
    expect(reviewOptionOf(undefined)).toBeUndefined();
    expect(SAME_AS_TRANSLATOR_UNSET).toBe("与译者相同（管理员未设置评审模型）");
  });

  it("任务概览：未评审不显示；null 显示与译者相同；找不到选项时显示 id", () => {
    expect(taskReviewLabel(false, 3, options)).toBeNull();
    expect(taskReviewLabel(true, null, options)).toBe(SAME_AS_TRANSLATOR);
    expect(taskReviewLabel(true, undefined, options)).toBe(SAME_AS_TRANSLATOR);
    expect(taskReviewLabel(true, 3, options)).toBe("gpt-6-luna");
    expect(taskReviewLabel(true, 9, options)).toBe("模型 #9");
  });
});
