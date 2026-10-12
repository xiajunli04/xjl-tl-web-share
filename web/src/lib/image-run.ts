import type {
  ImageBlock,
  ImageDoneEvent,
  ImageEvent,
  ImageNode,
  ImageTermHit,
  ImageTraceItem,
} from "@/lib/api/image";
import type { Usage } from "@/lib/api/translate";

/** 图片翻译运行状态的纯归约（页面与单测共用） */

export type ImageRunStatus = "idle" | "running" | "done" | "error" | "stopped";
export type StepStatus = "pending" | "running" | "done" | "skipped" | "error";

export interface StepState {
  status: StepStatus;
  summary?: string;
  latencyMs?: number;
}

export interface ImageRunState {
  status: ImageRunStatus;
  engine: string;
  requestId?: string;
  steps: Record<ImageNode, StepState>;
  width?: number;
  height?: number;
  detectedLang: string | null;
  blocks: ImageBlock[];
  /** 处理阶段：扫描 → 已识别文本框 → 已有译文 */
  phase: "scanning" | "blocks" | "translated";
  termHits: ImageTermHit[];
  trace: ImageTraceItem[];
  usage: Usage | null;
  latencyMs?: number;
  modelConfigId: number | null;
  recordId?: number;
  resultImageBase64: string | null;
  error?: { code: string; message: string; traceId?: string };
}

export const IMAGE_STEPS: ImageNode[] = ["ocr", "terms", "translate", "render"];

/** 引擎实际经过的步骤：qwen-mt-image 只有一次调用 + 渲染 */
export function stepsOf(engine: string): ImageNode[] {
  return engine === "qwen-mt-image" ? ["translate", "render"] : IMAGE_STEPS;
}

export const STEP_LABEL: Record<ImageNode, string> = {
  ocr: "识别",
  terms: "术语",
  translate: "翻译",
  render: "渲染",
};

const pendingSteps = (): Record<ImageNode, StepState> => ({
  ocr: { status: "pending" },
  terms: { status: "pending" },
  translate: { status: "pending" },
  render: { status: "pending" },
});

export function initialImageRun(engine = "vision"): ImageRunState {
  return {
    status: "idle",
    engine,
    steps: pendingSteps(),
    detectedLang: null,
    blocks: [],
    phase: "scanning",
    termHits: [],
    trace: [],
    usage: null,
    modelConfigId: null,
    resultImageBase64: null,
  };
}

export function startImageRun(engine: string): ImageRunState {
  return { ...initialImageRun(engine), status: "running" };
}

/** 按 id 合并译文（translation 事件带完整 blocks，以其为准但保留已有字段） */
function mergeBlocks(prev: ImageBlock[], next: ImageBlock[]): ImageBlock[] {
  if (!prev.length) return next;
  const map = new Map(prev.map((b) => [b.id, b]));
  return next.map((b) => ({ ...map.get(b.id), ...b }));
}

function finishSteps(steps: Record<ImageNode, StepState>, engine: string): Record<ImageNode, StepState> {
  const used = stepsOf(engine);
  const out = { ...steps };
  for (const n of IMAGE_STEPS) {
    if (!used.includes(n)) out[n] = { status: "skipped" };
    else if (out[n].status === "running" || out[n].status === "pending") out[n] = { ...out[n], status: "done" };
  }
  return out;
}

export function reduceImageEvent(s: ImageRunState, e: ImageEvent): ImageRunState {
  switch (e.event) {
    case "start":
      return { ...s, requestId: e.data.requestId };
    case "node": {
      const { node, status, summary, latencyMs } = e.data;
      if (!(node in s.steps)) return s;
      const st: StepState =
        status === "started"
          ? { status: "running" }
          : status === "skipped"
            ? { status: "skipped", summary }
            : { status: "done", summary, latencyMs };
      return { ...s, steps: { ...s.steps, [node]: st } };
    }
    case "blocks":
      return {
        ...s,
        width: e.data.width,
        height: e.data.height,
        detectedLang: e.data.detectedLang,
        blocks: e.data.blocks,
        phase: "blocks",
      };
    case "translation":
      return { ...s, blocks: mergeBlocks(s.blocks, e.data.blocks), phase: "translated" };
    case "done":
      return applyDone(s, e.data);
    case "error":
      return {
        ...s,
        status: "error",
        error: e.data,
        steps: Object.fromEntries(
          IMAGE_STEPS.map((n) => [n, s.steps[n].status === "running" ? { ...s.steps[n], status: "error" } : s.steps[n]]),
        ) as Record<ImageNode, StepState>,
      };
  }
}

function applyDone(s: ImageRunState, d: ImageDoneEvent): ImageRunState {
  return {
    ...s,
    status: "done",
    phase: "translated",
    recordId: d.id,
    detectedLang: d.detectedLang ?? s.detectedLang,
    blocks: d.blocks.length ? mergeBlocks(s.blocks, d.blocks) : s.engine === "qwen-mt-image" ? [] : s.blocks,
    termHits: d.termHits ?? [],
    trace: d.trace ?? [],
    usage: d.usage ?? null,
    latencyMs: d.latencyMs,
    modelConfigId: d.modelConfigId ?? null,
    resultImageBase64: d.resultImageBase64 ?? null,
    steps: finishSteps(s.steps, s.engine),
  };
}

/** 修改某块译文（行内编辑） */
export function editBlock(blocks: ImageBlock[], id: number, translation: string): ImageBlock[] {
  return blocks.map((b) => (b.id === id ? { ...b, translation } : b));
}

/** 全部译文（按块顺序，跳过空译文），用于"复制全部译文" */
export function allTranslations(blocks: readonly ImageBlock[]): string {
  return blocks
    .map((b) => (b.translation ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

/** 当前进行到的步骤（用于状态文案） */
export function activeStep(s: ImageRunState): ImageNode | null {
  for (const n of stepsOf(s.engine)) if (s.steps[n].status === "running") return n;
  return null;
}

/** 已完成步骤占比（0–1），reduced-motion 下作为进度条 */
export function stepProgress(s: ImageRunState): number {
  const used = stepsOf(s.engine);
  const done = used.filter((n) => s.steps[n].status === "done" || s.steps[n].status === "skipped").length;
  const running = used.some((n) => s.steps[n].status === "running") ? 0.5 : 0;
  return Math.min(1, (done + running) / used.length);
}
