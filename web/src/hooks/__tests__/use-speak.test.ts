import { describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { shouldAutoRead } from "../use-speak";

describe("shouldAutoRead 完成后自动朗读的触发条件", () => {
  it("首次渲染（打开历史记录）不触发", () => {
    expect(shouldAutoRead(null, { scope: "1", doneKey: "v9" })).toBe(false);
  });

  it("同一作用域内出现新的完成标识时触发；标识不变或为空不触发", () => {
    expect(shouldAutoRead({ scope: "1", doneKey: "v8" }, { scope: "1", doneKey: "v9" })).toBe(true);
    expect(shouldAutoRead({ scope: "1", doneKey: null }, { scope: "1", doneKey: "v9" })).toBe(true);
    expect(shouldAutoRead({ scope: "1", doneKey: "v9" }, { scope: "1", doneKey: "v9" })).toBe(false);
    expect(shouldAutoRead({ scope: "1", doneKey: "v9" }, { scope: "1", doneKey: null })).toBe(false);
  });

  it("切换会话不触发；新会话（尚未创建）的第一轮触发", () => {
    expect(shouldAutoRead({ scope: "1", doneKey: "v8" }, { scope: "2", doneKey: "v3" })).toBe(false);
    expect(shouldAutoRead({ scope: null, doneKey: null }, { scope: "5", doneKey: "v1" })).toBe(true);
  });
});
