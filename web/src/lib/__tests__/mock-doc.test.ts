import { describe, expect, it } from "vitest";
import {
  K8S_GUIDE,
  SHORT_NOTE,
  ZH,
  buildLongDoc,
  chunkSegs,
  mockTranslate,
  splitMarkdown,
} from "@/lib/mock/doc-fixtures";

const join = (segs: ReturnType<typeof splitMarkdown>) => segs.map((s) => s.prefix + s.source + s.suffix).join("");

describe("文档 mock 夹具", () => {
  it("k8s-guide 切分后逐字拼回原文，块类型覆盖完整", () => {
    const segs = splitMarkdown(K8S_GUIDE);
    expect(join(segs)).toBe(K8S_GUIDE);
    const types = new Set(segs.map((s) => s.blockType));
    for (const t of ["heading", "paragraph", "list_item", "blockquote", "table_row", "code", "html", "hr"]) {
      expect(types.has(t as never)).toBe(true);
    }
  });

  it("k8s-guide 的每个可翻译段都有手写中文译文", () => {
    const missing = splitMarkdown(K8S_GUIDE)
      .filter((s) => s.translatable)
      .filter((s) => !ZH[s.source]);
    expect(missing.map((s) => s.source)).toEqual([]);
  });

  it("纯文本按空行切分并可拼回", () => {
    const segs = splitMarkdown(SHORT_NOTE, "txt");
    expect(segs).toHaveLength(3);
    expect(join(segs)).toBe(SHORT_NOTE);
  });

  it("长文档约 2000 段，带编号的标题也能查到译文", () => {
    const segs = splitMarkdown(buildLongDoc(2000));
    expect(segs.length).toBeGreaterThanOrEqual(1990);
    expect(segs.length).toBeLessThanOrEqual(2010);
    expect(mockTranslate("12. Scaling and Updates", "zh")).toBe("12. 扩缩容与更新");
    const chunks = chunkSegs(segs, 700);
    expect(Math.max(...chunks)).toBeGreaterThan(40);
  });
});
