import {
  GitForkIcon,
  ListOrderedIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import type { DocOptions, DocPhase, DocStatus, DocStrategy, DocTaskSummaryVO } from "@/lib/api/documents";

export type Tone = "brand" | "success" | "warning" | "danger" | "info" | "muted";

export const STATUS_META: Record<DocStatus, { label: string; tone: Tone; live?: boolean }> = {
  PENDING: { label: "排队中", tone: "muted", live: true },
  PARSING: { label: "解析中", tone: "brand", live: true },
  ANALYZING: { label: "分析中", tone: "brand", live: true },
  AWAITING_CONFIRM: { label: "待确认术语", tone: "warning", live: true },
  TRANSLATING: { label: "翻译中", tone: "brand", live: true },
  CONSISTENCY: { label: "一致性检查", tone: "brand", live: true },
  COMPLETED: { label: "已完成", tone: "success" },
  FAILED: { label: "失败", tone: "danger" },
  CANCELLING: { label: "取消中", tone: "warning", live: true },
  CANCELLED: { label: "已取消", tone: "muted" },
};

/** 正在占用执行资源的状态（可取消） */
export const CANCELLABLE: DocStatus[] = [
  "PENDING",
  "PARSING",
  "ANALYZING",
  "AWAITING_CONFIRM",
  "TRANSLATING",
  "CONSISTENCY",
];

export const canCancel = (s: DocStatus) => CANCELLABLE.includes(s);
export const canRetry = (t: Pick<DocTaskSummaryVO, "status" | "retryable">) =>
  t.status === "CANCELLED" || (t.status === "FAILED" && t.retryable !== false);

export type StatusGroup = "all" | "active" | "awaiting" | "completed" | "failed" | "cancelled";

export const STATUS_GROUPS: { value: StatusGroup; label: string; match: (s: DocStatus) => boolean }[] = [
  { value: "all", label: "全部", match: () => true },
  {
    value: "active",
    label: "进行中",
    match: (s) => ["PENDING", "PARSING", "ANALYZING", "TRANSLATING", "CONSISTENCY", "CANCELLING"].includes(s),
  },
  { value: "awaiting", label: "待确认", match: (s) => s === "AWAITING_CONFIRM" },
  { value: "completed", label: "已完成", match: (s) => s === "COMPLETED" },
  { value: "failed", label: "失败", match: (s) => s === "FAILED" },
  { value: "cancelled", label: "已取消", match: (s) => s === "CANCELLED" },
];

/* ---------- 阶段步进 ---------- */

export const PHASE_STEPS = [
  { key: "parsing", label: "解析" },
  { key: "analyzing", label: "分析" },
  { key: "terms", label: "术语" },
  { key: "translating", label: "翻译" },
  { key: "consistency", label: "一致性" },
  { key: "done", label: "完成" },
] as const;

const PHASE_INDEX: Record<DocPhase, number> = {
  parsing: 0,
  analyzing: 1,
  awaiting_confirm: 2,
  translating: 3,
  consistency: 4,
  assembling: 4,
};

const STATUS_INDEX: Partial<Record<DocStatus, number>> = {
  PENDING: 0,
  PARSING: 0,
  ANALYZING: 1,
  AWAITING_CONFIRM: 2,
  TRANSLATING: 3,
  CONSISTENCY: 4,
  COMPLETED: 6,
};

/** 当前所处的步骤下标（0–5；全部完成时为 6） */
export function stepIndexOf(t: Pick<DocTaskSummaryVO, "status" | "phase">): number {
  const byStatus = STATUS_INDEX[t.status];
  if (byStatus !== undefined) return byStatus;
  const phase = t.phase?.toLowerCase() as DocPhase | undefined;
  return phase && phase in PHASE_INDEX ? PHASE_INDEX[phase] : 0;
}

/** 列表卡片上的"阶段 4/6" */
export function phaseLabel(t: Pick<DocTaskSummaryVO, "status" | "phase">) {
  const i = Math.min(stepIndexOf(t), PHASE_STEPS.length - 1);
  return `${PHASE_STEPS[i].label} · ${Math.min(i + 1, PHASE_STEPS.length)}/${PHASE_STEPS.length}`;
}

/* ---------- 策略与实验选项（design.md D5 / D12） ---------- */

export const STRATEGY_META: Record<DocStrategy, { label: string; icon: LucideIcon; desc: string; recommended?: boolean }> = {
  serial: {
    label: "串行",
    icon: ListOrderedIcon,
    desc: "全文一组、逐块顺序翻译，可携带前块上下文与滚动专名表，一致性最好",
  },
  parallel: {
    label: "并行",
    icon: ZapIcon,
    desc: "每块独立并发翻译，速度最快；块间不共享上下文，依赖一致性阶段兜底",
  },
  hybrid: {
    label: "混合",
    icon: GitForkIcon,
    desc: "按二级标题分章，章内串行、章间并行，兼顾速度与连贯；没有二级标题时等同串行",
    recommended: true,
  },
};

export const OPTION_META: { key: keyof DocOptions; label: string; desc: string }[] = [
  {
    key: "contextWindow",
    label: "前块上下文",
    desc: "翻译每块时附带前一块原文与译文的最后 2 段，保证衔接（仅组内串行时生效）",
  },
  {
    key: "globalSummary",
    label: "全文摘要",
    desc: "先生成全文摘要并注入每块的提示词，帮助模型把握篇章主旨与领域",
  },
  {
    key: "termExtraction",
    label: "术语抽取",
    desc: "从全文抽取候选术语与专名，与术语库合并为任务术语表；关闭后只使用术语库",
  },
  {
    key: "review",
    label: "评审修正",
    desc: "每块翻译后按 MQM 维度评审，存在 major 及以上问题时修正 1 轮；耗时与用量明显增加，适合质量优先的场景",
  },
  {
    key: "translationMemory",
    label: "翻译记忆",
    desc: "每段检索你的翻译记忆，把相近的历史译文作为参考写入提示词（参考而非照抄）；记忆来自存入记忆与后编辑",
  },
];

export type PresetGroup = "recommended" | "experiment";

export interface Preset {
  key: string;
  name: string;
  caption: string;
  options: DocOptions;
  strategy: DocStrategy;
  group: PresetGroup;
}

/** 消融组 D0–D6 复现记忆功能上线前的实验配置，统一关闭翻译记忆；推荐配置开启 */
const o = (
  contextWindow: boolean,
  globalSummary: boolean,
  termExtraction: boolean,
  review: boolean,
  translationMemory = false,
): DocOptions => ({
  contextWindow,
  globalSummary,
  termExtraction,
  review,
  translationMemory,
});

export const RECOMMENDED_KEY = "R";

/** 「推荐」预设（与接口缺省值一致）+ D12 消融组 D0–D6 */
export const PRESETS: Preset[] = [
  {
    key: RECOMMENDED_KEY,
    name: "推荐",
    caption: "上下文 + 摘要 + 术语 + 记忆，不评审",
    options: o(true, true, true, false, true),
    strategy: "hybrid",
    group: "recommended",
  },
  { key: "D0", name: "逐段独立", caption: "无任何篇章上下文", options: o(false, false, false, false), strategy: "parallel", group: "experiment" },
  { key: "D1", name: "+ 前块上下文", caption: "串行，携带上一块", options: o(true, false, false, false), strategy: "serial", group: "experiment" },
  { key: "D2", name: "+ 全文摘要", caption: "注入篇章摘要", options: o(true, true, false, false), strategy: "serial", group: "experiment" },
  { key: "D3", name: "+ 术语抽取", caption: "自动形成术语表", options: o(true, true, true, false), strategy: "serial", group: "experiment" },
  { key: "D4", name: "+ 评审修正", caption: "完整流水线", options: o(true, true, true, true), strategy: "serial", group: "experiment" },
  { key: "D5", name: "并行", caption: "完整能力，块间并发", options: o(true, true, true, true), strategy: "parallel", group: "experiment" },
  { key: "D6", name: "混合", caption: "完整能力，章内串行", options: o(true, true, true, true), strategy: "hybrid", group: "experiment" },
];

/** 与接口缺省值一致（design.md D3）：混合策略、人工确认、文档默认不评审、开启翻译记忆 */
export const DEFAULT_OPTIONS: DocOptions = o(true, true, true, false, true);

/** 补齐缺省值：旧后端返回的 options 没有 translationMemory 时按接口缺省值 true 处理 */
export function normalizeOptions(options: Partial<DocOptions> | null | undefined): DocOptions {
  return {
    contextWindow: options?.contextWindow ?? DEFAULT_OPTIONS.contextWindow,
    globalSummary: options?.globalSummary ?? DEFAULT_OPTIONS.globalSummary,
    termExtraction: options?.termExtraction ?? DEFAULT_OPTIONS.termExtraction,
    review: options?.review ?? DEFAULT_OPTIONS.review,
    translationMemory: options?.translationMemory ?? DEFAULT_OPTIONS.translationMemory,
  };
}
export const DEFAULT_STRATEGY: DocStrategy = "hybrid";
export const DEFAULT_CONFIRM_TERMS = true;

export const isRecommended = (p: Preset | undefined) => p?.key === RECOMMENDED_KEY;

/** 预设的展示名：推荐预设显示「推荐配置」，消融组显示「D3 · + 术语抽取」 */
export function presetLabel(p: Preset | undefined, fallback = "自定义") {
  if (!p) return fallback;
  return isRecommended(p) ? "推荐配置" : `${p.key} · ${p.name}`;
}

/** 识别预设：先补齐缺省值（兼容缺少 translationMemory 的旧数据），再逐项比较全部开关 */
export function presetOf(options: Partial<DocOptions> | null | undefined, strategy: DocStrategy): Preset | undefined {
  const n = normalizeOptions(options);
  return PRESETS.find(
    (p) =>
      p.strategy === strategy &&
      (Object.keys(p.options) as (keyof DocOptions)[]).every((k) => p.options[k] === n[k]),
  );
}

/* ---------- 格式化与估算 ---------- */

export function formatChars(n: number) {
  if (n >= 10_000) return `${(n / 10_000).toFixed(n >= 100_000 ? 0 : 1)} 万字`;
  return `${n.toLocaleString("en-US")} 字`;
}

export function formatTokens(n: number | null | undefined) {
  if (!n) return "0";
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString("en-US");
}

export function relativeTime(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return "-";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const s = Math.round((now - t) / 1000);
  if (s < 45) return "刚刚";
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86_400) return `${Math.round(s / 3600)} 小时前`;
  if (s < 86_400 * 7) return `${Math.round(s / 86_400)} 天前`;
  return new Date(t).toLocaleDateString("zh-CN");
}

export function formatDuration(ms: number | null | undefined) {
  if (!ms || ms < 0) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

/** D4 的 token 估算：中日韩字符按 1，其余每 4 个字符 1 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) if (/[぀-ヿ㐀-鿿가-힯]/.test(ch)) cjk++;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

/** 预估分块数：token / 1800，且不少于一、二级标题的章节数 */
export function estimateChunks(text: string, format: "md" | "txt"): number {
  if (!text.trim()) return 0;
  const byTokens = Math.ceil(estimateTokens(text) / 1800);
  const sections = format === "md" ? (text.match(/^#{1,2}\s/gm)?.length ?? 0) : 0;
  return Math.max(1, byTokens, sections);
}

/** 混合策略的分组数：按二级标题分章（纯文本或没有二级标题时为 1 组） */
export function estimateGroups(text: string, format: "md" | "txt"): number {
  if (format !== "md") return 1;
  return Math.max(1, text.match(/^##\s/gm)?.length ?? 0);
}

/** 单个任务内组间并发上限（python-backend doc_chunk_concurrency） */
export const CHUNK_LANES = 3;

/**
 * 预估耗时（秒）：每块翻译约 12 秒；评审每块多一次调用约 8 秒，按严重度规则偶尔修正再折算约 2 秒
 * （实验中评审使耗时增加约 83%）。并行按 3 路并发；混合按章节数并发（最多 3 路，只有 1 章时等同串行）。
 */
export function estimateSeconds(chunks: number, options: DocOptions, strategy: DocStrategy, groups = 1) {
  const perChunk = 12 + (options.review ? 10 : 0);
  const lanes = strategy === "parallel" ? CHUNK_LANES : strategy === "hybrid" ? Math.min(CHUNK_LANES, Math.max(1, groups)) : 1;
  const analysis = options.globalSummary || options.termExtraction ? 20 : 4;
  return analysis + Math.ceil(chunks / lanes) * perChunk + 10;
}

export function toneText(t: Tone) {
  return {
    brand: "text-brand",
    success: "text-success",
    warning: "text-warning",
    danger: "text-danger",
    info: "text-info",
    muted: "text-muted-foreground",
  }[t];
}

export function toneSoft(t: Tone) {
  return {
    brand: "bg-brand-soft text-brand ring-brand/25",
    success: "bg-success-soft text-success ring-success/25",
    warning: "bg-warning-soft text-warning ring-warning/25",
    danger: "bg-danger-soft text-danger ring-danger/25",
    info: "bg-info-soft text-info ring-info/25",
    muted: "bg-muted text-muted-foreground ring-border",
  }[t];
}

export function toneDot(t: Tone) {
  return {
    brand: "bg-brand",
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-danger",
    info: "bg-info",
    muted: "bg-muted-foreground/50",
  }[t];
}
