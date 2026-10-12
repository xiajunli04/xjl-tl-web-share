/**
 * 事件归并：把下行事件按 utteranceId 聚合为逐句记录（原文 / 各语种译文 / 指标），
 * 并维护成员、延迟统计、错误与结束状态。纯函数，供 interpret-store 与单测使用。
 *
 * 实时字幕渲染规则（improve-speech-endpointing-and-live-ux D9）：
 * - transcript.discard 移除该句（语气词 / 噪声，或让位撤回的 AI 回复）
 * - 新语句按发言流序号插入（utteranceId 形如 "<stream>:<n>"）：迟到的用户转写排在它触发的 AI 回复之前
 * - 过期收尾（兜底，覆盖不发 discard 的引擎）：同一发言流中序号更大的用户语句定稿时，更早的未定稿用户语句
 *   没有译文的移除、有译文的视为已定稿
 * - 没有可显示文字的语句由视图通过 isDisplayable 过滤，不渲染空白气泡
 */
import {
  normLang,
  type EndedStats,
  type Participant,
  type ServerEvent,
  type Speaker,
  type UtteranceMetrics,
  type UtteranceRole,
} from "./protocol";
import type { InterpretMode } from "@/lib/api/interpret";

export interface TranslationPart {
  text: string;
  final: boolean;
  ttsFallback: boolean;
}

export interface Utterance {
  id: string;
  speaker: Speaker | null;
  /** AI 对话中 AI 的回复为 assistant */
  role: UtteranceRole;
  /** AI 回复被打断 */
  interrupted: boolean;
  /** AI 回复需由浏览器朗读（服务端合成不可用） */
  sourceTtsFallback?: boolean;
  source: string;
  sourceFinal: boolean;
  /** 识别出的源语种（transcript.final 后才有） */
  lang: string | null;
  /** 服务端判为未说完、正在等待续说（显示呼吸点而不是光标） */
  hold: boolean;
  /** 最近一次更新的时间 */
  updatedAt: number;
  translations: Record<string, TranslationPart>;
  metrics: UtteranceMetrics | null;
  startedMs?: number;
  endedMs?: number;
  /** 客户端收到首个事件的时间 */
  receivedAt: number;
}

export interface LiveError {
  code: string;
  message: string;
  fatal: boolean;
}

export interface LiveState {
  utterances: Utterance[];
  participants: Participant[];
  ready: Extract<ServerEvent, { type: "ready" }> | null;
  lastE2eMs: number | null;
  e2eSum: number;
  e2eCount: number;
  error: LiveError | null;
  ended: { reason: string; stats: EndedStats | null } | null;
}

/** 内存中最多保留的句数（更早的只保留在服务端记录中） */
export const MAX_UTTERANCES = 500;
/** 按序插入与过期收尾只在末尾这么多条内查找 */
const ORDER_WINDOW = 50;

/** 解析 "<stream>:<n>"（Spring 改写后的 utteranceId）；无法解析时返回 null */
export function streamSeq(id: string): { stream: string; seq: number } | null {
  const i = id.lastIndexOf(":");
  if (i <= 0) return null;
  const seq = Number(id.slice(i + 1));
  return Number.isInteger(seq) ? { stream: id.slice(0, i), seq } : null;
}

/** 新语句的插入位置：同一发言流中第一条序号更大的语句之前；否则追加 */
function insertAt(list: Utterance[], id: string): number {
  const key = streamSeq(id);
  if (!key) return list.length;
  let pos = list.length;
  for (let i = list.length - 1; i >= Math.max(0, list.length - ORDER_WINDOW); i--) {
    const other = streamSeq(list[i].id);
    if (other && other.stream === key.stream && other.seq > key.seq) pos = i;
  }
  return pos;
}

export const initialLiveState = (): LiveState => ({
  utterances: [],
  participants: [],
  ready: null,
  lastE2eMs: null,
  e2eSum: 0,
  e2eCount: 0,
  error: null,
  ended: null,
});

function upsert(
  state: LiveState,
  rawId: string | number,
  speaker: Speaker | null | undefined,
  now: number,
  fn: (u: Utterance) => Utterance,
  role?: UtteranceRole,
): LiveState {
  const id = String(rawId);
  const list = state.utterances;
  // 绝大多数事件属于最近几句：从末尾查找
  let idx = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].id === id) {
      idx = i;
      break;
    }
  }
  if (idx >= 0) {
    const next = list.slice();
    const cur = list[idx];
    let base = speaker && !cur.speaker ? { ...cur, speaker } : cur;
    if (role === "assistant" && base.role !== "assistant") base = { ...base, role };
    next[idx] = fn(base);
    return { ...state, utterances: next };
  }
  const created: Utterance = fn({
    id,
    speaker: speaker ?? null,
    role: role ?? "user",
    interrupted: false,
    source: "",
    sourceFinal: false,
    lang: null,
    hold: false,
    translations: {},
    metrics: null,
    receivedAt: now,
    updatedAt: now,
  });
  const next = list.slice();
  next.splice(insertAt(list, id), 0, created);
  if (next.length > MAX_UTTERANCES) next.splice(0, next.length - MAX_UTTERANCES);
  return { ...state, utterances: next };
}

/** 过期收尾：同一发言流中序号更小、仍未定稿的用户语句不会再有结果 */
function settleStale(state: LiveState, rawId: string | number, role: UtteranceRole | undefined): LiveState {
  if (role === "assistant") return state;
  const key = streamSeq(String(rawId));
  if (!key) return state;
  const list = state.utterances;
  let next: Utterance[] | null = null;
  for (let i = list.length - 1; i >= Math.max(0, list.length - ORDER_WINDOW); i--) {
    const u = list[i];
    const other = streamSeq(u.id);
    if (u.role !== "user" || u.sourceFinal || !other || other.stream !== key.stream || other.seq >= key.seq) continue;
    next ??= list.slice();
    const hasText = Object.values(u.translations).some((t) => t.text);
    if (hasText) next[i] = { ...u, sourceFinal: true, hold: false };
    else next.splice(i, 1);
  }
  return next ? { ...state, utterances: next } : state;
}

function withTranslation(u: Utterance, lang: string, fn: (p: TranslationPart) => TranslationPart): Utterance {
  const cur = u.translations[lang] ?? { text: "", final: false, ttsFallback: false };
  return { ...u, translations: { ...u.translations, [lang]: fn(cur) } };
}

/** 归并一条事件（audio / pong 不影响文本状态，原样返回） */
export function reduceLive(state: LiveState, e: ServerEvent, now = Date.now()): LiveState {
  switch (e.type) {
    case "ready":
      return { ...state, ready: e, error: state.error?.fatal ? state.error : null };
    case "participants":
      return { ...state, participants: e.list ?? [] };
    case "transcript.partial":
      return upsert(
        state,
        e.utteranceId,
        e.speaker,
        now,
        (u) => (u.sourceFinal ? u : { ...u, source: e.text, hold: !!e.hold, updatedAt: now }),
        e.role,
      );
    case "transcript.discard": {
      const id = String(e.utteranceId);
      const utterances = state.utterances.filter((u) => u.id !== id);
      return utterances.length === state.utterances.length ? state : { ...state, utterances };
    }
    case "transcript.final":
      return upsert(
        settleStale(state, e.utteranceId, e.role),
        e.utteranceId,
        e.speaker,
        now,
        (u) => ({
          ...u,
          source: e.text,
          sourceFinal: true,
          hold: false,
          updatedAt: now,
          lang: e.lang ?? u.lang,
          startedMs: e.startedMs ?? u.startedMs,
          endedMs: e.endedMs ?? u.endedMs,
          sourceTtsFallback: e.ttsFallback ?? u.sourceTtsFallback,
        }),
        e.role,
      );
    case "translation.delta":
      return upsert(
        state,
        e.utteranceId,
        e.speaker,
        now,
        (u) => ({ ...withTranslation(u, e.lang, (p) => (p.final ? p : { ...p, text: p.text + e.delta })), updatedAt: now }),
        e.role,
      );
    case "translation.final":
      return upsert(
        state,
        e.utteranceId,
        e.speaker,
        now,
        (u) => withTranslation(u, e.lang, () => ({ text: e.text, final: true, ttsFallback: !!e.ttsFallback })),
        e.role,
      );
    case "reply.interrupted":
      return upsert(
        state,
        e.utteranceId,
        e.speaker,
        now,
        (u) => ({ ...u, interrupted: true, sourceFinal: true, source: u.sourceFinal ? u.source : e.text || u.source }),
        "assistant",
      );
    case "metrics": {
      const m: UtteranceMetrics = {
        asrMs: e.asrMs ?? null,
        mtFirstMs: e.mtFirstMs ?? null,
        mtMs: e.mtMs ?? null,
        ttsFirstMs: e.ttsFirstMs ?? null,
        e2eMs: e.e2eMs ?? null,
        holdMs: e.holdMs ?? null,
      };
      const next = upsert(state, e.utteranceId, e.speaker, now, (u) => ({ ...u, metrics: m }), e.role);
      if (typeof m.e2eMs === "number" && m.e2eMs >= 0) {
        return { ...next, lastE2eMs: m.e2eMs, e2eSum: state.e2eSum + m.e2eMs, e2eCount: state.e2eCount + 1 };
      }
      return next;
    }
    case "error":
      return { ...state, error: { code: e.code, message: e.message, fatal: !!e.fatal } };
    case "ended":
      return { ...state, ended: { reason: e.reason, stats: e.stats ?? null } };
    default:
      return state;
  }
}

/* ---------------- 派生 ---------------- */

/** 某句在 lang 下应显示的文本：源语种即 lang 时显示原文，否则显示该语种译文 */
export function textIn(u: Utterance, lang: string): { text: string; final: boolean; isSource: boolean } {
  if (normLang(u.lang) === lang) return { text: u.source, final: u.sourceFinal, isSource: true };
  const t = u.translations[lang];
  if (t) return { text: t.text, final: t.final, isSource: false };
  return { text: "", final: false, isSource: false };
}

/** 某句在 lang 下可显示的文字：该语种文本，没有时先显示原文（译文未到） */
export function visibleText(u: Utterance, lang: string | null): string {
  if (!lang) return u.source;
  return textIn(u, lang).text || u.source;
}

/** 有可显示文字才渲染（避免空白气泡 / 孤立光标）；lang 为空时只看原文与任意译文 */
export function isDisplayable(u: Utterance, lang: string | null = null): boolean {
  if (visibleText(u, lang).trim()) return true;
  return !lang && Object.values(u.translations).some((t) => t.text.trim());
}

/**
 * 该句是否仍在进行（视图据此显示光标或呼吸点）：原文未定稿，或该语种译文未定稿；
 * hold 时返回 "hold"（等待续说，显示呼吸点），其余进行中为 "live"，已结束为 null。
 */
export function liveState(u: Utterance, lang: string | null = null): "live" | "hold" | null {
  if (u.interrupted) return null;
  if (!u.sourceFinal) return u.hold ? "hold" : "live";
  if (!lang) return null;
  const t = textIn(u, lang);
  return t.final ? null : "live";
}

/** 本机未定稿语句的有效期：超过后视为已放弃（防止服务端漏发事件时一直推迟开播） */
export const OPEN_TURN_MS = 3000;

/**
 * 本机是否有尚未定稿的语句（含等待续说）：最近 OPEN_TURN_MS 内更新过、来自本人发言流、角色为用户且未定稿。
 * mine 为本人的 participantId（Spring 改写的 utteranceId 前缀）。
 */
export function localTurnOpen(state: Pick<LiveState, "utterances">, mine: string | null | undefined, now: number): boolean {
  if (!mine) return false;
  const list = state.utterances;
  for (let i = list.length - 1; i >= Math.max(0, list.length - 10); i--) {
    const u = list[i];
    if (u.role !== "user" || streamSeq(u.id)?.stream !== mine) continue;
    return !u.sourceFinal && now - u.updatedAt <= OPEN_TURN_MS;
  }
  return false;
}

/** 某发言流最近一条用户语句（没有时返回 null） */
export function latestUserUtterance(state: Pick<LiveState, "utterances">, stream: string | null | undefined): Utterance | null {
  if (!stream) return null;
  const list = state.utterances;
  for (let i = list.length - 1; i >= Math.max(0, list.length - 10); i--) {
    const u = list[i];
    if (u.role === "user" && streamSeq(u.id)?.stream === stream) return u;
  }
  return null;
}

/** 某发言流最近一条未定稿的用户语句（没有时返回 null） */
export function openUtterance(state: Pick<LiveState, "utterances">, stream: string | null | undefined): Utterance | null {
  const u = latestUserUtterance(state, stream);
  return u && !u.sourceFinal ? u : null;
}

/** 最近一条 AI 回复（未打断） */
export function lastReply(state: Pick<LiveState, "utterances">): Utterance | null {
  const list = state.utterances;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].role === "assistant") return list[i].interrupted ? null : list[i];
  return null;
}

/** CONVERSE：按识别语种决定译向另一侧；未识别时取已有译文的语种 */
export function converseTarget(u: Utterance, languages: [string, string] | string[]): string | null {
  const [a, b] = languages;
  const src = normLang(u.lang);
  if (src === a) return b;
  if (src === b) return a;
  const keys = Object.keys(u.translations);
  return keys.find((k) => k === a || k === b) ?? null;
}

export type StageStatus = "listening" | "recognizing" | "translating" | "speaking" | "paused";

/** 状态胶囊：播报 > 翻译 > 识别 > 聆听；静音时为暂停 */
export function stageStatus(
  state: Pick<LiveState, "utterances">,
  opts: { playing: boolean; muted: boolean; lang?: string | null },
): StageStatus {
  if (opts.playing) return "speaking";
  const last = state.utterances.at(-1);
  if (last && !last.sourceFinal && last.source) return "recognizing";
  if (last && last.sourceFinal && !last.metrics) {
    const parts = Object.values(last.translations);
    const pending = opts.lang
      ? normLang(last.lang) !== opts.lang && !last.translations[opts.lang]?.final
      : parts.length === 0 || parts.some((p) => !p.final);
    if (pending) return "translating";
  }
  return opts.muted ? "paused" : "listening";
}

/**
 * AI 对话：是否在等 AI 回复（数字人"思考"）——刚就绪尚无语句（准备开场白）、最近一句是已定稿的用户句，或 AI 回复尚无文字。
 * 其他模式：最近一句已定稿而译文未到（与状态胶囊的"翻译"一致）。
 */
export function awaitingReply(
  state: Pick<LiveState, "utterances"> & Partial<Pick<LiveState, "ready">>,
  mode: InterpretMode | null | undefined,
): boolean {
  const last = state.utterances.at(-1);
  // AI 对话刚就绪、还没有任何语句：AI 正在准备开场白
  if (!last) return mode === "CHAT" && !!state.ready;
  if (mode === "CHAT") {
    if (last.role === "assistant") return !last.source && !last.interrupted;
    return last.sourceFinal;
  }
  return stageStatus(state, { playing: false, muted: false }) === "translating";
}

/** 延迟胶囊文案："2.4 s" */
export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "--";
  return `${(ms / 1000).toFixed(1)} s`;
}

/** 时长文案：mm:ss 或 h:mm:ss */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export interface SessionSummary {
  durationMs: number;
  utterances: number;
  avgE2eMs: number | null;
}

/** 结束摘要：优先使用服务端统计，缺失项用本地归并结果补齐 */
export function summarize(state: LiveState, startedAt: number, endedAt: number, server?: EndedStats | null): SessionSummary {
  const local: SessionSummary = {
    durationMs: Math.max(0, endedAt - startedAt),
    utterances: state.utterances.filter((u) => u.sourceFinal).length,
    avgE2eMs: state.e2eCount ? Math.round(state.e2eSum / state.e2eCount) : null,
  };
  return {
    durationMs: server?.durationMs ?? local.durationMs,
    utterances: server?.utterances ?? local.utterances,
    avgE2eMs: server?.avgE2eMs ?? local.avgE2eMs,
  };
}

/** LISTEN 的目标语言 / ROOM 的"我的语言"；CONVERSE 返回 null（按句决定） */
export function primaryLang(mode: InterpretMode, languages: string[]): string | null {
  return mode === "CONVERSE" ? null : (languages[0] ?? null);
}
