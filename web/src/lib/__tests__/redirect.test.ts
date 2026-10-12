import { describe, expect, it } from "vitest";
import { DEFAULT_AFTER_LOGIN, safeRedirect } from "../redirect";

describe("safeRedirect（user-auth：前端会话管理与路由守卫）", () => {
  it("缺省进入工作台", () => {
    expect(DEFAULT_AFTER_LOGIN).toBe("/translate");
    expect(safeRedirect(null)).toBe("/translate");
    expect(safeRedirect("")).toBe("/translate");
  });
  it("站内路径原样返回，外站与协议相对地址被拒绝", () => {
    expect(safeRedirect("/profile")).toBe("/profile");
    expect(safeRedirect("/interpret?room=K7M2QX")).toBe("/interpret?room=K7M2QX");
    expect(safeRedirect("//evil.com")).toBe("/translate");
    // 浏览器会把 /\evil.com 当作 //evil.com 处理
    expect(safeRedirect("/\\evil.com")).toBe("/translate");
    expect(safeRedirect("https://evil.com")).toBe("/translate");
  });
});
