import { describe, expect, it } from "vitest";
import {
  activeStep,
  allTranslations,
  editBlock,
  reduceImageEvent,
  startImageRun,
  stepProgress,
  stepsOf,
  type ImageRunState,
} from "@/lib/image-run";
import { buildImageForm, toImageEvent, validateImageFile, validateImageSize, type ImageEvent } from "@/lib/api/image";

const B1 = { id: 1, text: "宫保鸡丁", bbox: [0.1, 0.2, 0.4, 0.26] as [number, number, number, number] };
const B2 = { id: 2, text: "麻婆豆腐", bbox: [0.1, 0.3, 0.4, 0.36] as [number, number, number, number] };

function run(events: ImageEvent[], engine = "vision"): ImageRunState {
  return events.reduce(reduceImageEvent, startImageRun(engine));
}

const VISION_SEQUENCE: ImageEvent[] = [
  { event: "start", data: { requestId: "img-1" } },
  { event: "node", data: { seq: 1, node: "ocr", status: "started" } },
  { event: "node", data: { seq: 2, node: "ocr", status: "completed", summary: "识别到 2 个文本块（中文）", latencyMs: 3210 } },
  { event: "blocks", data: { width: 1200, height: 900, detectedLang: "zh", blocks: [B1, B2] } },
  { event: "node", data: { seq: 3, node: "terms", status: "completed", summary: "命中 1 条术语", latencyMs: 4 } },
  { event: "node", data: { seq: 4, node: "translate", status: "started" } },
  { event: "node", data: { seq: 5, node: "translate", status: "completed", summary: "已翻译 2 块", latencyMs: 2100 } },
  {
    event: "translation",
    data: { blocks: [{ ...B1, translation: "Kung Pao Chicken" }, { ...B2, translation: "Mapo Tofu" }] },
  },
  { event: "node", data: { seq: 6, node: "render", status: "completed", summary: "坐标已归一化", latencyMs: 1 } },
];

describe("reduceImageEvent", () => {
  it("vision 完整序列：步骤、文本框、译文与 done 字段", () => {
    let s = run(VISION_SEQUENCE.slice(0, 2));
    expect(s.steps.ocr.status).toBe("running");
    expect(activeStep(s)).toBe("ocr");
    expect(s.phase).toBe("scanning");

    s = run(VISION_SEQUENCE.slice(0, 4));
    expect(s.phase).toBe("blocks");
    expect(s.blocks).toHaveLength(2);
    expect(s.width).toBe(1200);
    expect(s.detectedLang).toBe("zh");
    expect(s.steps.ocr).toEqual({ status: "done", summary: "识别到 2 个文本块（中文）", latencyMs: 3210 });

    s = run(VISION_SEQUENCE);
    expect(s.phase).toBe("translated");
    expect(s.blocks.map((b) => b.translation)).toEqual(["Kung Pao Chicken", "Mapo Tofu"]);

    s = reduceImageEvent(s, {
      event: "done",
      data: {
        id: 7,
        detectedLang: "zh",
        blocks: [{ ...B1, translation: "Kung Pao Chicken" }, { ...B2, translation: "Mapo Tofu" }],
        termHits: [{ source: "宫保鸡丁", target: "Kung Pao Chicken", followed: true, blockIds: [1] }],
        trace: [{ node: "ocr", status: "completed", summary: "…", latencyMs: 3210 }],
        usage: { promptTokens: 1500, completionTokens: 420 },
        latencyMs: 5400,
        modelConfigId: 2,
        resultImageBase64: null,
      },
    });
    expect(s.status).toBe("done");
    expect(s.recordId).toBe(7);
    expect(s.termHits).toHaveLength(1);
    expect(s.usage?.completionTokens).toBe(420);
    expect(stepProgress(s)).toBe(1);
  });

  it("qwen-mt-image：没有 blocks / translation 事件，done 带结果图，ocr/terms 标记为跳过", () => {
    const s = run([
      { event: "node", data: { seq: 1, node: "translate", status: "started" } },
      { event: "node", data: { seq: 2, node: "translate", status: "completed", latencyMs: 4000 } },
      { event: "node", data: { seq: 3, node: "render", status: "completed", latencyMs: 2 } },
      {
        event: "done",
        data: { id: 9, detectedLang: null, blocks: [], termHits: [], trace: [], usage: null, latencyMs: 4100, modelConfigId: 5, resultImageBase64: "AAAA" },
      },
    ], "qwen-mt-image");
    expect(stepsOf("qwen-mt-image")).toEqual(["translate", "render"]);
    expect(s.steps.ocr.status).toBe("skipped");
    expect(s.steps.terms.status).toBe("skipped");
    expect(s.blocks).toEqual([]);
    expect(s.resultImageBase64).toBe("AAAA");
  });

  it("无文字图片：blocks 为空正常完成", () => {
    const s = run([
      { event: "node", data: { seq: 1, node: "ocr", status: "completed", summary: "未识别到文字" } },
      { event: "blocks", data: { width: 640, height: 480, detectedLang: null, blocks: [] } },
      { event: "done", data: { detectedLang: null, blocks: [], termHits: [], trace: [], usage: null, latencyMs: 900, modelConfigId: 2, resultImageBase64: null } },
    ]);
    expect(s.status).toBe("done");
    expect(s.blocks).toEqual([]);
    expect(s.steps.ocr.summary).toBe("未识别到文字");
  });

  it("error：进行中的步骤标记为出错并记录错误", () => {
    const s = run([
      { event: "node", data: { seq: 1, node: "ocr", status: "started" } },
      { event: "error", data: { code: "C0171", message: "OCR 结果解析失败" } },
    ]);
    expect(s.status).toBe("error");
    expect(s.error?.code).toBe("C0171");
    expect(s.steps.ocr.status).toBe("error");
  });

  it("未知节点忽略", () => {
    const s0 = startImageRun("vision");
    const s1 = reduceImageEvent(s0, { event: "node", data: { seq: 1, node: "foo" as never, status: "started" } });
    expect(s1).toBe(s0);
  });
});

describe("编辑与复制", () => {
  it("editBlock 只修改目标块", () => {
    const blocks = [{ ...B1, translation: "A" }, { ...B2, translation: "B" }];
    const next = editBlock(blocks, 2, "Mapo Tofu");
    expect(next[1].translation).toBe("Mapo Tofu");
    expect(next[0]).toBe(blocks[0]);
  });
  it("allTranslations 按顺序拼接并跳过空译文", () => {
    expect(allTranslations([{ ...B1, translation: " A " }, { ...B2, translation: "" }, { ...B2, id: 3, translation: "C" }])).toBe("A\nC");
  });
});

describe("image api 工具", () => {
  it("toImageEvent 解析已知事件、忽略未知事件", () => {
    expect(toImageEvent({ event: "start", data: '{"requestId":"x"}' })).toEqual({ event: "start", data: { requestId: "x" } });
    expect(toImageEvent({ event: "ping", data: "{}" })).toBeNull();
  });
  it("validateImageFile 与 validateImageSize", () => {
    expect(validateImageFile({ type: "image/png", size: 1000 })).toBeNull();
    expect(validateImageFile({ type: "image/gif", size: 1000 })).toMatch(/仅支持/);
    expect(validateImageFile({ type: "image/jpeg", size: 12 * 1024 * 1024 })).toMatch(/10 MB/);
    expect(validateImageFile({ type: "image/jpeg", size: 0 })).toBe("图片为空");
    expect(validateImageSize(1200, 900)).toBeNull();
    expect(validateImageSize(20, 900)).toMatch(/小于 32/);
    expect(validateImageSize(9000, 900)).toMatch(/超过 8192/);
  });
  it("buildImageForm：glossaryIds 为可重复字段，缺省值正确", () => {
    const f = buildImageForm({ image: new Blob(["x"], { type: "image/png" }), sourceLang: "", targetLang: "en", engine: "", glossaryIds: [3, 4], modelConfigId: 2 });
    expect(f.get("sourceLang")).toBe("auto");
    expect(f.get("engine")).toBe("vision");
    expect(f.getAll("glossaryIds")).toEqual(["3", "4"]);
    expect(f.get("modelConfigId")).toBe("2");
    const g = buildImageForm({ image: new Blob(["x"]), sourceLang: "zh", targetLang: "en", engine: "qwen-mt-image" });
    expect(g.has("modelConfigId")).toBe(false);
  });
});
