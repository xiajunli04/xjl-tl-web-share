/**
 * 刷新页面后恢复进行中的同传会话：从会话记录还原准备设置，把已落库的转写转换为事件回放进字幕区。
 */
import type { InterpretEndVO } from "@/lib/api/interpret";
import type { InterpretSegmentVO } from "@/lib/api/interpret-history";
import type { InterpretSetup } from "@/stores/interpret-store";
import type { ServerEvent } from "./protocol";

type Options = Record<string, unknown>;

/** AI 对话中 AI 伙伴的发言人 id（与 Spring RoomRegistry.AI_PARTICIPANT 一致） */
export const AI_PARTICIPANT = "ai";
const SCENARIOS = ["free", "travel", "restaurant", "business", "interview"] as const;
const isScenario = (v: unknown): v is (typeof SCENARIOS)[number] => SCENARIOS.includes(v as (typeof SCENARIOS)[number]);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** 由会话记录（含创建时保存的 options）还原准备设置；未保存的字段沿用 base */
export function setupFromSession(session: InterpretEndVO, base: InterpretSetup): InterpretSetup {
  const o: Options = session.options ?? {};
  const langs = session.languages ?? [];
  const next: InterpretSetup = { ...base, mode: session.mode, engine: session.engine };
  if (session.mode === "LISTEN" && langs[0]) next.listenTarget = langs[0];
  if (session.mode === "CONVERSE" && langs.length >= 2) {
    next.converseA = langs[0];
    next.converseB = langs[1];
  }
  if (session.mode === "ROOM" && langs[0]) next.roomLang = langs[0];
  if (session.mode === "CHAT" && langs.length >= 2) {
    next.chatMyLang = langs[0];
    next.chatAiLang = langs[1];
  }
  if (isScenario(o.chatScenario)) next.chatScenario = o.chatScenario;
  if (Array.isArray(o.glossaryIds)) next.glossaryIds = o.glossaryIds.filter((x): x is number => typeof x === "number");
  if (typeof o.domainHint === "string" || o.domainHint === null) next.domainHint = (o.domainHint as string | null) ?? "";
  if (typeof o.tts === "boolean") next.tts = o.tts;
  if (typeof o.headphone === "boolean") next.headphone = o.headphone;
  if (o.gender === "female" || o.gender === "male") next.gender = o.gender;
  if ("ttsEngine" in o) next.ttsEngine = str(o.ttsEngine);
  if ("modelConfigId" in o) next.mtModelConfigId = num(o.modelConfigId);
  if (o.converseRouting === "auto" || o.converseRouting === "ptt") next.converseAuto = o.converseRouting === "auto";
  return next;
}

/** 已落库的转写 → transcript.final / translation.final 事件（utteranceId 加前缀，避免与重连后的新句冲突） */
export function segmentsToEvents(segments: readonly InterpretSegmentVO[]): ServerEvent[] {
  const events: ServerEvent[] = [];
  for (const s of [...segments].sort((a, b) => a.seq - b.seq)) {
    const utteranceId = `history:${s.seq}`;
    const speaker = { participantId: s.speakerParticipant, displayName: s.speakerName, lang: s.sourceLang };
    // AI 对话中 AI 的发言人 id 固定为 "ai"
    const role = s.speakerParticipant === AI_PARTICIPANT ? ("assistant" as const) : undefined;
    events.push({ type: "transcript.final", utteranceId, speaker, role, text: s.sourceText, lang: s.sourceLang, startedMs: s.startedMs, endedMs: s.endedMs });
    for (const [lang, text] of Object.entries(s.translations ?? {})) {
      if (text) events.push({ type: "translation.final", utteranceId, speaker, role, lang, text });
    }
  }
  return events;
}

/** "已进行 3 分钟" / "刚刚开始" */
export function elapsedLabel(startedAt: string | number, now = Date.now()): string {
  const t = typeof startedAt === "number" ? startedAt : Date.parse(startedAt);
  if (!Number.isFinite(t)) return "";
  const min = Math.floor(Math.max(0, now - t) / 60_000);
  if (min < 1) return "刚刚开始";
  if (min < 60) return `已进行 ${min} 分钟`;
  return `已进行 ${Math.floor(min / 60)} 小时 ${min % 60} 分钟`;
}
