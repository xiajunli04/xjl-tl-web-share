import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  DocEvent,
  DocPhase,
  DocSegmentVO,
  DocStatus,
  DocTaskVO,
  DocTermVO,
} from "@/lib/api/documents";

/** 三端共享的契约样例：docs/contracts/doc-stream-sample.md（Python → Spring 的 Redis Stream 消息） */
export const DOC_SAMPLE_PATH = fileURLToPath(
  new URL("../../../../docs/contracts/doc-stream-sample.md", import.meta.url),
);

export interface StreamEvent {
  taskId: string;
  eventSeq: string;
  type: string;
  traceId?: string;
  data: Record<string, unknown>;
}

/** 读取样例中全部 jsonl 代码块，按出现顺序返回 [块1行列表, 块2行列表, …] */
export function sampleBlocks(): Record<string, unknown>[][] {
  const md = readFileSync(DOC_SAMPLE_PATH, "utf-8");
  const blocks: Record<string, unknown>[][] = [];
  const re = /```jsonl\r?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    blocks.push(
      m[1]
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Record<string, unknown>),
    );
  }
  return blocks;
}

/** 2.1 完整执行（开启术语确认）的事件流 */
export function fullRunEvents(): StreamEvent[] {
  return sampleBlocks()[1] as unknown as StreamEvent[];
}

const PHASE_STATUS: Record<DocPhase, DocStatus> = {
  parsing: "PARSING",
  analyzing: "ANALYZING",
  awaiting_confirm: "AWAITING_CONFIRM",
  translating: "TRANSLATING",
  consistency: "CONSISTENCY",
  assembling: "CONSISTENCY",
};

export function baseTask(patch: Partial<DocTaskVO> = {}): DocTaskVO {
  return {
    id: 42,
    title: "GPU Basics",
    format: "md",
    charCount: 74,
    sourceLang: "auto",
    detectedLang: null,
    targetLang: "zh",
    style: "faithful",
    domain: null,
    genre: null,
    glossaryIds: [1],
    modelConfigId: null,
    strategy: "serial",
    confirmTerms: true,
    options: { contextWindow: true, globalSummary: true, termExtraction: true, review: true, translationMemory: true },
    status: "PENDING",
    phase: null,
    progressDone: 0,
    progressTotal: 0,
    summary: null,
    consistencyReport: null,
    stats: null,
    errorCode: null,
    errorMessage: null,
    retryable: null,
    promptTokens: null,
    completionTokens: null,
    latencyMs: null,
    createdAt: "2026-10-03T10:00:00+08:00",
    startedAt: null,
    finishedAt: null,
    ...patch,
  };
}

export interface Converted {
  events: DocEvent[];
  segments: DocSegmentVO[];
  terms: DocTermVO[];
}

/**
 * 模拟 Spring 的转换：把 Python 事件流转换为浏览器 SSE（D13），并按 parsed 生成 DocSegmentVO（译文为空）。
 * trace 事件 Spring 不转发给浏览器（D13 未列出），这里丢弃。
 */
export function toBrowserEvents(stream: StreamEvent[], start = baseTask()): Converted {
  let task = { ...start };
  const events: DocEvent[] = [{ event: "snapshot", data: { ...task } }];
  let segments: DocSegmentVO[] = [];
  let terms: DocTermVO[] = [];
  let done = 0;
  for (const s of stream) {
    const d = s.data as Record<string, never>;
    switch (s.type) {
      case "phase": {
        const phase = d.phase as DocPhase;
        task = { ...task, status: PHASE_STATUS[phase], phase };
        events.push({ event: "phase", data: { status: task.status, phase } });
        break;
      }
      case "parsed": {
        const chunks = d.chunks as { index: number; segSeqs: number[] }[];
        const chunkOf = new Map<number, number>();
        for (const c of chunks) for (const q of c.segSeqs) chunkOf.set(q, c.index);
        segments = (d.segments as Record<string, never>[]).map((x) => ({
          seq: x.seq,
          blockType: x.blockType,
          level: x.level ?? null,
          prefix: x.prefix,
          source: x.source,
          suffix: x.suffix,
          translatable: x.translatable,
          chunkIndex: chunkOf.get(x.seq) ?? null,
          target: null,
          status: "PENDING",
          reviewScore: null,
          reviewRounds: null,
          compliance: null,
          edited: false,
        }));
        task = { ...task, progressTotal: chunks.length, detectedLang: d.detectedLang };
        events.push({ event: "parsed", data: { progressTotal: chunks.length, detectedLang: d.detectedLang } });
        break;
      }
      case "analysis": {
        terms = (d.candidates as Record<string, never>[]).map((c, i) => ({
          id: 100 + i,
          source: c.source,
          target: c.target,
          origin: c.origin,
          frequency: c.frequency,
          status: "PENDING",
        }));
        task = { ...task, summary: d.summary, domain: d.domain, genre: d.genre };
        events.push({ event: "analysis", data: { summary: d.summary, domain: d.domain, genre: d.genre } });
        break;
      }
      case "awaiting_confirm":
        events.push({ event: "awaiting_confirm", data: { terms } });
        break;
      case "chunk_done":
        done++;
        events.push({
          event: "chunk_done",
          data: {
            chunk: d.chunk,
            progressDone: done,
            progressTotal: task.progressTotal,
            cached: d.cached,
            segments: d.segments,
          },
        });
        break;
      case "consistency":
        task = { ...task, consistencyReport: { issues: d.issues } };
        events.push({ event: "consistency", data: { report: { issues: d.issues }, segments: d.segments } });
        break;
      case "completed": {
        const usage = d.usage as { promptTokens: number; completionTokens: number };
        task = {
          ...task,
          status: "COMPLETED",
          progressDone: done,
          stats: d.stats,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          latencyMs: d.latencyMs,
          finishedAt: "2026-10-03T10:01:00+08:00",
        };
        events.push({ event: "completed", data: { ...task } });
        break;
      }
      case "failed":
        events.push({ event: "failed", data: { code: d.code, message: d.message, retryable: d.retryable } });
        break;
      case "cancelled":
        events.push({ event: "cancelled", data: {} });
        break;
      default:
        break;
    }
  }
  return { events, segments, terms };
}

/** 事件序列 → Spring 风格的 SSE 文本（字段冒号后无空格，夹带 :ping 心跳） */
export function toSseText(events: DocEvent[]): string {
  return events.map((e, i) => `${i % 3 === 0 ? ":ping\n\n" : ""}event:${e.event}\ndata:${JSON.stringify(e.data)}\n\n`).join("");
}
