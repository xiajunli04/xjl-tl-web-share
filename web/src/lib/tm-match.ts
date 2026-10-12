import type { TmHit } from "@/lib/api/translate";

/** 入选阈值（与 AI 服务一致）：fuzzy ≥ 0.6 或 semantic ≥ 0.85 */
export const FUZZY_MIN = 0.6;
export const SEMANTIC_MIN = 0.85;

export type MatchKind = "exact" | "fuzzy" | "semantic";

export interface MatchInfo {
  kind: MatchKind;
  /** 0–100 的整数 */
  percent: number;
  /** 徽章文字：100% / 92% / 语义 */
  label: string;
  /** 悬停说明 */
  title: string;
}

const clamp01 = (v: unknown) => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
  return Math.min(1, Math.max(0, n));
};

/**
 * 匹配度徽章：fuzzy=1 为 100% 匹配；fuzzy 达到阈值时显示字面匹配度（非完全匹配最多显示 99%，
 * 避免四舍五入出"假 100%"）；只靠语义入选时显示"语义"与语义相似度。
 */
export function matchInfo(hit: Pick<TmHit, "fuzzy" | "semantic">): MatchInfo {
  const fuzzy = clamp01(hit.fuzzy);
  const semantic = clamp01(hit.semantic);
  const sem = Math.round(semantic * 100);
  if (fuzzy >= 0.99995) {
    return { kind: "exact", percent: 100, label: "100%", title: "原文完全相同" };
  }
  if (fuzzy >= FUZZY_MIN) {
    const p = Math.min(99, Math.round(fuzzy * 100));
    return { kind: "fuzzy", percent: p, label: `${p}%`, title: `字面匹配 ${p}% · 语义相似 ${sem}%` };
  }
  return { kind: "semantic", percent: sem, label: "语义", title: `字面匹配 ${Math.round(fuzzy * 100)}% · 语义相似 ${sem}%` };
}

/** 排序分（与检索一致）：max(fuzzy, 0.9 × semantic) */
export function matchScore(hit: Pick<TmHit, "fuzzy" | "semantic">): number {
  return Math.max(clamp01(hit.fuzzy), 0.9 * clamp01(hit.semantic));
}

export interface OriginInfo {
  /** 工作台 / 文档 / 其他 */
  kind: "workbench" | "document" | "other";
  label: string;
  /** 跳转链接；无法解析时为 null */
  href: string | null;
}

/** 来源与跳转：workbench → 历史记录详情；document（"taskId:seq"）→ 文档工作区并定位段落 */
export function originInfo(origin: string | null | undefined, originRef: string | null | undefined): OriginInfo {
  const ref = (originRef ?? "").trim();
  if (origin === "workbench") {
    const id = /^\d+$/.test(ref) ? ref : null;
    return { kind: "workbench", label: id ? `工作台 · 记录 #${id}` : "工作台", href: id ? `/history?open=${id}` : null };
  }
  if (origin === "document") {
    const m = /^(\d+):(\d+)$/.exec(ref);
    if (m) return { kind: "document", label: `文档任务 #${m[1]} · §${m[2]}`, href: `/documents/${m[1]}?seq=${m[2]}` };
    return { kind: "document", label: "文档", href: null };
  }
  return { kind: "other", label: origin || "未知来源", href: null };
}
