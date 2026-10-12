import { createStore } from "zustand/vanilla";
import { ApiError } from "@/lib/http";
import { isAbortError } from "@/lib/sse";
import type {
  AgentNode,
  ClarifyEventData,
  DetectEventData,
  FinalEventData,
  MemoryEventData,
  NodeDetail,
  PlanEventData,
  ReviewEventData,
  TermsEventData,
  TmHit,
  TranslateEvent,
  TranslateRequest,
  Usage,
} from "@/lib/api/translate";

/**
 * design.md D9：把 SSE 事件归约为一次翻译的运行状态
 * {status, nodes[], detect, terms, plan, rounds:[{round, text, review?}], final, error}
 */

/** clarify：事件流以 clarify 结束，等待用户回答追问（不是错误，也不是完成） */
export type RunStatus = "idle" | "running" | "done" | "error" | "stopped" | "clarify";

/** 运行的种类：普通翻译 / 会话修订 / 回答追问后的恢复 */
export type RunKind = "translate" | "revise" | "resume";

export interface NodeRun {
  /** 同一节点可能多次执行（review / refine 多轮），key 唯一 */
  key: string;
  node: AgentNode;
  status: "running" | "completed" | "skipped" | "interrupted";
  summary?: string;
  latencyMs?: number;
  usage?: Usage;
  seq: number;
  /** node completed 事件的可选 detail（retrieve：tmHits / sessionTurns） */
  detail?: NodeDetail;
}

/** 追问：clarify 事件 + 用户的回答（回答后卡片收起，恢复流继续归约到同一个状态） */
export interface RunClarify extends ClarifyEventData {
  answer?: string;
}

export interface RunRound {
  round: number;
  text: string;
  review?: ReviewEventData;
}

export interface RunError {
  code: string;
  message: string;
  traceId?: string;
}

export interface RunState {
  status: RunStatus;
  requestId?: string;
  nodes: NodeRun[];
  detect?: DetectEventData;
  terms?: TermsEventData;
  plan?: PlanEventData;
  rounds: RunRound[];
  final?: FinalEventData;
  error?: RunError;
  startedAt?: number;
  finishedAt?: number;
  clarify?: RunClarify;
  memory?: MemoryEventData;
  /** 恢复次数：恢复流的节点 key 加上前缀，避免与中断前的 seq 冲突 */
  resumes: number;
  /** 「解读」中采用的备选译法（final.translation 已替换；seq 每次采用 / 恢复递增，用于译文区过渡动效） */
  adopted?: RunAdoption;
}

export interface RunAdoption {
  /** 采用前的原译文 */
  original: string;
  /** 当前采用的备选；null 表示已恢复原译 */
  text: string | null;
  seq: number;
}

/**
 * 采用备选译法（text=null 表示恢复原译）：替换 final.translation，原译文保存在 adopted.original。
 * 没有 final（尚未完成）时返回 null。
 */
export function adoptTranslation(s: RunState, text: string | null): Partial<RunState> | null {
  if (!s.final) return null;
  if (text === (s.adopted?.text ?? null)) return null;
  const original = s.adopted?.original ?? s.final.translation;
  return {
    final: { ...s.final, translation: text ?? original },
    adopted: { original, text, seq: (s.adopted?.seq ?? 0) + 1 },
  };
}

/** 所有字段显式列出：zustand 的 set 是浅合并，未列出的可选字段会残留上一次运行的值 */
export const initialRunState: RunState = {
  status: "idle",
  requestId: undefined,
  nodes: [],
  detect: undefined,
  terms: undefined,
  plan: undefined,
  rounds: [],
  final: undefined,
  error: undefined,
  startedAt: undefined,
  finishedAt: undefined,
  clarify: undefined,
  memory: undefined,
  resumes: 0,
  adopted: undefined,
};

/** Agent 图的规范节点顺序（用于时间线占位） */
export const AGENT_NODES: AgentNode[] = [
  "analyze",
  "plan",
  "retrieve",
  "translate",
  "review",
  "refine",
  "finalize",
];

/** 纯函数归约：每个事件产生一个新状态 */
export function reduceRun(state: RunState, e: TranslateEvent): RunState {
  switch (e.event) {
    case "start":
      return { ...state, status: "running", requestId: e.data.requestId };
    case "node": {
      const d = e.data;
      const key = state.resumes ? `${d.node}-r${state.resumes}-${d.seq}` : `${d.node}-${d.seq}`;
      if (d.status === "started") {
        // 恢复后重新执行被中断的节点：原地改回运行中，而不是追加一条
        const idx = findLastIndex(state.nodes, (n) => n.node === d.node && n.status === "interrupted");
        if (idx !== -1) {
          const nodes = state.nodes.slice();
          nodes[idx] = { ...nodes[idx], status: "running", summary: undefined };
          return { ...state, nodes };
        }
        return {
          ...state,
          nodes: [...state.nodes, { key, node: d.node, status: "running", seq: d.seq }],
        };
      }
      if (d.status === "skipped") {
        return {
          ...state,
          nodes: [...state.nodes, { key, node: d.node, status: "skipped", summary: d.summary, seq: d.seq }],
        };
      }
      // completed / interrupted：更新最近一个同名且仍在运行（或已中断）的节点；找不到时补一条
      const idx = findLastIndex(
        state.nodes,
        (n) => n.node === d.node && (n.status === "running" || n.status === "interrupted"),
      );
      const done: Partial<NodeRun> = {
        status: d.status === "interrupted" ? "interrupted" : "completed",
        summary: d.summary,
        latencyMs: d.latencyMs,
        usage: d.usage,
        ...(d.detail ? { detail: d.detail } : {}),
      };
      if (idx === -1) {
        return {
          ...state,
          nodes: [...state.nodes, { key, node: d.node, seq: d.seq, ...done } as NodeRun],
        };
      }
      const nodes = state.nodes.slice();
      nodes[idx] = { ...nodes[idx], ...done };
      return { ...state, nodes };
    }
    case "detect":
      return { ...state, detect: e.data };
    case "terms":
      return { ...state, terms: e.data };
    case "plan":
      return { ...state, plan: e.data };
    case "delta": {
      const { round, text } = e.data;
      const last = state.rounds[state.rounds.length - 1];
      if (!last || round > last.round) {
        // 更大的 round：开始新一轮，当前译文清空后重新流入
        return { ...state, rounds: [...state.rounds, { round, text }] };
      }
      if (round < last.round) return state; // 迟到的旧轮次增量，忽略
      const rounds = state.rounds.slice();
      rounds[rounds.length - 1] = { ...last, text: last.text + text };
      return { ...state, rounds };
    }
    case "review": {
      const r = e.data;
      const idx = state.rounds.findIndex((x) => x.round === r.round);
      const rounds = state.rounds.slice();
      if (idx === -1) rounds.push({ round: r.round, text: "", review: r });
      else rounds[idx] = { ...rounds[idx], review: r };
      rounds.sort((a, b) => a.round - b.round);
      return { ...state, rounds };
    }
    case "final":
      return { ...state, status: "done", final: e.data, finishedAt: Date.now() };
    case "clarify":
      // 终止事件：之后不发 final，连接关闭
      return { ...state, status: "clarify", clarify: { ...e.data }, finishedAt: Date.now() };
    case "memory":
      return { ...state, memory: e.data };
    case "error":
      return {
        ...state,
        status: "error",
        error: { code: e.data.code, message: e.data.message, traceId: e.data.traceId },
        finishedAt: Date.now(),
      };
    default:
      return state;
  }
}

function findLastIndex<T>(arr: T[], pred: (t: T) => boolean) {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
}

/** 当前应展示的译文：final 优先，否则为最新一轮的流式文本 */
export function currentTranslation(s: RunState): string {
  if (s.final) return s.final.translation;
  return s.rounds[s.rounds.length - 1]?.text ?? "";
}

/** 当前轮次（0 为首译） */
export function currentRound(s: RunState): number {
  return s.rounds[s.rounds.length - 1]?.round ?? 0;
}

/** 最新的评审结果 */
export function latestReview(s: RunState): ReviewEventData | undefined {
  for (let i = s.rounds.length - 1; i >= 0; i--) if (s.rounds[i].review) return s.rounds[i].review;
  return undefined;
}

/**
 * 本次翻译命中的翻译记忆：final.tmHits 优先，其次为 retrieve 节点 detail.tmHits；
 * 都没有时返回空数组（旧后端 / 快速路径 / 修订路径）。
 */
export function tmHitsOf(s: Pick<RunState, "final" | "nodes">): TmHit[] {
  if (Array.isArray(s.final?.tmHits)) return s.final.tmHits;
  for (let i = s.nodes.length - 1; i >= 0; i--) {
    const n = s.nodes[i];
    if (n.node === "retrieve" && Array.isArray(n.detail?.tmHits)) return n.detail.tmHits;
  }
  return [];
}

/** retrieve 节点注入的会话上下文轮数（未知时为 undefined） */
export function sessionTurnsOf(s: Pick<RunState, "nodes">): number | undefined {
  for (let i = s.nodes.length - 1; i >= 0; i--) {
    const n = s.nodes[i];
    const v = n.node === "retrieve" ? n.detail?.sessionTurns : undefined;
    if (typeof v === "number") return v;
  }
  return undefined;
}

/** 把一组事件依次归约（测试与回放使用） */
export function reduceAll(events: TranslateEvent[], from: RunState = initialRunState): RunState {
  return events.reduce(reduceRun, from);
}

/* ---------------- 运行控制（zustand vanilla store） ---------------- */

export type StreamFn = (
  req: TranslateRequest,
  opts: { signal?: AbortSignal; onEvent: (e: TranslateEvent) => void },
) => Promise<void>;

/** 任意一条翻译事件流（翻译 / 修订 / 恢复） */
export type InvokeFn = (opts: { signal: AbortSignal; onEvent: (e: TranslateEvent) => void }) => Promise<void>;

export interface RunOptions {
  kind: RunKind;
  /** true：保留当前状态继续归约（回答追问后的恢复流），时间线接着点亮 */
  keep?: boolean;
  request?: TranslateRequest;
  /** 会话 id（会话模式下的翻译 / 修订 / 恢复） */
  sessionId?: number;
  /** 修订：被修订的记录 */
  reviseOf?: number;
  /** 修订要求 */
  instruction?: string;
  /** 运行开始时合入的初始状态（例如回答追问时带上问答，供时间线展示） */
  seed?: Partial<RunState>;
}

export interface RunStore extends RunState {
  request?: TranslateRequest;
  kind?: RunKind;
  sessionId?: number;
  reviseOf?: number;
  instruction?: string;
  start: (req: TranslateRequest) => Promise<void>;
  /** 以任意事件流驱动运行状态 */
  run: (invoke: InvokeFn, opts: RunOptions) => Promise<void>;
  /** 重试上一次运行（恢复流失败时重试恢复） */
  retry: () => Promise<void>;
  stop: () => void;
  reset: () => void;
}

export function createRunStore(deps: {
  stream: StreamFn;
  onFinal?: (f: FinalEventData) => void;
  /** 收到 clarify / memory 等会话相关事件后（用于刷新会话详情） */
  onSessionEvent?: (e: TranslateEvent, sessionId?: number) => void;
}) {
  let controller: AbortController | null = null;
  let last: { invoke: InvokeFn; opts: RunOptions } | null = null;

  return createStore<RunStore>()((set, get) => {
    const run = async (invoke: InvokeFn, opts: RunOptions) => {
      controller?.abort();
      const c = new AbortController();
      controller = c;
      last = { invoke, opts };
      const meta = {
        kind: opts.kind,
        request: opts.request ?? (opts.keep ? get().request : undefined),
        sessionId: opts.sessionId,
        reviseOf: opts.reviseOf,
        instruction: opts.instruction,
      };
      if (opts.keep) {
        set((s) => ({
          ...meta,
          ...opts.seed,
          status: "running",
          error: undefined,
          finishedAt: undefined,
          resumes: s.resumes + 1,
        }));
      } else {
        set({ ...initialRunState, ...meta, ...opts.seed, status: "running", startedAt: Date.now() });
      }
      const alive = () => controller === c;
      try {
        await invoke({
          signal: c.signal,
          onEvent: (e) => {
            if (!alive()) return;
            set((s) => reduceRun(s, e));
            if (e.event === "final") deps.onFinal?.(e.data);
            if (e.event === "final" || e.event === "clarify" || e.event === "memory") {
              deps.onSessionEvent?.(e, opts.sessionId);
            }
          },
        });
        if (alive() && get().status === "running") {
          set({
            status: "error",
            error: { code: "B0001", message: "连接意外中断，未收到最终结果" },
            finishedAt: Date.now(),
          });
        }
      } catch (e) {
        if (!alive()) return;
        if (isAbortError(e)) {
          set({ status: "stopped", finishedAt: Date.now() });
        } else if (e instanceof ApiError) {
          set({
            status: "error",
            error: { code: e.code, message: e.message, traceId: e.traceId },
            finishedAt: Date.now(),
          });
        } else {
          set({
            status: "error",
            error: { code: "B0001", message: e instanceof Error ? e.message : "未知错误" },
            finishedAt: Date.now(),
          });
        }
      } finally {
        if (alive()) controller = null;
      }
    };

    return {
      ...initialRunState,

      run,

      start(req) {
        return run((o) => deps.stream(req, o), { kind: "translate", request: req, sessionId: req.sessionId });
      },

      retry() {
        if (!last) return Promise.resolve();
        return run(last.invoke, last.opts);
      },

      stop() {
        if (!controller) return;
        controller.abort();
        controller = null;
        if (get().status === "running") set({ status: "stopped", finishedAt: Date.now() });
      },

      reset() {
        controller?.abort();
        controller = null;
        last = null;
        set({
          ...initialRunState,
          request: undefined,
          kind: undefined,
          sessionId: undefined,
          reviseOf: undefined,
          instruction: undefined,
        });
      },
    };
  });
}
