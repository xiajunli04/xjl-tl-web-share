/**
 * 文档任务 mock 引擎（仅开发环境，NEXT_PUBLIC_MOCK_API=1 / NEXT_PUBLIC_MOCK_STREAM=1）。
 * 内存中维护任务并按时间推进完整生命周期：
 *   parsing → analyzing →（awaiting_confirm）→ translating 逐块 → consistency → completed
 * 浏览器事件严格按 design.md D13 的格式推送（先 snapshot，再增量事件，终结后关闭）。
 *
 * 演示开关：
 * - 标题或正文包含 "[fail]"：翻译到第 3 块时失败（C0122，可重试），继续后已完成的块以 cached 重放
 * - 地址栏带 ?mock=empty：不预置任何任务（查看任务中心空状态）
 * - 同时运行（不含待确认）的任务超过 2 个时，创建 / 继续返回 429 A0213
 */
import { ApiError, type RequestOptions } from "@/lib/http";
import { abortError, type SseMessage, type SubscribeOptions } from "@/lib/sse";
import type { PageResult } from "@/lib/api/types";
import type {
  ChunkSegmentUpdate,
  ConsistencyReport,
  DocExportFormat,
  DocOptions,
  DocPhase,
  DocSegmentVO,
  DocStatus,
  DocTaskCreateRequest,
  DocTaskSettings,
  DocTaskSummaryVO,
  DocTaskVO,
  DocTermConfirmItem,
  DocTermVO,
  DocTraceVO,
} from "@/lib/api/documents";
import {
  CONSISTENCY_FIXES,
  K8S_GUIDE,
  K8S_TERMS,
  SHORT_NOTE,
  buildLongDoc,
  mockTranslate,
  splitMarkdown,
  toSegments,
} from "./doc-fixtures";
import { quickDocHit, upsertTm } from "./session-store";

type Listener = (m: SseMessage) => void;

interface MockTask {
  vo: DocTaskVO;
  segs: DocSegmentVO[];
  /** 段落是否已"落库"（parsed 之后 GET segments 才返回） */
  parsed: boolean;
  chunkCount: number;
  doneChunks: Set<number>;
  terms: DocTermVO[];
  termsConfirmed: boolean;
  failAt: number | null;
  listeners: Set<Listener>;
  traces: DocTraceVO[];
  /** 每次取消 / 重启递增，旧的执行循环据此退出 */
  runToken: number;
  resume: (() => void) | null;
  chunkDelay: number;
}

const tasks = new Map<number, MockTask>();
let nextId = 2001;
let nextTermId = 9001;
let seeded = false;

const DEFAULT_OPTIONS: DocOptions = { contextWindow: true, globalSummary: true, termExtraction: true, review: true, translationMemory: true };
const RUNNING: DocStatus[] = ["PENDING", "PARSING", "ANALYZING", "TRANSLATING", "CONSISTENCY"];
const TERMINAL: DocStatus[] = ["COMPLETED", "FAILED", "CANCELLED"];

const iso = (offsetMin = 0) => new Date(Date.now() - offsetMin * 60_000).toISOString();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** 伪随机但稳定的评审分 */
function scoreOf(seq: number) {
  return 82 + ((seq * 37) % 17);
}

function phaseStatus(phase: DocPhase): DocStatus {
  return (
    {
      parsing: "PARSING",
      analyzing: "ANALYZING",
      awaiting_confirm: "AWAITING_CONFIRM",
      translating: "TRANSLATING",
      consistency: "CONSISTENCY",
      assembling: "CONSISTENCY",
    } as const
  )[phase];
}

function trace(
  t: MockTask,
  node: string,
  summary: string,
  extra: { chunkIndex?: number; latencyMs?: number; promptTokens?: number; completionTokens?: number; status?: string } = {},
) {
  t.traces.push({
    seq: t.traces.length + 1,
    node,
    chunkIndex: extra.chunkIndex ?? null,
    status: extra.status ?? "completed",
    summary,
    latencyMs: extra.latencyMs ?? null,
    promptTokens: extra.promptTokens ?? null,
    completionTokens: extra.completionTokens ?? null,
    createdAt: iso(),
  });
}

function emit(t: MockTask, event: string, data: unknown) {
  const m: SseMessage = { event, data: JSON.stringify(data) };
  for (const l of [...t.listeners]) l(m);
}

function setPhase(t: MockTask, phase: DocPhase) {
  t.vo.status = phaseStatus(phase);
  t.vo.phase = phase;
  emit(t, "phase", { status: t.vo.status, phase });
}

function activeTerms(t: MockTask) {
  return t.terms.filter((x) => x.status !== "REJECTED");
}

function compliance(t: MockTask, s: DocSegmentVO, target: string) {
  return activeTerms(t)
    .filter((term) => new RegExp(`\\b${term.source}`).test(s.source))
    .map((term) => ({ source: term.source, target: term.target, compliant: target.includes(term.target) }));
}

function translateChunk(t: MockTask, chunk: number): ChunkSegmentUpdate[] {
  const updates: ChunkSegmentUpdate[] = [];
  for (const s of t.segs) {
    // 与 Spring 一致：chunk_done 不包含用户已编辑的段落（不覆盖后编辑内容）
    if (s.chunkIndex !== chunk || !s.translatable || s.edited) continue;
    const target = mockTranslate(s.source, t.vo.targetLang);
    const score = t.vo.options.review ? scoreOf(s.seq) : null;
    // 翻译记忆（缺省开启）：每段最佳 1 条，不命中自己任务写入的条目
    const hit = t.vo.options.translationMemory !== false ? quickDocHit(s.source, t.vo.targetLang) : null;
    const tmHits = hit && !hit.originRef?.startsWith(`${t.vo.id}:`) ? [hit] : [];
    const u: ChunkSegmentUpdate = {
      seq: s.seq,
      target,
      reviewScore: score,
      reviewRounds: score !== null && score < 88 ? 1 : 0,
      compliance: compliance(t, s, target),
      tmHits,
    };
    Object.assign(s, {
      target: u.target,
      reviewScore: u.reviewScore,
      reviewRounds: u.reviewRounds,
      compliance: u.compliance,
      tmHits,
      status: "TRANSLATED",
    });
    updates.push(u);
  }
  return updates;
}

function addUsage(t: MockTask, p: number, c: number) {
  t.vo.promptTokens = (t.vo.promptTokens ?? 0) + p;
  t.vo.completionTokens = (t.vo.completionTokens ?? 0) + c;
}

function consistencyPass(t: MockTask): { report: ConsistencyReport; segments: { seq: number; target: string }[] } {
  const fixed: { seq: number; target: string }[] = [];
  const issues: ConsistencyReport["issues"] = [];
  for (const f of CONSISTENCY_FIXES) {
    const segs = t.segs.filter((s) => s.target?.includes(f.wrong));
    if (!segs.length) continue;
    const chosenCount = t.segs.filter((s) => s.target?.includes(f.chosen) && !s.target.includes(f.wrong)).length;
    for (const s of segs) {
      s.target = s.target!.split(f.wrong).join(f.chosen);
      s.compliance = compliance(t, s, s.target);
      fixed.push({ seq: s.seq, target: s.target });
    }
    issues.push({
      term: f.term,
      variants: [
        { text: f.chosen, count: chosenCount },
        { text: f.wrong, count: segs.length },
      ],
      chosen: f.chosen,
      fixedSegs: segs.map((s) => s.seq),
      unresolvedSegs: [],
    });
  }
  // 一条"未能自动修正"的示例：表格中的 Pod 保留英文
  const podRow = t.segs.find((s) => s.blockType === "table_row" && s.source.startsWith("Pod |"));
  if (podRow && issues.length) {
    issues.push({
      term: "Pod",
      variants: [
        { text: "Pod", count: 12 },
        { text: "容器组", count: 1 },
      ],
      chosen: "Pod",
      fixedSegs: [],
      unresolvedSegs: [podRow.seq],
    });
  }
  return { report: { issues }, segments: fixed };
}

function finalize(t: MockTask) {
  const comp = t.segs.flatMap((s) => s.compliance ?? []);
  t.vo.stats = {
    chunks: t.chunkCount,
    cachedChunks: 0,
    refined: t.segs.filter((s) => (s.reviewRounds ?? 0) > 0).length,
    compliance: { ok: comp.filter((c) => c.compliant).length, total: comp.length },
  };
  t.vo.status = "COMPLETED";
  t.vo.progressDone = t.chunkCount;
  t.vo.finishedAt = iso();
  t.vo.latencyMs = new Date(t.vo.finishedAt).getTime() - new Date(t.vo.startedAt ?? t.vo.createdAt).getTime();
}

/** 执行循环：从当前进度继续（支持 retry 的断点续译） */
async function run(t: MockTask) {
  const token = ++t.runToken;
  const alive = () => t.runToken === token;
  const pause = async (ms: number) => {
    await wait(ms);
    return alive();
  };
  t.vo.startedAt ??= iso();
  t.vo.errorCode = null;
  t.vo.errorMessage = null;
  t.vo.retryable = null;
  t.vo.finishedAt = null;

  if (!t.parsed) {
    if (!(await pause(800))) return;
    setPhase(t, "parsing");
    if (!(await pause(3200))) return;
    t.parsed = true;
    t.vo.progressTotal = t.chunkCount;
    t.vo.detectedLang = t.vo.sourceLang === "auto" ? "en" : t.vo.sourceLang;
    emit(t, "parsed", { progressTotal: t.chunkCount, detectedLang: t.vo.detectedLang });
    trace(t, "parse", `解析 ${t.segs.length} 段，切分为 ${t.chunkCount} 块，识别为英语（98%）`, { latencyMs: 42 });
    if (!(await pause(500))) return;
  }
  if (!t.vo.summary && t.vo.phase !== "translating" && t.vo.phase !== "consistency") {
    setPhase(t, "analyzing");
    if (!(await pause(4200))) return;
    addUsage(t, 3100, 420);
    t.vo.summary = t.vo.options.globalSummary
      ? "本文介绍如何在 Kubernetes 集群上部署无状态 Web 应用：先讲解 Pod、节点、Deployment 与 Service 等核心概念，再给出部署清单与 kubectl 操作步骤，最后说明扩缩容与滚动更新的做法。"
      : null;
    t.vo.domain = "计算机";
    t.vo.genre = "技术文档";
    emit(t, "analysis", { summary: t.vo.summary, domain: t.vo.domain, genre: t.vo.genre });
    trace(t, "analyze", `生成全文摘要；领域：计算机；抽取 ${t.terms.filter((x) => x.origin === "extracted").length} 个候选术语`, {
      latencyMs: 4180,
      promptTokens: 3100,
      completionTokens: 420,
    });
    trace(t, "align_terms", `术语库命中 ${t.terms.filter((x) => x.origin === "glossary").length} 条，合并后 ${t.terms.length} 条候选`, { latencyMs: 3 });
  }
  if (!t.vo.confirmTerms && !t.termsConfirmed) applyAutoTerms(t);
  if (t.vo.confirmTerms && !t.termsConfirmed) {
    setPhase(t, "awaiting_confirm");
    emit(t, "awaiting_confirm", { terms: clone(t.terms) });
    await new Promise<void>((resolve) => {
      t.resume = resolve;
    });
    t.resume = null;
    if (!alive()) return;
    trace(
      t,
      "confirm_terms",
      `用户确认 ${t.terms.filter((x) => x.status === "CONFIRMED").length} 条术语，拒绝 ${t.terms.filter((x) => x.status === "REJECTED").length} 条`,
      { latencyMs: 0 },
    );
  }
  if (t.vo.phase !== "consistency") {
    // 确认术语时已推送过 translating（与 Spring 一致），这里只在状态不同时推送
    if (t.vo.status !== "TRANSLATING") setPhase(t, "translating");
    for (let c = 0; c < t.chunkCount; c++) {
      if (t.doneChunks.has(c)) {
        // 断点续译：已完成的块以缓存方式重放（不重复计数）
        if (!(await pause(120))) return;
        emit(t, "chunk_done", {
          chunk: c,
          progressDone: t.doneChunks.size,
          progressTotal: t.chunkCount,
          cached: true,
          segments: t.segs
            .filter((s) => s.chunkIndex === c && s.translatable && s.target !== null && !s.edited)
            .map((s) => ({
              seq: s.seq,
              target: s.target!,
              reviewScore: s.reviewScore,
              reviewRounds: s.reviewRounds,
              compliance: s.compliance,
              tmHits: s.tmHits ?? [],
            })),
        });
        continue;
      }
      if (!(await pause(t.chunkDelay * (0.75 + ((c * 13) % 7) / 12)))) return;
      if (t.failAt !== null && c === t.failAt) {
        t.failAt = null;
        t.vo.status = "FAILED";
        t.vo.errorCode = "C0122";
        t.vo.errorMessage = "LLM 调用超时（第 3 块重试 3 次仍失败）";
        t.vo.retryable = true;
        t.vo.finishedAt = iso();
        trace(t, "translate_chunk", `第 ${c + 1} 块调用超时，重试 3 次后失败`, { chunkIndex: c, status: "failed", latencyMs: 60000 });
        emit(t, "failed", { code: t.vo.errorCode, message: t.vo.errorMessage, retryable: true });
        t.listeners.clear();
        return;
      }
      const segments = translateChunk(t, c);
      t.doneChunks.add(c);
      t.vo.progressDone = t.doneChunks.size;
      addUsage(t, 900 + segments.length * 60, 120 + segments.length * 40);
      const scores = segments.map((x) => x.reviewScore).filter((x): x is number => x !== null);
      const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
      trace(t, "translate_chunk", `第 ${c + 1}/${t.chunkCount} 块：翻译 ${segments.length} 段${avg !== null ? `，评审 ${avg} 分` : ""}`, {
        chunkIndex: c,
        latencyMs: Math.round(t.chunkDelay * 1.6),
        promptTokens: 900 + segments.length * 60,
        completionTokens: 120 + segments.length * 40,
      });
      emit(t, "chunk_done", {
        chunk: c,
        progressDone: t.vo.progressDone,
        progressTotal: t.chunkCount,
        cached: false,
        segments,
      });
    }
  }
  setPhase(t, "consistency");
  if (!(await pause(3000))) return;
  const cons = consistencyPass(t);
  t.vo.consistencyReport = cons.report;
  addUsage(t, 300, 60);
  emit(t, "consistency", cons);
  trace(t, "consistency", cons.report.issues.length ? `发现 ${cons.report.issues.length} 处不一致，已修正 ${cons.segments.length} 段` : "全文术语一致", {
    latencyMs: 2400,
    promptTokens: 300,
    completionTokens: 60,
  });
  if (!(await pause(600))) return;
  setPhase(t, "assembling");
  if (!(await pause(500))) return;
  finalize(t);
  trace(t, "finalize", `术语遵循 ${t.vo.stats?.compliance.ok}/${t.vo.stats?.compliance.total}，修正 ${t.vo.stats?.refined} 段`, { latencyMs: 2 });
  emit(t, "completed", clone(t.vo));
  t.listeners.clear();
}

/** 未开启人工确认：术语库命中强制使用（CONFIRMED），抽取候选只作参考（AUTO） */
function applyAutoTerms(t: MockTask) {
  t.termsConfirmed = true;
  t.terms.forEach((x) => (x.status = x.origin === "glossary" ? "CONFIRMED" : "AUTO"));
}

function runningCount() {
  return [...tasks.values()].filter((t) => RUNNING.includes(t.vo.status)).length;
}

function baseVo(id: number, title: string, text: string, format: "md" | "txt", s: Partial<DocTaskSettings>): DocTaskVO {
  return {
    id,
    title,
    format,
    charCount: text.length,
    sourceLang: s.sourceLang ?? "auto",
    detectedLang: null,
    targetLang: s.targetLang ?? "zh",
    style: s.style ?? "faithful",
    domain: s.domain ?? null,
    genre: null,
    glossaryIds: s.glossaryIds ?? [],
    modelConfigId: s.modelConfigId ?? null,
    // mock 中 id=2 是评审模型（与 lib/mock/api.ts 一致）
    reviewModelConfigId: (s.options ?? DEFAULT_OPTIONS).review ? (s.reviewModelConfigId ?? 2) : null,
    strategy: s.strategy ?? "hybrid",
    confirmTerms: s.confirmTerms ?? true,
    options: s.options ?? DEFAULT_OPTIONS,
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
    promptTokens: 0,
    completionTokens: 0,
    latencyMs: null,
    createdAt: iso(),
    startedAt: null,
    finishedAt: null,
  };
}

function makeTask(vo: DocTaskVO, text: string, chunkTarget = 260): MockTask {
  const segs = toSegments(splitMarkdown(text, vo.format), chunkTarget);
  const chunkCount = Math.max(1, ...segs.map((s) => (s.chunkIndex ?? 0) + 1));
  const t: MockTask = {
    vo,
    segs,
    parsed: false,
    chunkCount,
    doneChunks: new Set(),
    terms: K8S_TERMS.map((x) => ({ ...x, id: nextTermId++ })),
    termsConfirmed: false,
    failAt: /\[fail\]/i.test(vo.title + text) ? Math.min(2, chunkCount - 1) : null,
    listeners: new Set(),
    traces: [],
    runToken: 0,
    resume: null,
    chunkDelay: vo.strategy === "parallel" ? 1200 : vo.strategy === "hybrid" ? 1600 : 2400,
  };
  if (!vo.options.termExtraction) t.terms = t.terms.filter((x) => x.origin === "glossary");
  tasks.set(vo.id, t);
  return t;
}

/** 立即把任务推进到"已完成 n 块"的状态（预置数据用） */
function fastForward(t: MockTask, chunks: number, confirm = true) {
  t.parsed = true;
  t.vo.progressTotal = t.chunkCount;
  t.vo.detectedLang = "en";
  t.vo.startedAt = t.vo.createdAt;
  t.vo.summary =
    "本文介绍如何在 Kubernetes 集群上部署无状态 Web 应用：先讲解 Pod、节点、Deployment 与 Service 等核心概念，再给出部署清单与 kubectl 操作步骤，最后说明扩缩容与滚动更新的做法。";
  t.vo.domain = "计算机";
  t.vo.genre = "技术文档";
  if (confirm) {
    t.termsConfirmed = true;
    t.terms.forEach((x, i) => (x.status = i === 7 ? "REJECTED" : "CONFIRMED"));
  } else if (!t.vo.confirmTerms) applyAutoTerms(t);
  trace(t, "parse", `解析 ${t.segs.length} 段，切分为 ${t.chunkCount} 块，识别为英语（98%）`, { latencyMs: 42 });
  trace(t, "analyze", "生成全文摘要；领域：计算机；抽取 7 个候选术语", { latencyMs: 4180, promptTokens: 3100, completionTokens: 420 });
  trace(t, "align_terms", `术语库命中 3 条，合并后 ${t.terms.length} 条候选`, { latencyMs: 3 });
  if (confirm && t.vo.confirmTerms) trace(t, "confirm_terms", `用户确认 ${t.terms.length - 1} 条术语，拒绝 1 条`, { latencyMs: 0 });
  for (let c = 0; c < Math.min(chunks, t.chunkCount); c++) {
    const segs = translateChunk(t, c);
    t.doneChunks.add(c);
    trace(t, "translate_chunk", `第 ${c + 1}/${t.chunkCount} 块：翻译 ${segs.length} 段，评审 ${scoreOf(c * 7)} 分`, {
      chunkIndex: c,
      latencyMs: 3800 + c * 211,
      promptTokens: 1200,
      completionTokens: 300,
    });
  }
  t.vo.progressDone = t.doneChunks.size;
  t.vo.promptTokens = 1200 * t.doneChunks.size + 3100;
  t.vo.completionTokens = 300 * t.doneChunks.size + 420;
}

function seed() {
  if (seeded) return;
  seeded = true;
  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("mock") === "empty") return;

  const done = makeTask(
    { ...baseVo(1001, "Kubernetes 部署指南", K8S_GUIDE, "md", { glossaryIds: [7] }), createdAt: iso(140) },
    K8S_GUIDE,
  );
  fastForward(done, done.chunkCount);
  const cons = consistencyPass(done);
  done.vo.consistencyReport = cons.report;
  trace(done, "consistency", `发现 ${cons.report.issues.length} 处不一致，已修正 ${cons.segments.length} 段`, { latencyMs: 2400, promptTokens: 300, completionTokens: 60 });
  done.vo.phase = "assembling";
  finalize(done);
  done.vo.finishedAt = iso(131);
  done.vo.latencyMs = 9 * 60_000 + 12_000;

  const long = makeTask(
    {
      ...baseVo(1002, "Kubernetes 运维手册（2000 段长文档）", "", "md", { strategy: "hybrid" }),
      createdAt: iso(25),
    },
    buildLongDoc(2000),
    700,
  );
  long.vo.charCount = long.segs.reduce((n, s) => n + s.prefix.length + s.source.length + s.suffix.length, 0);
  fastForward(long, Math.floor(long.chunkCount * 0.36));
  long.vo.status = "TRANSLATING";
  long.vo.phase = "translating";
  long.chunkDelay = 2600;
  void run(long);

  const awaiting = makeTask(
    {
      ...baseVo(1003, "API 网关迁移说明", K8S_GUIDE, "md", { domain: "计算机", glossaryIds: [7] }),
      createdAt: iso(12),
    },
    K8S_GUIDE,
  );
  fastForward(awaiting, 0, false);
  awaiting.vo.status = "AWAITING_CONFIRM";
  awaiting.vo.phase = "awaiting_confirm";
  void run(awaiting);

  const failed = makeTask(
    {
      ...baseVo(1004, "发布说明 v2.3", K8S_GUIDE, "md", {
        strategy: "parallel",
        confirmTerms: false,
        options: { ...DEFAULT_OPTIONS, contextWindow: false },
      }),
      createdAt: iso(60 * 26),
    },
    K8S_GUIDE,
  );
  fastForward(failed, 2, false);
  Object.assign(failed.vo, {
    status: "FAILED",
    phase: "translating",
    errorCode: "C0122",
    errorMessage: "LLM 调用超时（第 3 块重试 3 次仍失败）",
    retryable: true,
    finishedAt: iso(60 * 26 - 4),
  });

  const cancelled = makeTask(
    {
      ...baseVo(1005, "用户协议草案", SHORT_NOTE, "txt", {
        style: "fluent",
        options: { contextWindow: false, globalSummary: false, termExtraction: false, review: false, translationMemory: false },
        strategy: "parallel",
        confirmTerms: false,
      }),
      createdAt: iso(60 * 50),
    },
    SHORT_NOTE,
  );
  cancelled.parsed = true;
  cancelled.vo.progressTotal = cancelled.chunkCount;
  Object.assign(cancelled.vo, { status: "CANCELLED", phase: "analyzing", detectedLang: "en", startedAt: iso(60 * 50), finishedAt: iso(60 * 50 - 1) });
}

function find(id: number): MockTask {
  seed();
  const t = tasks.get(id);
  if (!t) throw new ApiError("A0404", "资源不存在", "mock-a0404", 404);
  return t;
}

function summaryOf(vo: DocTaskVO): DocTaskSummaryVO {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { summary, consistencyReport, stats, ...rest } = vo;
  return clone(rest);
}

function stateError(): never {
  throw new ApiError("A0431", "当前任务状态不允许该操作", "mock-a0431", 409);
}

function assertConcurrency() {
  if (runningCount() >= 2) {
    throw new ApiError("A0213", "同时运行的文档任务过多，请等待其他任务完成", "mock-a0213", 429);
  }
}

function create(text: string, format: "md" | "txt", s: DocTaskSettings, fallbackTitle: string) {
  seed();
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (!clean.trim() || clean.length > 50_000) {
    throw new ApiError("A0430", clean.trim() ? "文档超过 50000 字符上限" : "文档内容为空", "mock-a0430", 400);
  }
  assertConcurrency();
  const heading = clean.match(/^#\s+(.+)$/m)?.[1];
  const title = s.title?.trim() || fallbackTitle || heading || "未命名文档";
  const t = makeTask(baseVo(nextId++, title, clean, format, s), clean);
  void run(t);
  return clone(t.vo);
}

function exportText(t: MockTask, format: DocExportFormat) {
  if (format === "md") return t.segs.map((s) => s.prefix + (s.target ?? s.source) + s.suffix).join("");
  if (format === "txt") {
    return t.segs
      .filter((s) => s.blockType !== "hr" && s.blockType !== "html")
      .map((s) => (s.translatable ? (s.target ?? s.source) : s.source) + s.suffix)
      .join("");
  }
  return t.segs
    .map((s) =>
      s.translatable && s.target
        ? `${s.prefix}${s.source}${s.suffix.replace(/\n+$/, "")}\n${s.prefix}${s.target}${s.suffix}`
        : s.prefix + s.source + s.suffix,
    )
    .join("");
}

function retranslateText(t: MockTask, s: DocSegmentVO, instruction?: string) {
  const base = s.target ?? mockTranslate(s.source, t.vo.targetLang);
  const ins = instruction ?? "";
  if (/简洁|精简|短/.test(ins)) {
    const cut = base
      .replace(/使用 /g, "用 ")
      .replace(/会/g, "")
      .replace(/，[^，。]*。$/, "。");
    return cut === base ? base.replace(/。/g, "；").replace(/；$/, "。") : cut;
  }
  if (/口语|通俗/.test(ins)) return base.replace(/^首先，/, "第一步，").replace(/请参阅/g, "可以看看").replace(/。$/, "，就这么简单。");
  if (/正式|书面/.test(ins)) return base.replace(/你/g, "您").replace(/就这么简单/g, "");
  return base.replace(/然后/g, "随后").replace(/首先/g, "第一步").replace(/会/g, "将");
}

/** 处理 /api/doc-tasks 下的 REST 请求；不是文档任务路径时返回 undefined */
export async function mockDocRequest(path: string, opts: RequestOptions): Promise<{ data: unknown } | undefined> {
  if (!path.startsWith("/api/doc-tasks")) return undefined;
  seed();
  const method = opts.method ?? "GET";
  const q = opts.query ?? {};
  let m: RegExpMatchArray | null;

  if (path === "/api/doc-tasks" && method === "GET") {
    const kw = String(q.keyword ?? "").trim().toLowerCase();
    if (kw === "error") throw new ApiError("B0001", "系统执行出错", "mock-7c1e9a0b42f3", 500);
    let rows = [...tasks.values()].map((t) => t.vo);
    if (kw) rows = rows.filter((v) => v.title.toLowerCase().includes(kw));
    if (q.status) rows = rows.filter((v) => v.status === q.status);
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const pageNum = Number(q.pageNum ?? 1);
    const pageSize = Number(q.pageSize ?? 20);
    const page: PageResult<DocTaskSummaryVO> = {
      records: rows.slice((pageNum - 1) * pageSize, pageNum * pageSize).map(summaryOf),
      total: rows.length,
      pageNum,
      pageSize,
    };
    return { data: page };
  }
  if (path === "/api/doc-tasks" && method === "POST") {
    if (opts.form) {
      const file = opts.form.get("file") as File | null;
      const settings = JSON.parse(String(opts.form.get("settings") ?? "{}")) as DocTaskSettings;
      if (!file) throw new ApiError("A0430", "缺少文件", "mock-a0430", 400);
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      if (!["md", "markdown", "txt"].includes(ext)) {
        throw new ApiError("A0430", "仅支持 .md / .markdown / .txt", "mock-a0430", 400);
      }
      return { data: create(await file.text(), ext === "txt" ? "txt" : "md", settings, file.name.replace(/\.[^.]+$/, "")) };
    }
    const b = (opts.body ?? {}) as DocTaskCreateRequest;
    return { data: create(b.text ?? "", b.format ?? "md", b, "") };
  }
  if ((m = path.match(/^\/api\/doc-tasks\/(\d+)$/))) {
    const t = find(Number(m[1]));
    if (method === "DELETE") {
      t.runToken++;
      t.resume?.();
      t.listeners.clear();
      tasks.delete(t.vo.id);
      return { data: null };
    }
    return { data: clone(t.vo) };
  }
  if ((m = path.match(/^\/api\/doc-tasks\/(\d+)\/traces$/))) {
    return { data: clone(find(Number(m[1])).traces) };
  }
  if ((m = path.match(/^\/api\/doc-tasks\/(\d+)\/segments$/))) {
    const t = find(Number(m[1]));
    return { data: t.parsed ? clone(t.segs) : [] };
  }
  if ((m = path.match(/^\/api\/doc-tasks\/(\d+)\/segments\/(\d+)(\/retranslate)?$/))) {
    const t = find(Number(m[1]));
    const s = t.segs.find((x) => x.seq === Number(m![2]));
    if (!s) throw new ApiError("A0404", "段落不存在", "mock-a0404", 404);
    if (!s.translatable) stateError();
    if (m[3]) {
      await wait(1100);
      const target = retranslateText(t, s, (opts.body as { instruction?: string } | undefined)?.instruction);
      return { data: { target, usage: { promptTokens: 640, completionTokens: 72 }, latencyMs: 1830 } };
    }
    s.target = String((opts.body as { target?: string } | undefined)?.target ?? "");
    s.edited = true;
    s.compliance = compliance(t, s, s.target);
    // 与 Spring 一致：后编辑保存后异步写入翻译记忆（去除行内标记的原文）
    const plain = s.source.replace(/\*\*|`/g, "");
    setTimeout(() => {
      upsertTm([{ sourceLang: t.vo.detectedLang ?? "en", targetLang: t.vo.targetLang, sourceText: plain, targetText: s.target!, origin: "document", originRef: `${t.vo.id}:${s.seq}` }]);
    }, 300);
    return { data: clone(s) };
  }
  if ((m = path.match(/^\/api\/doc-tasks\/(\d+)\/memory$/))) {
    const t = find(Number(m[1]));
    if (t.vo.status !== "COMPLETED") stateError();
    await wait(900);
    const segs = t.segs.filter((x) => x.translatable && x.target);
    upsertTm(
      segs.map((x) => ({
        sourceLang: t.vo.detectedLang ?? "en",
        targetLang: t.vo.targetLang,
        sourceText: x.source.replace(/\*\*|`/g, ""),
        targetText: x.target!,
        origin: "document",
        originRef: `${t.vo.id}:${x.seq}`,
      })),
    );
    return { data: { written: segs.length } };
  }
  if ((m = path.match(/^\/api\/doc-tasks\/(\d+)\/terms$/))) {
    const t = find(Number(m[1]));
    return { data: t.vo.status === "PENDING" || t.vo.status === "PARSING" ? [] : clone(t.terms) };
  }
  if ((m = path.match(/^\/api\/doc-tasks\/(\d+)\/terms\/confirm$/))) {
    const t = find(Number(m[1]));
    if (t.vo.status !== "AWAITING_CONFIRM") stateError();
    const items = ((opts.body as { terms?: DocTermConfirmItem[] } | undefined)?.terms ?? []).filter((x) => x.source.trim());
    const listed = new Set(items.map((x) => x.id).filter(Boolean));
    // 未列出的待确认术语置为 REJECTED
    const unlisted = t.terms.filter((x) => !listed.has(x.id)).map((x) => ({ ...x, status: "REJECTED" as const }));
    t.terms = items.map((x) => {
      const prev = x.id ? t.terms.find((y) => y.id === x.id) : undefined;
      return {
        id: prev?.id ?? nextTermId++,
        source: x.source.trim(),
        target: x.target.trim(),
        origin: prev?.origin ?? "user",
        frequency: prev?.frequency ?? 1,
        status: x.status,
      };
    });
    t.terms = [...t.terms, ...unlisted];
    t.termsConfirmed = true;
    // 与 Spring 一致：确认后立即推送 phase(TRANSLATING)
    setPhase(t, "translating");
    setTimeout(() => t.resume?.(), 400);
    return { data: clone(t.terms) };
  }
  if ((m = path.match(/^\/api\/doc-tasks\/(\d+)\/cancel$/))) {
    const t = find(Number(m[1]));
    if (!RUNNING.includes(t.vo.status) && t.vo.status !== "AWAITING_CONFIRM") stateError();
    t.runToken++;
    const resume = t.resume;
    t.resume = null;
    t.vo.status = "CANCELLING";
    emit(t, "phase", { status: "CANCELLING", phase: t.vo.phase ?? "parsing" });
    setTimeout(() => {
      resume?.();
      t.vo.status = "CANCELLED";
      t.vo.finishedAt = iso();
      emit(t, "cancelled", {});
      t.listeners.clear();
    }, 900);
    return { data: clone(t.vo) };
  }
  if ((m = path.match(/^\/api\/doc-tasks\/(\d+)\/retry$/))) {
    const t = find(Number(m[1]));
    if (!(t.vo.status === "CANCELLED" || (t.vo.status === "FAILED" && t.vo.retryable))) stateError();
    assertConcurrency();
    t.vo.status = "PENDING";
    t.vo.errorCode = null;
    t.vo.errorMessage = null;
    t.vo.startedAt = iso();
    void run(t);
    return { data: clone(t.vo) };
  }
  throw new ApiError("A0404", `mock 未实现：${method} ${path}`, undefined, 404);
}

export async function mockDocDownload(path: string, query?: Record<string, unknown>) {
  const m = path.match(/^\/api\/doc-tasks\/(\d+)\/export$/);
  if (!m) return undefined;
  const t = find(Number(m[1]));
  if (!t.parsed) throw new ApiError("A0431", "文档尚未解析完成，暂不能导出", "mock-a0431", 409);
  const format = (query?.format as DocExportFormat) ?? "md";
  const ext = format === "txt" ? "txt" : "md";
  const suffix = format === "bilingual" ? "bilingual" : t.vo.targetLang;
  return {
    blob: new Blob([exportText(t, format)], { type: format === "txt" ? "text/plain" : "text/markdown" }),
    filename: `${t.vo.title}.${suffix}.${ext}`,
  };
}

/** mock 事件订阅：与 subscribeSse 相同的契约（先 snapshot，终结后在 isDone 时结束） */
export async function mockDocSubscribe(id: number, opts: SubscribeOptions): Promise<void> {
  await wait(180);
  if (opts.signal?.aborted) throw abortError();
  const t = find(id);
  opts.onOpen?.({ attempt: 0 });
  return new Promise<void>((resolve, reject) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      t.listeners.delete(listener);
      resolve();
    };
    const listener: Listener = (m) => {
      opts.onMessage(m);
      if (TERMINAL.includes(t.vo.status) && opts.isDone?.()) setTimeout(finish, 0);
    };
    opts.signal?.addEventListener(
      "abort",
      () => {
        finished = true;
        t.listeners.delete(listener);
        reject(abortError());
      },
      { once: true },
    );
    opts.onMessage({ event: "snapshot", data: JSON.stringify(t.vo) });
    if (TERMINAL.includes(t.vo.status)) {
      setTimeout(finish, 0);
      return;
    }
    t.listeners.add(listener);
  });
}
