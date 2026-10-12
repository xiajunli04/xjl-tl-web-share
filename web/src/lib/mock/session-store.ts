/**
 * 开发用 mock（仅 NEXT_PUBLIC_MOCK_API=1 / NEXT_PUBLIC_MOCK_STREAM=1）：会话、会话内记录与翻译记忆的内存数据。
 * mock 事件流（stream.ts）在 final 时调用这里模拟 Spring 写记录；mock REST（api.ts / doc-engine.ts）读取同一份数据。
 * 刷新页面即重置。
 */
import { ApiError } from "@/lib/http";
import type { PageResult } from "@/lib/api/types";
import type { Clarification, MemoryEntity, TmHit, TranslatePath, TranslateRequest, TranslateStyle } from "@/lib/api/translate";
import type { PendingClarify, RecordBrief, SessionDetailVO, SessionSaveRequest, SessionSummaryVO, SessionVO } from "@/lib/api/sessions";
import type { TmEntry, TmSearchResult } from "@/lib/api/tm";
import { similarity } from "@/lib/text-diff";
import { FUZZY_MIN, SEMANTIC_MIN, matchScore } from "@/lib/tm-match";
import { K8S_GUIDE, ZH, splitMarkdown } from "./doc-fixtures";

const iso = (offsetMin = 0) => new Date(Date.now() - offsetMin * 60_000).toISOString();

/* ---------------- 演示语料 ---------------- */

/** 演示用的固定译法（会话三轮、追问、记忆命中） */
export const DEMO_ZH: Record<string, string> = {
  "I bought the X200 headphones last week.": "我上周买了 X200 耳机。",
  "It stopped working yesterday.": "它昨天就坏了。",
  "Can I get a replacement?": "我可以换一副新的吗？",
  "Your order has been shipped.": "您的订单已发货。",
  "How do I get a refund?": "我该如何申请退款？",
  "What is the process for getting my money back?": "我要怎样才能拿回退款？",
  "Machine learning models are usually trained on GPUs.": "机器学习模型通常在图形处理器上训练。",
  "Machine learning models are typically trained on GPUs.": "机器学习模型一般在图形处理器上训练。",
  "Restart the Pod after updating the ConfigMap.": "更新 ConfigMap 后重启该 Pod。",
  "Restart the Pod after updating the Secret.": "更新 Secret 后重启该 Pod。",
  "The pitcher was on the table.": "水罐放在桌子上。",
  "Good morning": "早上好",
};

/** 歧义演示：片段 → 选项与对应译文 */
export const AMBIGUOUS: Record<string, { question: string; options: string[]; reason: string; translations: Record<string, string> }> = {
  bank: {
    question: "「bank」指银行还是河岸 / 堤岸？",
    options: ["银行", "河岸"],
    reason: "多义词，前文没有足够线索",
    translations: { 银行: "请把它寄到银行。", 河岸: "请把它送到河岸边。" },
  },
  pitcher: {
    question: "「pitcher」指水罐还是棒球投手？",
    options: ["水罐", "投手"],
    reason: "多义词，会话中没有棒球或餐具相关的上下文",
    translations: { 水罐: "水罐放在桌子上。", 投手: "投手就在桌边。" },
  },
};

export function ambiguityOf(text: string) {
  for (const [span, a] of Object.entries(AMBIGUOUS)) {
    if (new RegExp(`\\b${span}\\b`, "i").test(text)) return { span, ...a };
  }
  if (text.includes("[clarify]")) return { span: "[clarify]", ...AMBIGUOUS.bank };
  return null;
}

/** 演示译文：固定译法 → 文档语料 → 占位 */
export function demoTranslate(text: string, targetLang: string): string {
  const key = text.trim();
  if (targetLang === "zh") return DEMO_ZH[key] ?? ZH[key] ?? `〔译〕${key}`;
  return `[${targetLang}] ${key}`;
}

/** 修订：按要求做一个看得出差别的改写 */
export function demoRevise(base: string, instruction: string): string {
  const known: Record<string, Record<string, string>> = {
    "它昨天就坏了。": { 更口语: "这耳机昨天就不响了。", 更正式: "该产品于昨日出现故障。", 更简洁: "昨天坏了。" },
    "我上周买了 X200 耳机。": { 更口语: "我上礼拜刚买的 X200 耳机。", 更正式: "本人于上周购买了 X200 耳机。" },
    "这耳机昨天就不响了。": { 更正式: "该耳机于昨日停止工作。", 更简洁: "耳机昨天坏了。", 更口语: "这耳机昨儿就没声了。" },
    "请把它寄到银行。": { 更口语: "帮我把它寄去银行吧。", 更正式: "请将其邮寄至银行。", 更简洁: "寄到银行。" },
  };
  const k = Object.keys(known[base] ?? {}).find((x) => instruction.includes(x));
  if (k) return known[base][k];
  if (instruction.includes("口语")) return base.replace(/您/g, "你").replace(/。$/, "啦。");
  if (instruction.includes("正式")) return base.replace(/你/g, "您");
  if (instruction.includes("简洁")) return base.replace(/了|就|的/g, "");
  return base.replace(/。$/, "") + "（已按要求修订）。";
}

export function detectLang(text: string): string {
  if (/[぀-ヿ]/.test(text)) return "ja";
  if (/[가-힯]/.test(text)) return "ko";
  if (/[一-鿿]/.test(text)) return "zh";
  return "en";
}

/* ---------------- 会话与记录 ---------------- */

export interface MockRecord extends RecordBrief {
  sessionId: number;
  turnSeq: number;
  sourceLang: string;
  targetLang: string;
  style: TranslateStyle;
}

interface MockSession {
  vo: SessionVO;
  memorySummary: string | null;
  memoryEntities: MemoryEntity[];
  memorizedUntil: number;
  pending: (PendingClarify & { request: TranslateRequest; requestId: string }) | null;
  deleted: boolean;
}

const sessions = new Map<number, MockSession>();
export const records: MockRecord[] = [];
let nextSessionId = 1;
let nextRecordId = 5001;
let seeded = false;

function newSession(p: Partial<SessionVO> & { sourceLang: string; targetLang: string }, createdMin = 0): MockSession {
  const id = nextSessionId++;
  const s: MockSession = {
    vo: {
      id,
      title: p.title ?? "新会话",
      sourceLang: p.sourceLang,
      targetLang: p.targetLang,
      turnCount: 0,
      hasPending: false,
      style: p.style ?? "faithful",
      domain: p.domain ?? null,
      glossaryIds: p.glossaryIds ?? [],
      modelConfigId: p.modelConfigId ?? null,
      clarifyEnabled: p.clarifyEnabled ?? true,
      createdAt: iso(createdMin),
      updatedAt: iso(createdMin),
    },
    memorySummary: null,
    memoryEntities: [],
    memorizedUntil: 0,
    pending: null,
    deleted: false,
  };
  sessions.set(id, s);
  return s;
}

function addRecord(
  s: MockSession,
  p: {
    turnSeq: number;
    sourceText: string;
    targetText: string;
    path: TranslatePath;
    mode?: string;
    reviseInstruction?: string | null;
    clarification?: Clarification | null;
    revisionOf?: number | null;
    reviewScore?: number | null;
    createdMin?: number;
  },
): MockRecord {
  for (const r of records) if (r.sessionId === s.vo.id && r.turnSeq === p.turnSeq) r.adopted = false;
  const r: MockRecord = {
    id: nextRecordId++,
    sessionId: s.vo.id,
    turnSeq: p.turnSeq,
    sourceText: p.sourceText,
    targetText: p.targetText,
    sourceLang: detectLang(p.sourceText),
    targetLang: s.vo.targetLang,
    style: s.vo.style ?? "faithful",
    mode: p.mode ?? (p.path === "revise" ? "revise" : "auto"),
    path: p.path,
    reviseInstruction: p.reviseInstruction ?? null,
    clarification: p.clarification ?? null,
    revisionOf: p.revisionOf ?? null,
    adopted: true,
    reviewScore: p.reviewScore ?? (p.path === "standard" ? 91 : null),
    createdAt: iso(p.createdMin ?? 0),
  };
  records.push(r);
  s.vo.turnCount = new Set(records.filter((x) => x.sessionId === s.vo.id).map((x) => x.turnSeq)).size;
  s.vo.updatedAt = r.createdAt;
  return r;
}

function seed() {
  if (seeded) return;
  seeded = true;
  seedTm();
  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("mock") === "empty") return;

  const a = newSession({ title: "X200 耳机售后", sourceLang: "auto", targetLang: "zh", style: "fluent", domain: "电商" }, 90);
  addRecord(a, { turnSeq: 1, sourceText: "I bought the X200 headphones last week.", targetText: "我上周买了 X200 耳机。", path: "standard", createdMin: 80 });
  const t2 = addRecord(a, { turnSeq: 2, sourceText: "It stopped working yesterday.", targetText: "它昨天就坏了。", path: "fast", createdMin: 70 });
  addRecord(a, {
    turnSeq: 2,
    sourceText: "It stopped working yesterday.",
    targetText: "这耳机昨天就不响了。",
    path: "revise",
    reviseInstruction: "更口语",
    revisionOf: t2.id,
    createdMin: 65,
  });
  addRecord(a, {
    turnSeq: 3,
    sourceText: "Please send it to the bank.",
    targetText: "请把它寄到银行。",
    path: "standard",
    clarification: { question: AMBIGUOUS.bank.question, options: AMBIGUOUS.bank.options, span: "bank", answer: "银行" },
    createdMin: 40,
  });
  a.memoryEntities = [{ source: "X200", target: "X200", note: "耳机型号" }];

  const b = newSession({ title: "餐厅菜单与对话", sourceLang: "en", targetLang: "zh" }, 60 * 26);
  addRecord(b, { turnSeq: 1, sourceText: "Your order has been shipped.", targetText: "您的订单已发货。", path: "fast", createdMin: 60 * 26 });
  b.pending = {
    threadId: "turn:req-mock-pending",
    requestId: "req-mock-pending",
    question: AMBIGUOUS.pitcher.question,
    options: AMBIGUOUS.pitcher.options,
    span: "pitcher",
    reason: AMBIGUOUS.pitcher.reason,
    source: "The pitcher was on the table.",
    request: { text: "The pitcher was on the table.", sourceLang: "en", targetLang: "zh", mode: "auto", style: "faithful", sessionId: b.vo.id },
  };
  b.vo.hasPending = true;
  b.vo.updatedAt = iso(60 * 25);

  const c = newSession({ title: "退款流程咨询", sourceLang: "en", targetLang: "zh", clarifyEnabled: false }, 60 * 24 * 3);
  addRecord(c, { turnSeq: 1, sourceText: "How do I get a refund?", targetText: "我该如何申请退款？", path: "fast", createdMin: 60 * 24 * 3 });
}

export function getSession(id: number): MockSession {
  seed();
  const s = sessions.get(id);
  if (!s || s.deleted) throw new ApiError("A0404", "会话不存在", "mock-a0404", 404);
  return s;
}

function summaryOf(s: MockSession): SessionSummaryVO {
  const { id, title, sourceLang, targetLang, turnCount, hasPending, updatedAt, createdAt } = s.vo;
  return { id, title, sourceLang, targetLang, turnCount, hasPending, updatedAt, createdAt };
}

export function detailOf(s: MockSession): SessionDetailVO {
  const mine = records.filter((r) => r.sessionId === s.vo.id);
  const seqs = [...new Set(mine.map((r) => r.turnSeq))].sort((x, y) => x - y);
  const brief = (r: MockRecord): RecordBrief => ({
    id: r.id,
    sourceText: r.sourceText,
    targetText: r.targetText,
    mode: r.mode,
    path: r.path,
    reviseInstruction: r.reviseInstruction,
    clarification: r.clarification,
    revisionOf: r.revisionOf,
    adopted: r.adopted,
    reviewScore: r.reviewScore,
    createdAt: r.createdAt,
  });
  let pending: PendingClarify | null = null;
  if (s.pending) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { request, requestId, ...rest } = s.pending;
    pending = rest;
  }
  return JSON.parse(
    JSON.stringify({
      ...s.vo,
      hasPending: !!s.pending,
      memorySummary: s.memorySummary,
      memoryEntities: s.memoryEntities,
      memorizedUntil: s.memorizedUntil,
      pending,
      turns: seqs.map((seq) => {
        const vs = mine.filter((r) => r.turnSeq === seq);
        return { seq, versions: vs.map(brief), adoptedRecordId: vs.find((r) => r.adopted)?.id ?? null };
      }),
    }),
  ) as SessionDetailVO;
}

export function listSessions(q: { pageNum?: unknown; pageSize?: unknown; keyword?: unknown }): PageResult<SessionSummaryVO> {
  seed();
  const k = String(q.keyword ?? "").toLowerCase();
  const rows = [...sessions.values()]
    .filter((s) => !s.deleted && (!k || s.vo.title.toLowerCase().includes(k)))
    .sort((a, b) => b.vo.updatedAt.localeCompare(a.vo.updatedAt))
    .map(summaryOf);
  const pageNum = Number(q.pageNum ?? 1);
  const pageSize = Number(q.pageSize ?? 20);
  return { records: rows.slice((pageNum - 1) * pageSize, pageNum * pageSize), total: rows.length, pageNum, pageSize };
}

export function createSession(b: SessionSaveRequest & { sourceLang: string; targetLang: string }): SessionVO {
  seed();
  return { ...newSession({ ...b, title: b.title?.trim() || "新会话" }).vo };
}

export function updateSession(id: number, b: SessionSaveRequest): SessionVO {
  const s = getSession(id);
  const patch = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
  Object.assign(s.vo, patch, { updatedAt: new Date().toISOString() });
  return { ...s.vo };
}

export function deleteSession(id: number) {
  getSession(id).deleted = true;
}

export function adoptRecord(id: number, recordId: number): SessionDetailVO {
  const s = getSession(id);
  const r = records.find((x) => x.id === recordId && x.sessionId === id);
  if (!r) throw new ApiError("A0404", "记录不属于该会话", "mock-a0404", 404);
  for (const x of records) if (x.sessionId === id && x.turnSeq === r.turnSeq) x.adopted = x.id === recordId;
  return detailOf(s);
}

export function findRecord(recordId: number) {
  return records.find((r) => r.id === recordId);
}

/** 新一轮翻译开始：有 pending 时放弃（与 Spring 一致） */
export function beginTurn(sessionId: number) {
  const s = getSession(sessionId);
  s.pending = null;
  s.vo.hasPending = false;
  return s;
}

export function setPending(sessionId: number, p: MockSession["pending"]) {
  const s = getSession(sessionId);
  s.pending = p;
  s.vo.hasPending = !!p;
  s.vo.updatedAt = new Date().toISOString();
}

/** 回答追问：校验 threadId，返回被中断的请求并清空 pending */
export function takePending(sessionId: number, threadId: string) {
  const s = getSession(sessionId);
  if (!s.pending || s.pending.threadId !== threadId) {
    throw new ApiError("A0440", "追问已失效，请重新翻译", "mock-a0440", 409);
  }
  const p = s.pending;
  s.pending = null;
  s.vo.hasPending = false;
  return p;
}

/** 模拟 Spring 写入记录；返回 final 需要追加的字段 */
export function commitTurn(
  sessionId: number,
  p: {
    sourceText: string;
    targetText: string;
    path: TranslatePath;
    clarification?: Clarification | null;
    revisionOf?: number | null;
    instruction?: string | null;
  },
) {
  const s = getSession(sessionId);
  let turnSeq: number;
  if (p.revisionOf) {
    const base = records.find((r) => r.id === p.revisionOf);
    turnSeq = base?.turnSeq ?? s.vo.turnCount + 1;
  } else {
    turnSeq = Math.max(0, ...records.filter((r) => r.sessionId === sessionId).map((r) => r.turnSeq)) + 1;
    if (s.vo.turnCount === 0 && (s.vo.title === "新会话" || !s.vo.title)) {
      const chars = Array.from(p.sourceText.trim());
      s.vo.title = chars.slice(0, 20).join("") + (chars.length > 20 ? "…" : "");
    }
  }
  const r = addRecord(s, {
    turnSeq,
    sourceText: p.sourceText,
    targetText: p.targetText,
    path: p.path,
    reviseInstruction: p.instruction ?? null,
    clarification: p.clarification ?? null,
    revisionOf: p.revisionOf ?? null,
  });
  return { recordId: r.id, sessionId, revisionOf: r.revisionOf, turnSeq };
}

/** 本轮完成后的会话上下文轮数（最近 6 轮已采用版本） */
export function contextTurns(sessionId: number) {
  return Math.min(6, getSession(sessionId).vo.turnCount);
}

/** 压缩条件：完成轮数超过窗口且距上次压缩新增至少 3 轮 */
export function maybeMemorize(sessionId: number, turnSeq: number) {
  const s = getSession(sessionId);
  const until = turnSeq - 6;
  if (until - s.memorizedUntil < 3) return null;
  const covered = records.filter((r) => r.sessionId === sessionId && r.adopted && r.turnSeq <= until);
  s.memorySummary = `用户此前围绕 ${s.vo.title} 进行了 ${until} 轮对话，涉及：${covered
    .slice(0, 3)
    .map((r) => r.sourceText.slice(0, 18))
    .join("；")}…`;
  s.memorizedUntil = until;
  return { summary: s.memorySummary, entities: s.memoryEntities, memorizedUntil: until };
}

/* ---------------- 翻译记忆 ---------------- */

const tm: TmEntry[] = [];
let nextTmId = 1;
let tmSeeded = false;

function seedTm() {
  if (tmSeeded) return;
  tmSeeded = true;
  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("mock") === "empty") return;
  const now = (m: number) => iso(m);
  const add = (s: string, t: string, origin: string, ref: string, ago: number, hits = 0) =>
    tm.push({
      id: nextTmId++,
      sourceLang: detectLang(s),
      targetLang: detectLang(t),
      sourceText: s,
      targetText: t,
      origin,
      originRef: ref,
      hitCount: hits,
      lastHitAt: hits ? now(ago / 2) : null,
      createdAt: now(ago),
      updatedAt: now(ago),
    });
  add("Machine learning models are usually trained on GPUs.", "机器学习模型通常在图形处理器上训练。", "workbench", "102", 60 * 30, 4);
  add("How do I get a refund?", "我该如何申请退款？", "workbench", "96", 60 * 50, 2);
  add("Your order has been shipped.", "您的订单已发货。", "workbench", "95", 60 * 70, 1);
  add("Restart the Pod after updating the ConfigMap.", "更新 ConfigMap 后重启该 Pod。", "document", "1004:9", 60 * 20, 3);
  // 另一份文档（发布说明 v2.3）后编辑过的段落
  // 只取一部分段落，其中一些原文略有改动（模拟另一版本文档），让命中有 100% 也有模糊匹配
  const segs = splitMarkdown(K8S_GUIDE);
  const plain = (t: string) => t.replace(/\*\*|`/g, "");
  let ago = 60 * 24;
  let k = 0;
  for (const [i, s] of segs.entries()) {
    const zh = ZH[s.source];
    if (!s.translatable || !zh || s.source.length < 24) continue;
    k++;
    if (k % 3 === 2) continue;
    const src = k % 3 === 1 ? plain(s.source) : plain(s.source).replace(/\.$/, " in production clusters.");
    add(src, plain(zh), "document", `1004:${i}`, (ago += 37), i % 4);
  }
  add("Please keep {name} and %d unchanged in the output.", "请在输出中保持 {name} 和 %d 不变。", "workbench", "96", 60 * 24 * 6);
  add("今日はいい天気ですね。", "今天天气真好啊。", "workbench", "98", 60 * 24 * 8);
}

export function listTm(q: { pageNum?: unknown; pageSize?: unknown; keyword?: unknown; sourceLang?: unknown; targetLang?: unknown }): PageResult<TmEntry> {
  seed();
  const k = String(q.keyword ?? "").toLowerCase();
  let rows = tm.filter((e) => !k || e.sourceText.toLowerCase().includes(k) || e.targetText.toLowerCase().includes(k));
  if (q.sourceLang) rows = rows.filter((e) => e.sourceLang === q.sourceLang);
  if (q.targetLang) rows = rows.filter((e) => e.targetLang === q.targetLang);
  rows = [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const pageNum = Number(q.pageNum ?? 1);
  const pageSize = Number(q.pageSize ?? 20);
  return { records: rows.slice((pageNum - 1) * pageSize, pageNum * pageSize), total: rows.length, pageNum, pageSize };
}

export function deleteTm(id: number) {
  seed();
  const i = tm.findIndex((e) => e.id === id);
  if (i === -1) throw new ApiError("A0404", "记忆条目不存在", "mock-a0404", 404);
  tm.splice(i, 1);
}

const norm = (s: string) => s.replace(/\*\*|`/g, "").trim().replace(/\s+/g, " ").toLowerCase();

/** 写入（同一语言对 + 规范化原文相同则覆盖） */
export function upsertTm(entries: { sourceLang: string; targetLang: string; sourceText: string; targetText: string; origin: string; originRef: string }[]) {
  seed();
  const t = new Date().toISOString();
  for (const e of entries) {
    const ex = tm.find((x) => x.sourceLang === e.sourceLang && x.targetLang === e.targetLang && norm(x.sourceText) === norm(e.sourceText));
    if (ex) Object.assign(ex, { targetText: e.targetText, origin: e.origin, originRef: e.originRef, updatedAt: t });
    else tm.push({ id: nextTmId++, ...e, hitCount: 0, lastHitAt: null, createdAt: t, updatedAt: t });
  }
  return { written: entries.length };
}

/** 演示用的语义近似：同义改写对 */
const PARAPHRASE: [RegExp, RegExp][] = [[/money back/i, /refund/i]];

/** 混合检索的近似：字符级 fuzzy + 伪语义分；按 max(fuzzy, 0.9·semantic) 降序 */
export function searchTm(text: string, sourceLang: string, targetLang: string, limit = 3, touch = true): TmSearchResult {
  seed();
  const hits: TmHit[] = [];
  const t = text.trim();
  if (!t) return { available: true, hits };
  for (const e of tm) {
    if (e.targetLang !== targetLang || (sourceLang !== "auto" && e.sourceLang !== sourceLang)) continue;
    const ratio = Math.min(e.sourceText.length, t.length) / Math.max(e.sourceText.length, t.length);
    if (ratio < 0.4 && !PARAPHRASE.some(([a, b]) => a.test(t) && b.test(e.sourceText))) continue;
    const fuzzy = similarity(e.sourceText, t);
    let semantic = Math.min(1, fuzzy + 0.06);
    if (PARAPHRASE.some(([a, b]) => a.test(t) && b.test(e.sourceText))) semantic = 0.9132;
    if (fuzzy < FUZZY_MIN && semantic < SEMANTIC_MIN) continue;
    hits.push({
      id: e.id,
      source: e.sourceText,
      target: e.targetText,
      fuzzy: Math.round(fuzzy * 10000) / 10000,
      semantic: Math.round(semantic * 10000) / 10000,
      origin: e.origin,
      originRef: e.originRef,
    });
  }
  hits.sort((a, b) => matchScore(b) - matchScore(a));
  const top = hits.slice(0, limit);
  if (touch) {
    const now = new Date().toISOString();
    for (const h of top) {
      const e = tm.find((x) => x.id === h.id);
      if (e) Object.assign(e, { hitCount: e.hitCount + 1, lastHitAt: now });
    }
  }
  return { available: true, hits: top };
}

/** 文档分段检索（快速近似：完全相同或词集合相似，避免长文档逐段做 LCS） */
export function quickDocHit(source: string, targetLang: string): TmHit | null {
  seed();
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const a = words(source);
  if (a.size < 3) return null;
  let best: TmHit | null = null;
  for (const e of tm) {
    if (e.targetLang !== targetLang) continue;
    let fuzzy: number;
    if (norm(e.sourceText) === norm(source)) fuzzy = 1;
    else {
      const b = words(e.sourceText);
      let inter = 0;
      for (const w of a) if (b.has(w)) inter++;
      fuzzy = inter / (a.size + b.size - inter);
    }
    if (fuzzy < 0.7) continue;
    if (!best || fuzzy > best.fuzzy) {
      best = {
        id: e.id,
        source: e.sourceText,
        target: e.targetText,
        fuzzy: Math.round(fuzzy * 10000) / 10000,
        semantic: Math.round(Math.min(1, fuzzy + 0.04) * 10000) / 10000,
        origin: e.origin,
        originRef: e.originRef,
      };
    }
  }
  return best;
}
