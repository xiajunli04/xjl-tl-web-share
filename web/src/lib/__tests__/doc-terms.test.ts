import { describe, expect, it } from "vitest";
import { activeTermCount, groupTerms, termGroupOf } from "@/lib/doc-terms";
import type { DocTermVO } from "@/lib/api/documents";

let id = 0;
const term = (source: string, status: string, frequency = 1, origin: DocTermVO["origin"] = "extracted"): DocTermVO => ({
  id: ++id,
  source,
  target: source,
  origin,
  frequency,
  status: status as DocTermVO["status"],
});

describe("groupTerms · 术语按状态分组", () => {
  it("空列表返回空数组", () => {
    expect(groupTerms([])).toEqual([]);
    expect(groupTerms(null)).toEqual([]);
  });

  it("按 待确认 → 已确认 → 参考 → 已拒绝 的固定顺序，只返回存在的分组", () => {
    const groups = groupTerms([
      term("Pod", "AUTO", 14),
      term("cluster", "CONFIRMED", 3, "glossary"),
      term("replicas", "REJECTED", 2),
      term("Deployment", "AUTO", 8),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["confirmed", "auto", "rejected"]);
    expect(groups.map((g) => g.label)).toEqual(["已确认 / 术语库", "参考（自动采用）", "已拒绝"]);
  });

  it("组内按出现次数降序，次数相同按源词排序", () => {
    const [auto] = groupTerms([term("b", "AUTO", 2), term("a", "AUTO", 2), term("c", "AUTO", 9)]);
    expect(auto.terms.map((t) => t.source)).toEqual(["c", "a", "b"]);
  });

  it("不修改传入的数组", () => {
    const input = [term("b", "AUTO", 1), term("a", "AUTO", 5)];
    groupTerms(input);
    expect(input.map((t) => t.source)).toEqual(["b", "a"]);
  });

  it("已拒绝分组默认折叠，其余默认展开", () => {
    const groups = groupTerms([term("x", "PENDING"), term("y", "REJECTED")]);
    expect(groups.map((g) => [g.key, g.defaultOpen])).toEqual([
      ["pending", true],
      ["rejected", false],
    ]);
  });

  it("未知状态归入待确认，不丢失术语", () => {
    expect(termGroupOf("SOMETHING_NEW")).toBe("pending");
    expect(groupTerms([term("x", "SOMETHING_NEW")])[0].terms).toHaveLength(1);
  });

  it("生效术语数 = 已确认 + 参考", () => {
    expect(activeTermCount([term("a", "CONFIRMED"), term("b", "AUTO"), term("c", "REJECTED"), term("d", "PENDING")])).toBe(2);
    expect(activeTermCount(null)).toBe(0);
  });
});
