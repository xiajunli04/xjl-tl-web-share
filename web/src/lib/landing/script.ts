/**
 * 首页脚本化演示的时间线（add-ai-avatar-and-landing D8）：纯函数，便于单测与 reduced-motion 直达终态。
 *
 * - 一段脚本是若干步骤，每步在 at 毫秒开始，持续 dur 毫秒（瞬时步骤 dur 为 0）
 * - stateAt(steps, initial, t)：依次应用 at ≤ t 的步骤，进度 = (t - at) / dur（封顶 1）
 * - 流式文本用 streamText(text, progress) 取前缀；分支（歧义追问）由组件切换脚本实现
 */

export interface Step<S> {
  at: number;
  dur?: number;
  apply: (state: S, progress: number) => S;
}

export function stateAt<S>(steps: readonly Step<S>[], initial: S, t: number): S {
  let s = initial;
  for (const step of steps) {
    if (step.at > t) continue;
    const progress = step.dur ? Math.min(1, (t - step.at) / step.dur) : 1;
    s = step.apply(s, progress);
  }
  return s;
}

/** 脚本总时长（毫秒） */
export function duration<S>(steps: readonly Step<S>[]): number {
  return steps.reduce((max, st) => Math.max(max, st.at + (st.dur ?? 0)), 0);
}

/** 按进度取文本前缀（按字符，兼容中文与 emoji） */
export function streamText(text: string, progress: number): string {
  const chars = Array.from(text);
  return chars.slice(0, Math.round(chars.length * Math.max(0, Math.min(1, progress)))).join("");
}

/** 按每秒字数估算流式输出时长（中文约 18 字/秒，英文约 45 字符/秒） */
export function streamDuration(text: string, cps = 30): number {
  return Math.round((Array.from(text).length / cps) * 1000);
}

/* ---------------- Agent 轨迹演示的状态 ---------------- */

export type StageKey = "analyze" | "plan" | "translate" | "review" | "refine";
export type StageStatus = "pending" | "active" | "done" | "skipped";

export interface TraceState {
  stages: Record<StageKey, StageStatus>;
  /** 每个阶段完成后的一句说明 */
  notes: Partial<Record<StageKey, string>>;
  output: string;
  /** 歧义追问：出现时脚本暂停等待选择 */
  question: { prompt: string; options: string[] } | null;
  chips: string[];
}

export const STAGES: StageKey[] = ["analyze", "plan", "translate", "review", "refine"];

export const initialTrace = (): TraceState => ({
  stages: { analyze: "pending", plan: "pending", translate: "pending", review: "pending", refine: "pending" },
  notes: {},
  output: "",
  question: null,
  chips: [],
});

/** 步骤构造：阶段开始 / 完成 / 跳过 */
export function stage<S extends TraceState>(at: number, key: StageKey, status: StageStatus, note?: string): Step<S> {
  return {
    at,
    apply: (s) => ({
      ...s,
      stages: { ...s.stages, [key]: status },
      notes: note ? { ...s.notes, [key]: note } : s.notes,
    }),
  };
}

/** 步骤构造：在 at 开始流式输出译文 */
export function output<S extends TraceState>(at: number, text: string, cps = 22): Step<S> {
  return { at, dur: streamDuration(text, cps), apply: (s, p) => ({ ...s, output: streamText(text, p) }) };
}

/** 步骤构造：追加一个标签（命中术语、记忆等） */
export function chip<S extends TraceState>(at: number, label: string): Step<S> {
  return { at, apply: (s) => (s.chips.includes(label) ? s : { ...s, chips: [...s.chips, label] }) };
}
