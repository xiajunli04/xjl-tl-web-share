import type { DocTermStatus, DocTermVO } from "@/lib/api/documents";

/** 任务术语按状态分组（工作区「术语」标签页的只读视图） */

export type TermGroupKey = "pending" | "confirmed" | "auto" | "rejected";

export interface TermGroupMeta {
  key: TermGroupKey;
  label: string;
  /** 分组说明（标题右侧的小字） */
  hint: string;
  /** 默认是否展开 */
  defaultOpen: boolean;
}

export const TERM_GROUPS: readonly TermGroupMeta[] = [
  { key: "pending", label: "待确认", hint: "等待人工确认", defaultOpen: true },
  { key: "confirmed", label: "已确认 / 术语库", hint: "强制使用", defaultOpen: true },
  { key: "auto", label: "参考（自动采用）", hint: "未经确认，仅供参考", defaultOpen: true },
  { key: "rejected", label: "已拒绝", hint: "不参与翻译", defaultOpen: false },
];

const GROUP_OF: Record<DocTermStatus, TermGroupKey> = {
  PENDING: "pending",
  CONFIRMED: "confirmed",
  AUTO: "auto",
  REJECTED: "rejected",
};

/** 未知状态（后端新增取值）归入"待确认"，避免术语被吞掉 */
export function termGroupOf(status: string): TermGroupKey {
  return GROUP_OF[status as DocTermStatus] ?? "pending";
}

export interface TermGroup extends TermGroupMeta {
  terms: DocTermVO[];
}

/** 按固定顺序分组，只返回非空分组；组内按出现次数降序、源词升序 */
export function groupTerms(terms: readonly DocTermVO[] | null | undefined): TermGroup[] {
  if (!terms?.length) return [];
  const buckets = new Map<TermGroupKey, DocTermVO[]>();
  for (const t of terms) {
    const k = termGroupOf(t.status);
    const list = buckets.get(k);
    if (list) list.push(t);
    else buckets.set(k, [t]);
  }
  return TERM_GROUPS.filter((g) => buckets.has(g.key)).map((g) => ({
    ...g,
    terms: buckets.get(g.key)!.sort((a, b) => b.frequency - a.frequency || a.source.localeCompare(b.source)),
  }));
}

/** 在翻译中生效的术语数（强制 + 参考），用于标签页计数 */
export function activeTermCount(terms: readonly DocTermVO[] | null | undefined): number {
  return terms?.filter((t) => t.status === "CONFIRMED" || t.status === "AUTO").length ?? 0;
}
