import type { Clarification } from "@/lib/api/translate";
import type { RecordBrief, SessionDetailVO, SessionSummaryVO, Turn } from "@/lib/api/sessions";

/**
 * 会话对话线程的纯函数：把会话详情的 turns 组装为线程卡片所需的结构（版本链、采用版本、追问问答），
 * 并对后端缺字段、版本乱序、采用标记缺失等情况做兜底。
 */

export interface ThreadVersion extends RecordBrief {
  /** 从 1 开始的版本号（v1 为原始翻译） */
  no: number;
  label: string;
}

export interface ThreadTurn {
  seq: number;
  versions: ThreadVersion[];
  /** 当前采用（展示）的版本 */
  adopted: ThreadVersion;
  adoptedIndex: number;
  /** 本轮原文（取 v1） */
  source: string;
  /** 本轮的追问问答（任一版本上有即可，通常在 v1） */
  clarification: Clarification | null;
}

function time(s: string | null | undefined) {
  const t = s ? new Date(s).getTime() : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/** 版本按 createdAt 升序，时间相同按 id 升序 */
export function sortVersions(versions: RecordBrief[]): RecordBrief[] {
  return [...versions].sort((a, b) => time(a.createdAt) - time(b.createdAt) || a.id - b.id);
}

/**
 * 采用版本：优先使用乐观覆盖（用户刚点了某个版本）→ adoptedRecordId → adopted=true 的最后一个 → 最新版本。
 */
export function pickAdopted(turn: Pick<Turn, "versions" | "adoptedRecordId">, override?: number): number {
  const vs = turn.versions;
  const byId = (id: number | null | undefined) => (id == null ? -1 : vs.findIndex((v) => v.id === id));
  let i = byId(override);
  if (i === -1) i = byId(turn.adoptedRecordId);
  if (i === -1) {
    for (let k = vs.length - 1; k >= 0; k--) {
      if (vs[k].adopted) {
        i = k;
        break;
      }
    }
  }
  return i === -1 ? vs.length - 1 : i;
}

/** 组装线程：overrides 为 seq → 乐观采用的记录 id */
export function buildThread(
  detail: Pick<SessionDetailVO, "turns"> | null | undefined,
  overrides?: ReadonlyMap<number, number>,
): ThreadTurn[] {
  const turns = Array.isArray(detail?.turns) ? detail.turns : [];
  const out: ThreadTurn[] = [];
  for (const t of [...turns].sort((a, b) => a.seq - b.seq)) {
    const sorted = sortVersions(Array.isArray(t.versions) ? t.versions : []);
    if (!sorted.length) continue;
    const versions: ThreadVersion[] = sorted.map((v, i) => ({ ...v, no: i + 1, label: `v${i + 1}` }));
    const adoptedIndex = pickAdopted({ versions, adoptedRecordId: t.adoptedRecordId ?? null }, overrides?.get(t.seq));
    out.push({
      seq: t.seq,
      versions,
      adopted: versions[adoptedIndex],
      adoptedIndex,
      source: versions[0].sourceText ?? "",
      clarification: versions.find((v) => v.clarification)?.clarification ?? null,
    });
  }
  return out;
}

/** 记录所在的轮次 seq（找不到返回 null） */
export function turnOfRecord(turns: ThreadTurn[], recordId: number | null | undefined): number | null {
  if (recordId == null) return null;
  return turns.find((t) => t.versions.some((v) => v.id === recordId))?.seq ?? null;
}

/** 会话列表按更新时间分组：今天 / 更早（组内保持传入顺序，空组不返回） */
export function groupSessions<T extends Pick<SessionSummaryVO, "updatedAt">>(
  list: T[],
  now: Date = new Date(),
): { key: "today" | "earlier"; label: string; items: T[] }[] {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const today: T[] = [];
  const earlier: T[] = [];
  for (const s of list) (time(s.updatedAt) >= start ? today : earlier).push(s);
  const groups: { key: "today" | "earlier"; label: string; items: T[] }[] = [];
  if (today.length) groups.push({ key: "today", label: "今天", items: today });
  if (earlier.length) groups.push({ key: "earlier", label: "更早", items: earlier });
  return groups;
}

/** 修订快捷要求 */
export const REVISE_CHIPS = ["更口语", "更正式", "更简洁", "保持术语"] as const;

/** 默认会话标题（与后端缺省规则一致：首轮原文前 20 个字符） */
export function defaultTitle(text: string) {
  const t = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(t);
  return chars.length > 20 ? chars.slice(0, 20).join("") + "…" : t || "新会话";
}
