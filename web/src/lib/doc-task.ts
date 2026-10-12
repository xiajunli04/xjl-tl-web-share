import { createStore } from "zustand/vanilla";
import { isAbortError } from "@/lib/sse";
import {
  isTerminal,
  type ChunkSegmentUpdate,
  type DocEvent,
  type DocSegmentVO,
  type DocSubscribeFn,
  type DocTaskVO,
  type DocTermVO,
  type DocTraceEventData,
} from "@/lib/api/documents";

/**
 * 文档任务的前端状态合成（design.md D13「浏览器 SSE」）：
 * snapshot 为准重建任务详情 + 增量事件归约；chunk_done 按分块编号去重；
 * 收到 parsed 后重新拉取段落；重连后（第 2 个及以后的 snapshot）重新拉取段落以补齐断线期间错过的分块。
 */

export type DocConnState = "idle" | "connecting" | "open" | "reconnecting" | "closed" | "error";

export type DocLogTone = "brand" | "success" | "warning" | "danger" | "info" | "muted";

export interface DocLogItem {
  key: string;
  at: number;
  kind: DocEvent["event"] | "reconnecting" | "reconnected" | "duplicate";
  title: string;
  detail?: string;
  tone: DocLogTone;
}

export interface DocTaskState {
  task: DocTaskVO | null;
  /** null：尚未加载（或文档尚未解析完成） */
  segments: DocSegmentVO[] | null;
  /** seq → segments 下标 */
  seqIndex: Map<number, number>;
  /** 候选 / 确认的任务术语；null 表示尚未加载 */
  terms: DocTermVO[] | null;
  /** 已应用的分块编号（去重依据） */
  doneChunks: ReadonlySet<number>;
  /** 段落尚未加载时收到的分块译文，加载后补应用 */
  pendingUpdates: ChunkSegmentUpdate[];
  /** 本次会话中通过事件到达译文的段落 → 时间戳（用于淡入动效） */
  freshAt: ReadonlyMap<number, number>;
  /** 一致性阶段被修正的段落 → 时间戳（用于闪烁高亮） */
  fixedAt: ReadonlyMap<number, number>;
  lastChunk: number | null;
  /** 已收到的 snapshot 数（>1 说明发生过重连） */
  snapshots: number;
  log: DocLogItem[];
  traces: DocTraceEventData[];
  conn: DocConnState;
  /** 不可恢复的订阅错误（如 A0404） */
  error: unknown;
}

export const initialDocTaskState: DocTaskState = {
  task: null,
  segments: null,
  seqIndex: new Map(),
  terms: null,
  doneChunks: new Set(),
  pendingUpdates: [],
  freshAt: new Map(),
  fixedAt: new Map(),
  lastChunk: null,
  snapshots: 0,
  log: [],
  traces: [],
  conn: "idle",
  error: null,
};

const LOG_LIMIT = 200;

function pushLog(state: DocTaskState, item: Omit<DocLogItem, "key">): DocLogItem[] {
  const log = [...state.log, { ...item, key: `${item.kind}-${state.log.length}-${item.at}` }];
  return log.length > LOG_LIMIT ? log.slice(log.length - LOG_LIMIT) : log;
}

function indexOf(segments: DocSegmentVO[]) {
  const m = new Map<number, number>();
  segments.forEach((s, i) => m.set(s.seq, i));
  return m;
}

/** 按 seq 应用一组段落修改；返回新数组（未命中的 seq 忽略） */
function patchSegments(
  segments: DocSegmentVO[],
  index: Map<number, number>,
  patches: { seq: number; patch: Partial<DocSegmentVO> }[],
): DocSegmentVO[] {
  if (!patches.length) return segments;
  const next = segments.slice();
  for (const { seq, patch } of patches) {
    const i = index.get(seq);
    if (i === undefined) continue;
    next[i] = { ...next[i], ...patch };
  }
  return next;
}

function chunkPatch(u: ChunkSegmentUpdate): Partial<DocSegmentVO> {
  return {
    target: u.target,
    reviewScore: u.reviewScore ?? null,
    reviewRounds: u.reviewRounds ?? null,
    compliance: u.compliance ?? null,
    // 旧后端没有 tmHits：不覆盖段落上已有的值
    ...(u.tmHits !== undefined ? { tmHits: u.tmHits ?? [] } : {}),
    status: "TRANSLATED",
  };
}

/** 由段落推断已完成的分块：分块内所有可翻译段都有译文 */
export function completedChunksOf(segments: DocSegmentVO[]): Set<number> {
  const pending = new Set<number>();
  const seen = new Set<number>();
  for (const s of segments) {
    if (s.chunkIndex === null || s.chunkIndex === undefined) continue;
    seen.add(s.chunkIndex);
    if (s.translatable && (s.target === null || s.target === undefined)) pending.add(s.chunkIndex);
  }
  const out = new Set<number>();
  for (const c of seen) if (!pending.has(c)) out.add(c);
  return out;
}

/** 段落加载完成：建立索引、补应用缓冲的分块译文、合并已完成分块 */
export function withSegments(state: DocTaskState, list: DocSegmentVO[]): DocTaskState {
  const sorted = list.slice().sort((a, b) => a.seq - b.seq);
  const index = indexOf(sorted);
  const segments = patchSegments(
    sorted,
    index,
    state.pendingUpdates.map((u) => ({ seq: u.seq, patch: chunkPatch(u) })),
  );
  const doneChunks = new Set(state.doneChunks);
  for (const c of completedChunksOf(segments)) doneChunks.add(c);
  return { ...state, segments, seqIndex: index, pendingUpdates: [], doneChunks };
}

/** 本地修改单个段落（后编辑 / 采用重译结果） */
export function withSegmentPatch(state: DocTaskState, seq: number, patch: Partial<DocSegmentVO>): DocTaskState {
  if (!state.segments) return state;
  return { ...state, segments: patchSegments(state.segments, state.seqIndex, [{ seq, patch }]) };
}

function withTask(state: DocTaskState, patch: Partial<DocTaskVO>): DocTaskVO | null {
  return state.task ? { ...state.task, ...patch } : state.task;
}

const PHASE_TITLE: Record<string, string> = {
  parsing: "开始解析文档",
  analyzing: "全文分析：摘要与术语抽取",
  awaiting_confirm: "等待确认术语",
  translating: "开始分块翻译",
  consistency: "全文一致性检查",
  assembling: "组装译文",
};

/** 纯函数归约：snapshot 重建，增量事件合成；now 用于动效时间戳 */
export function reduceDocTask(state: DocTaskState, e: DocEvent, now = Date.now()): DocTaskState {
  switch (e.event) {
    case "snapshot": {
      const snapshots = state.snapshots + 1;
      return {
        ...state,
        task: e.data,
        snapshots,
        log:
          snapshots === 1
            ? pushLog(state, { at: now, kind: "snapshot", title: "已连接，收到任务快照", tone: "muted" })
            : pushLog(state, { at: now, kind: "snapshot", title: "重连成功，已按快照重建状态", tone: "info" }),
      };
    }
    case "phase":
      return {
        ...state,
        task: withTask(state, { status: e.data.status, phase: e.data.phase }),
        log: pushLog(state, {
          at: now,
          kind: "phase",
          title: e.data.status === "CANCELLING" ? "正在取消任务" : (PHASE_TITLE[e.data.phase] ?? e.data.phase),
          tone: e.data.status === "CANCELLING" ? "warning" : "brand",
        }),
      };
    case "parsed":
      return {
        ...state,
        task: withTask(state, { progressTotal: e.data.progressTotal, detectedLang: e.data.detectedLang }),
        log: pushLog(state, {
          at: now,
          kind: "parsed",
          title: `解析完成，切分为 ${e.data.progressTotal} 块`,
          detail: e.data.detectedLang ? `识别语种：${e.data.detectedLang}` : undefined,
          tone: "success",
        }),
      };
    case "analysis":
      return {
        ...state,
        task: withTask(state, { summary: e.data.summary, domain: e.data.domain, genre: e.data.genre }),
        log: pushLog(state, {
          at: now,
          kind: "analysis",
          title: "生成全文摘要",
          detail: [e.data.domain, e.data.genre].filter(Boolean).join(" · ") || undefined,
          tone: "success",
        }),
      };
    case "awaiting_confirm":
      return {
        ...state,
        terms: e.data.terms,
        task: withTask(state, { status: "AWAITING_CONFIRM", phase: "awaiting_confirm" }),
        log: pushLog(state, {
          at: now,
          kind: "awaiting_confirm",
          title: `${e.data.terms.length} 条候选术语等待确认`,
          tone: "warning",
        }),
      };
    case "chunk_done": {
      const d = e.data;
      if (state.doneChunks.has(d.chunk)) {
        return {
          ...state,
          log: pushLog(state, {
            at: now,
            kind: "duplicate",
            title: `第 ${d.chunk + 1} 块已存在，重复事件已忽略`,
            tone: "muted",
          }),
        };
      }
      const doneChunks = new Set(state.doneChunks);
      doneChunks.add(d.chunk);
      const prevDone = state.task?.progressDone ?? 0;
      const total = d.progressTotal || state.task?.progressTotal || 0;
      const progressDone = Math.min(
        total || Number.MAX_SAFE_INTEGER,
        typeof d.progressDone === "number" ? Math.max(d.progressDone, prevDone) : prevDone + 1,
      );
      const freshAt = new Map(state.freshAt);
      for (const u of d.segments) freshAt.set(u.seq, now);
      const scores = d.segments.map((s) => s.reviewScore).filter((x): x is number => typeof x === "number");
      const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
      const base = {
        ...state,
        doneChunks,
        freshAt,
        lastChunk: d.chunk,
        task: withTask(state, { progressDone, progressTotal: total }),
        log: pushLog(state, {
          at: now,
          kind: "chunk_done" as const,
          title: `第 ${d.chunk + 1}/${total || "?"} 块完成${d.cached ? "（缓存）" : ""}`,
          detail: `${d.segments.length} 段${avg !== null ? ` · 评审均分 ${avg}` : ""}`,
          tone: d.cached ? ("info" as const) : ("success" as const),
        }),
      };
      if (!state.segments) return { ...base, pendingUpdates: [...state.pendingUpdates, ...d.segments] };
      return {
        ...base,
        segments: patchSegments(
          state.segments,
          state.seqIndex,
          d.segments.map((u) => ({ seq: u.seq, patch: chunkPatch(u) })),
        ),
      };
    }
    case "consistency": {
      const fixedAt = new Map(state.fixedAt);
      for (const s of e.data.segments) fixedAt.set(s.seq, now);
      const n = e.data.report.issues.length;
      return {
        ...state,
        fixedAt,
        task: withTask(state, { consistencyReport: e.data.report }),
        segments: state.segments
          ? patchSegments(
              state.segments,
              state.seqIndex,
              e.data.segments.map((s) => {
                // 事件只带新译文：按新译文重新判定该段的术语遵循（已包含选定译法即视为遵循）
                const prev = state.segments![state.seqIndex.get(s.seq) ?? -1];
                const compliance = prev?.compliance?.map((c) => ({ ...c, compliant: c.compliant || s.target.includes(c.target) })) ?? null;
                return { seq: s.seq, patch: { target: s.target, compliance } };
              }),
            )
          : state.segments,
        log: pushLog(state, {
          at: now,
          kind: "consistency",
          title: n ? `发现 ${n} 处术语不一致，已修正 ${e.data.segments.length} 段` : "全文术语一致",
          tone: n ? "warning" : "success",
        }),
      };
    }
    case "completed": {
      // 以 completed 的 DocTaskVO 为准；个别字段为空时保留增量事件已合成的值
      const prev = state.task;
      const task: DocTaskVO = {
        ...e.data,
        summary: e.data.summary ?? prev?.summary ?? null,
        domain: e.data.domain ?? prev?.domain ?? null,
        genre: e.data.genre ?? prev?.genre ?? null,
        detectedLang: e.data.detectedLang ?? prev?.detectedLang ?? null,
        consistencyReport: e.data.consistencyReport ?? prev?.consistencyReport ?? null,
      };
      return {
        ...state,
        task,
        log: pushLog(state, { at: now, kind: "completed", title: "翻译完成", tone: "success" }),
      };
    }
    case "failed":
      return {
        ...state,
        task: withTask(state, {
          status: "FAILED",
          errorCode: e.data.code,
          errorMessage: e.data.message,
          retryable: e.data.retryable,
          finishedAt: new Date(now).toISOString(),
        }),
        log: pushLog(state, {
          at: now,
          kind: "failed",
          title: "任务失败",
          detail: `${e.data.code} · ${e.data.message}`,
          tone: "danger",
        }),
      };
    case "cancelled":
      return {
        ...state,
        task: withTask(state, { status: "CANCELLED", finishedAt: new Date(now).toISOString() }),
        log: pushLog(state, { at: now, kind: "cancelled", title: "任务已取消", tone: "warning" }),
      };
    case "trace": {
      if (state.traces.some((t) => t.seq === e.data.seq)) return state;
      return { ...state, traces: [...state.traces, e.data].sort((a, b) => a.seq - b.seq) };
    }
    default:
      return state;
  }
}

export function reduceDocEvents(events: DocEvent[], from: DocTaskState = initialDocTaskState, now?: number) {
  return events.reduce((s, e) => reduceDocTask(s, e, now), from);
}

/* ---------------- 订阅控制（zustand vanilla store） ---------------- */

export interface DocTaskDeps {
  subscribe: DocSubscribeFn;
  segments: (id: number) => Promise<DocSegmentVO[]>;
  terms: (id: number) => Promise<DocTermVO[]>;
  /** 测试注入 */
  retry?: Parameters<DocSubscribeFn>[1]["retry"];
  sleep?: Parameters<DocSubscribeFn>[1]["sleep"];
  idleTimeoutMs?: number;
}

export interface DocTaskStore extends DocTaskState {
  /** 开始订阅（重复调用会先停止上一个订阅） */
  start: () => void;
  /** 停止订阅 */
  stop: () => void;
  /** 取消 / 继续等操作之后重新订阅（保留已加载的段落） */
  restart: () => void;
  reloadSegments: () => Promise<void>;
  patchSegment: (seq: number, patch: Partial<DocSegmentVO>) => void;
  /** 本地乐观更新任务字段（取消 / 继续之后，等待事件确认） */
  patchTask: (patch: Partial<DocTaskVO>) => void;
  setTerms: (terms: DocTermVO[]) => void;
  /** 当前订阅的 Promise（测试使用） */
  running: Promise<void> | null;
}

const PRE_ANALYSIS = new Set(["PENDING", "PARSING", "ANALYZING"]);

export function createDocTaskStore(id: number, deps: DocTaskDeps) {
  let controller: AbortController | null = null;
  let segToken = 0;
  let termsToken = 0;

  return createStore<DocTaskStore>()((set, get) => {
    const loadSegments = async () => {
      const token = ++segToken;
      try {
        const list = await deps.segments(id);
        if (token !== segToken) return;
        set((s) => withSegments(s, list));
      } catch {
        // 段落加载失败不影响订阅；界面保留骨架，下一次 parsed / 重连时再拉取
      }
    };

    const loadTerms = async () => {
      const token = ++termsToken;
      try {
        const terms = await deps.terms(id);
        if (token !== termsToken) return;
        set({ terms });
      } catch {
        // 同上
      }
    };

    const afterEvent = (e: DocEvent, before: DocTaskState) => {
      const s = get();
      if (e.event === "snapshot") {
        const t = e.data;
        const reconnected = s.snapshots > 1;
        if ((s.segments === null && t.progressTotal > 0) || (reconnected && s.segments !== null)) {
          void loadSegments();
        }
        if (s.terms === null && !PRE_ANALYSIS.has(t.status)) void loadTerms();
      }
      if (e.event === "parsed") void loadSegments();
      if (e.event === "phase" && before.task?.status === "AWAITING_CONFIRM" && e.data.status !== "AWAITING_CONFIRM") {
        // 确认后刷新术语（拿到 CONFIRMED / REJECTED 的最终状态）
        void loadTerms();
      }
      if (isTerminal(s.task?.status) && controller) {
        // 终结后停止订阅
        controller.abort();
        controller = null;
        set({ conn: "closed" });
      }
    };

    const start = () => {
      controller?.abort();
      const c = new AbortController();
      controller = c;
      const alive = () => controller === c;
      set({ conn: "connecting", error: null });
      const p = deps
        .subscribe(id, {
          signal: c.signal,
          retry: deps.retry,
          sleep: deps.sleep,
          idleTimeoutMs: deps.idleTimeoutMs,
          isDone: () => isTerminal(get().task?.status),
          onOpen: () => {
            if (alive()) set({ conn: "open" });
          },
          onRetry: ({ delayMs }) => {
            if (!alive()) return;
            set((s) => ({
              conn: "reconnecting",
              log: pushLog(s, {
                at: Date.now(),
                kind: "reconnecting",
                title: "连接中断，正在重连",
                detail: `${Math.round(delayMs / 100) / 10} 秒后重试`,
                tone: "warning",
              }),
            }));
          },
          onEvent: (e) => {
            if (!alive()) return;
            const before = get();
            set((s) => reduceDocTask(s, e));
            afterEvent(e, before);
          },
        })
        .then(() => {
          if (controller === c) {
            controller = null;
            set({ conn: "closed" });
          }
        })
        .catch((err) => {
          if (isAbortError(err)) return;
          if (controller === c) {
            controller = null;
            set({ conn: "error", error: err });
          }
        });
      set({ running: p });
    };

    return {
      ...initialDocTaskState,
      running: null,
      start,
      stop() {
        controller?.abort();
        controller = null;
        set({ conn: "closed" });
      },
      restart() {
        start();
      },
      reloadSegments: loadSegments,
      patchSegment(seq, patch) {
        set((s) => withSegmentPatch(s, seq, patch));
      },
      patchTask(patch) {
        set((s) => ({ task: s.task ? { ...s.task, ...patch } : s.task }));
      },
      setTerms(terms) {
        set({ terms });
      },
    };
  });
}

/* ---------------- 派生 ---------------- */

/** 段落是否已有译文 */
export const hasTarget = (s: DocSegmentVO) => s.target !== null && s.target !== undefined;

/** 列表中需要展示的段落（空行不占位） */
export function visibleSegments(segments: DocSegmentVO[]): DocSegmentVO[] {
  return segments.filter((s) => s.blockType !== "blank");
}

/** 分块 → 其中第一个段落的 seq（自动跟随时定位用） */
export function firstSeqOfChunk(segments: DocSegmentVO[], chunk: number): number | null {
  for (const s of segments) if (s.chunkIndex === chunk) return s.seq;
  return null;
}
