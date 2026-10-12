import { abortError, createSseParser, type SseMessage } from "@/lib/sse";
import type {
  ClarifyAnswerRequest,
  Clarification,
  ReviseRequest,
  TmHit,
  TranslatePath,
  TranslateRequest,
} from "@/lib/api/translate";
import { SAMPLE_STREAM_FAST, SAMPLE_STREAM_STANDARD } from "./stream-sample";

/** 解析样例文本为消息序列 */
export function parseSample(text: string): SseMessage[] {
  const out: SseMessage[] = [];
  const p = createSseParser((m) => out.push(m));
  p.feed(text);
  p.end();
  return out;
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(abortError());
      },
      { once: true },
    );
  });
}

/** 与 plan 节点 auto 规则一致的路径选择（D1）；mock 简化：会话请求在 auto 模式下走标准路径，便于演示上下文与追问 */
function pickPath(req: TranslateRequest): "fast" | "standard" {
  if (req.mode !== "auto") return req.mode;
  if (req.sessionId) return "standard";
  const short = req.text.trim().length <= 80;
  return short && !req.glossaryIds?.length && req.style === "faithful" ? "fast" : "standard";
}

/** 把 delta 拆成更细的片段，模拟逐字流式 */
function splitDelta(m: SseMessage): SseMessage[] {
  const d = JSON.parse(m.data) as { round: number; text: string };
  const chars = Array.from(d.text);
  const pieces: SseMessage[] = [];
  for (let i = 0; i < chars.length; i += 2) {
    pieces.push({ event: "delta", data: JSON.stringify({ round: d.round, text: chars.slice(i, i + 2).join("") }) });
  }
  return pieces;
}

function delayFor(m: SseMessage): number {
  if (m.event === "delta") return 70;
  if (m.event === "review") return 900;
  if (m.event === "clarify") return 500;
  if (m.event === "node") {
    const d = JSON.parse(m.data) as { status: string; node: string };
    if (d.status === "started") return 260;
    if (d.status === "completed" && ["translate", "refine", "review"].includes(d.node)) return 240;
    if (d.node === "clarify") return 700;
    return 380;
  }
  return 200;
}

async function play(messages: SseMessage[], opts: { signal?: AbortSignal; onMessage: (m: SseMessage) => void }) {
  for (const m of messages) {
    const parts = m.event === "delta" ? splitDelta(m) : [m];
    for (const part of parts) {
      await sleep(delayFor(part), opts.signal);
      opts.onMessage(part);
    }
  }
}

const msg = (event: string, data: unknown): SseMessage => ({ event, data: JSON.stringify(data) });

/* ---------------- 事件序列构造（与契约 C 一致） ---------------- */

interface BuildSpec {
  requestId: string;
  path: TranslatePath;
  sourceLang: string;
  targetLang: string;
  domain: string;
  translation: string;
  tmHits: TmHit[];
  sessionTurns?: number;
  /** interrupt：plan 之后中断追问；resume：从 clarify 节点恢复 */
  clarify?: { mode: "interrupt"; threadId: string; question: string; options: string[]; span: string; reason: string } | { mode: "resume"; answer: string };
  clarification?: Clarification | null;
  instruction?: string;
  memory?: { summary: string | null; entities: unknown[]; memorizedUntil: number } | null;
  /** 附加到 final 的字段（Spring 追加的 recordId / sessionId / revisionOf） */
  finalExtra?: () => Record<string, unknown>;
}

function buildEvents(spec: BuildSpec): SseMessage[] {
  const out: SseMessage[] = [];
  let seq = 0;
  const node = (n: string, status: string, extra: Record<string, unknown> = {}) =>
    out.push(msg("node", { seq: ++seq, node: n, status, ...extra }));
  out.push(msg("start", { requestId: spec.requestId }));
  const resume = spec.clarify?.mode === "resume";

  if (!resume) {
    node("analyze", "started");
    out.push(msg("detect", { lang: spec.sourceLang, confidence: 0.98, method: "lingua" }));
    node("analyze", "completed", {
      summary: spec.path === "revise" ? `修订：沿用原记录语种（${spec.sourceLang}）` : `识别为 ${spec.sourceLang}（98%），未选择术语库`,
      latencyMs: 14,
    });
    node("plan", "started");
    const reason =
      spec.path === "revise"
        ? `修订要求：${spec.instruction ?? ""}`
        : spec.path === "fast"
          ? "文本较短且无术语命中，选择快速路径"
          : `会话请求，选择标准路径；领域判定为${spec.domain}`;
    out.push(msg("plan", { path: spec.path, domain: spec.domain, reason }));
    node("plan", "completed", {
      summary: spec.path === "revise" ? "修订路径" : spec.path === "fast" ? "快速路径" : `标准路径 · ${spec.domain}`,
      latencyMs: spec.path === "standard" ? 1820 : 2,
      usage: spec.path === "standard" ? { promptTokens: 210, completionTokens: 36 } : undefined,
    });
  }

  if (spec.clarify?.mode === "interrupt") {
    const c = spec.clarify;
    node("clarify", "started");
    node("clarify", "interrupted", { summary: `等待澄清：「${c.span}」` });
    out.push(msg("clarify", { threadId: c.threadId, question: c.question, options: c.options, span: c.span, reason: c.reason }));
    return out;
  }
  if (resume) {
    const answer = (spec.clarify as { answer: string }).answer;
    node("clarify", "started");
    node("clarify", "completed", { summary: `用户澄清：${answer}`, latencyMs: 3 });
  }

  if (spec.path === "standard") {
    node("retrieve", "started");
    const parts = [
      spec.sessionTurns ? `会话上下文 ${spec.sessionTurns} 轮` : null,
      spec.tmHits.length ? `翻译记忆 ${spec.tmHits.length} 条` : "未命中翻译记忆",
      `领域=${spec.domain}`,
    ].filter(Boolean);
    node("retrieve", "completed", {
      summary: `上下文包：${parts.join("，")}`,
      latencyMs: 46,
      detail: { tmHits: spec.tmHits, sessionTurns: spec.sessionTurns ?? 0 },
    });
  } else {
    node("retrieve", "skipped", { summary: spec.path === "revise" ? "修订路径跳过" : "快速路径跳过" });
  }

  node("translate", "started");
  const chars = Array.from(spec.translation);
  const half = Math.ceil(chars.length / 2);
  out.push(msg("delta", { round: 0, text: chars.slice(0, half).join("") }));
  out.push(msg("delta", { round: 0, text: chars.slice(half).join("") }));
  node("translate", "completed", {
    summary: spec.path === "revise" ? "按修订要求改写完成" : "首译完成",
    latencyMs: 1650,
    usage: { promptTokens: spec.path === "standard" ? 420 : 160, completionTokens: chars.length },
  });

  if (spec.path === "standard") {
    node("review", "started");
    out.push(msg("review", { round: 0, score: 92, passed: true, issues: [] }));
    node("review", "completed", { summary: "第 0 轮评审 92 分，通过", latencyMs: 2100, usage: { promptTokens: 380, completionTokens: 24 } });
    node("refine", "skipped", { summary: "评审通过，无需修正" });
  } else {
    const why = spec.path === "revise" ? "修订路径跳过" : "快速路径跳过";
    node("review", "skipped", { summary: why });
    node("refine", "skipped", { summary: why });
  }
  node("finalize", "started");
  node("finalize", "completed", { summary: "无术语需校验", latencyMs: 1 });

  if (spec.memory) {
    node("memorize", "started");
    out.push(msg("memory", spec.memory));
    node("memorize", "completed", { summary: `会话记忆已压缩至第 ${spec.memory.memorizedUntil} 轮`, latencyMs: 1320 });
  }

  // final 的 Spring 追加字段需在流播放到 final 时才计算（写记录），因此用占位，播放时替换
  out.push({
    event: "final",
    data: JSON.stringify({
      translation: spec.translation,
      sourceLang: spec.sourceLang,
      targetLang: spec.targetLang,
      path: spec.path,
      domain: spec.domain,
      compliance: [],
      usage: { promptTokens: 1200, completionTokens: chars.length * 2 },
      latencyMs: 6200,
      clarification: spec.clarification ?? null,
      tmHits: spec.tmHits,
    }),
    id: "__final__",
  });
  return out;
}

/** 播放构造好的事件；final 时调用 finalExtra 模拟 Spring 写记录并追加字段 */
async function playBuilt(spec: BuildSpec, opts: { signal?: AbortSignal; onMessage: (m: SseMessage) => void }) {
  const messages = buildEvents(spec);
  await play(
    messages,
    {
      signal: opts.signal,
      onMessage: (m) => {
        if (m.event === "final" && m.id === "__final__") {
          const data = { ...JSON.parse(m.data), ...(spec.finalExtra?.() ?? {}) };
          opts.onMessage({ event: "final", data: JSON.stringify(data) });
          return;
        }
        opts.onMessage(m);
      },
    },
  );
}

const rid = () => `req-mock-${Math.random().toString(36).slice(2, 8)}`;

/**
 * 开发模式下的离线翻译流（NEXT_PUBLIC_MOCK_STREAM=1）。
 * - 原文包含 "[error]" 时在 translate 节点后推送 error 事件；包含 "[http]" 时模拟流建立前的 429
 * - 带 sessionId：走会话流程（写入 mock 会话记录）；原文含 bank / pitcher / [clarify] 且会话允许追问时，以 clarify 结束
 * - 标准路径会检索 mock 翻译记忆，在 retrieve 节点 detail 与 final 中返回 tmHits
 */
export async function mockTranslateStream(
  req: TranslateRequest,
  opts: { signal?: AbortSignal; onMessage: (m: SseMessage) => void },
): Promise<void> {
  if (req.text.includes("[http]")) {
    const { ApiError } = await import("@/lib/http");
    await sleep(300, opts.signal);
    throw new ApiError("A0212", "翻译请求过于频繁，请稍后再试", "mock-trace-429", 429);
  }
  const store = await import("./session-store");
  const path = pickPath(req);
  const sourceLang = req.sourceLang === "auto" ? store.detectLang(req.text) : req.sourceLang;
  const tmHits = path === "standard" ? store.searchTm(req.text, sourceLang, req.targetLang).hits : [];

  if (req.sessionId) {
    const session = store.beginTurn(req.sessionId);
    const amb = path === "standard" && session.vo.clarifyEnabled && req.text.length <= 500 ? store.ambiguityOf(req.text) : null;
    const requestId = rid();
    if (amb) {
      const threadId = `turn:${requestId}`;
      await playBuilt(
        {
          requestId,
          path,
          sourceLang,
          targetLang: req.targetLang,
          domain: req.domain || "通用",
          translation: "",
          tmHits,
          clarify: { mode: "interrupt", threadId, question: amb.question, options: amb.options, span: amb.span, reason: amb.reason },
        },
        opts,
      );
      store.setPending(req.sessionId, {
        threadId,
        requestId,
        question: amb.question,
        options: amb.options,
        span: amb.span,
        reason: amb.reason,
        source: req.text,
        request: req,
      });
      return;
    }
    const translation = store.demoTranslate(req.text, req.targetLang);
    const turnSeq = session.vo.turnCount + 1;
    const sid = req.sessionId;
    return playBuilt(
      {
        requestId,
        path,
        sourceLang,
        targetLang: req.targetLang,
        domain: req.domain || (path === "standard" ? "通用" : "通用"),
        translation,
        tmHits,
        sessionTurns: store.contextTurns(sid),
        memory: path === "fast" ? null : store.maybeMemorize(sid, turnSeq),
        finalExtra: () => {
          const r = store.commitTurn(sid, { sourceText: req.text, targetText: translation, path });
          return { recordId: r.recordId, sessionId: sid, revisionOf: null };
        },
      },
      opts,
    );
  }

  // 单次模式：沿用契约样例；标准路径注入记忆命中
  const messages = parseSample(path === "fast" ? SAMPLE_STREAM_FAST : SAMPLE_STREAM_STANDARD);
  const fail = req.text.includes("[error]");
  for (const raw of messages) {
    let m = raw;
    if (tmHits.length && m.event === "node" && m.data.includes('"retrieve","status":"completed"')) {
      const d = JSON.parse(m.data);
      m = msg("node", { ...d, summary: `${d.summary}，翻译记忆 ${tmHits.length} 条`, detail: { tmHits, sessionTurns: 0 } });
    }
    if (m.event === "final") m = msg("final", { ...JSON.parse(m.data), tmHits });
    await play([m], opts);
    if (fail && m.event === "node" && m.data.includes('"translate","status":"completed"')) {
      await sleep(400, opts.signal);
      opts.onMessage({
        event: "error",
        data: JSON.stringify({ code: "C0121", message: "大模型鉴权失败，请检查 API Key", traceId: "mock-trace-c0121" }),
      });
      return;
    }
  }
}

/** 会话修订（revise 路径）：写入 revision_of 指向被修订记录的新版本 */
export async function mockReviseStream(
  sessionId: number,
  body: ReviseRequest,
  opts: { signal?: AbortSignal; onMessage: (m: SseMessage) => void },
): Promise<void> {
  const store = await import("./session-store");
  const { ApiError } = await import("@/lib/http");
  const session = store.getSession(sessionId);
  const base = store.findRecord(body.recordId);
  if (!base || base.sessionId !== sessionId) throw new ApiError("A0404", "记录不属于该会话", "mock-a0404", 404);
  store.beginTurn(sessionId);
  const translation = store.demoRevise(base.targetText, body.instruction);
  return playBuilt(
    {
      requestId: rid(),
      path: "revise",
      sourceLang: base.sourceLang,
      targetLang: session.vo.targetLang,
      domain: session.vo.domain || "通用",
      translation,
      tmHits: [],
      instruction: body.instruction,
      finalExtra: () => {
        const r = store.commitTurn(sessionId, {
          sourceText: base.sourceText,
          targetText: translation,
          path: "revise",
          revisionOf: base.id,
          instruction: body.instruction,
        });
        return { recordId: r.recordId, sessionId, revisionOf: base.id };
      },
    },
    opts,
  );
}

/** 回答追问：校验 threadId 后从 clarify 节点继续（事件流以 start 开始） */
export async function mockClarifyStream(
  sessionId: number,
  body: ClarifyAnswerRequest,
  opts: { signal?: AbortSignal; onMessage: (m: SseMessage) => void },
): Promise<void> {
  const store = await import("./session-store");
  // 与 Spring 一致：流建立前校验 threadId（失效时以 ApiError 抛出）
  const p = store.takePending(sessionId, body.threadId);
  const req = p.request;
  const amb = store.ambiguityOf(req.text);
  const translation = amb?.translations[body.answer] ?? `${store.demoTranslate(req.text, req.targetLang)}（${body.answer}）`;
  const sourceLang = req.sourceLang === "auto" ? store.detectLang(req.text) : req.sourceLang;
  const clarification: Clarification = { question: p.question, options: p.options, span: p.span, answer: body.answer };
  const tmHits = store.searchTm(req.text, sourceLang, req.targetLang).hits;
  return playBuilt(
    {
      requestId: p.requestId,
      path: "standard",
      sourceLang,
      targetLang: req.targetLang,
      domain: req.domain || "通用",
      translation,
      tmHits,
      sessionTurns: store.contextTurns(sessionId),
      clarify: { mode: "resume", answer: body.answer },
      clarification,
      finalExtra: () => {
        const r = store.commitTurn(sessionId, { sourceText: req.text, targetText: translation, path: "standard", clarification });
        return { recordId: r.recordId, sessionId, revisionOf: null };
      },
    },
    opts,
  );
}
