import { describe, expect, it } from "vitest";
import { NAV_GROUPS, breadcrumbOf } from "@/components/layout/nav";

describe("导航（ui-design-system：普通用户导航）", () => {
  it("「翻译」分组顺序：工作台、同声传译、图片翻译、文档翻译、历史、术语库、翻译记忆", () => {
    const g = NAV_GROUPS.find((x) => x.key === "translate")!;
    expect(g.adminOnly).toBeFalsy();
    expect(g.items.map((i) => i.label)).toEqual(["翻译工作台", "同声传译", "图片翻译", "文档翻译", "翻译历史", "术语库", "翻译记忆"]);
    expect(g.items.map((i) => i.href).slice(1, 3)).toEqual(["/interpret", "/image"]);
  });

  it("面包屑同步", () => {
    expect(breadcrumbOf("/interpret")).toEqual({ group: "翻译", label: "同声传译" });
    expect(breadcrumbOf("/image")).toEqual({ group: "翻译", label: "图片翻译" });
  });
});
