/**
 * 文本差异（翻译记忆「原文差异高亮」与 mock 的模糊匹配度）。
 * 先去掉公共前后缀，再对中间部分做 LCS；拉丁字母与数字按词切分、其余字符（含中日韩）逐字切分，
 * 这样英文高亮落在整词上，中文仍是逐字对比。
 */

export type DiffOp = "equal" | "delete" | "insert";

/** a → b 的差异片段：delete 只在 a 中出现，insert 只在 b 中出现；相邻同类片段已合并 */
export interface DiffPart {
  op: DiffOp;
  text: string;
}

/** 拉丁词 / 连续空白 / 单个其他字符 */
const TOKEN_RE = /[\p{L}\p{N}]+(?:['’][\p{L}]+)?|\s+|[^]/gu;
/** 中日韩及其他非拉丁文字逐字切分 */
const LATIN_RE = /^[A-Za-z0-9À-ɏ'’]+$/;

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const t = m[0];
    if (LATIN_RE.test(t) || /^\s+$/.test(t) || Array.from(t).length === 1) out.push(t);
    else out.push(...Array.from(t));
  }
  return out;
}

export function charTokens(text: string): string[] {
  return Array.from(text);
}

/** 超过该规模（中间部分 token 数乘积）时不做 LCS，整体视为替换，避免卡顿 */
const MAX_CELLS = 4_000_000;

function push(parts: DiffPart[], op: DiffOp, text: string) {
  if (!text) return;
  const last = parts[parts.length - 1];
  if (last && last.op === op) last.text += text;
  else parts.push({ op, text });
}

/** 逐 token 差异 */
export function diffTokens(a: string[], b: string[]): DiffPart[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const parts: DiffPart[] = [];
  push(parts, "equal", a.slice(0, pre).join(""));

  if (am.length && bm.length && am.length * bm.length <= MAX_CELLS) {
    const n = am.length;
    const m = bm.length;
    // dp[i][j]：am[i..] 与 bm[j..] 的 LCS 长度（一维滚动保存整表以便回溯）
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] =
          am[i] === bm[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) {
        push(parts, "equal", am[i]);
        i++;
        j++;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
        push(parts, "delete", am[i++]);
      } else {
        push(parts, "insert", bm[j++]);
      }
    }
    while (i < n) push(parts, "delete", am[i++]);
    while (j < m) push(parts, "insert", bm[j++]);
  } else {
    push(parts, "delete", am.join(""));
    push(parts, "insert", bm.join(""));
  }

  push(parts, "equal", a.slice(a.length - suf).join(""));
  return parts;
}

/** 文本差异（按词 / 逐字），a 为记忆原文，b 为当前原文 */
export function diffText(a: string, b: string): DiffPart[] {
  return diffTokens(tokenize(a ?? ""), tokenize(b ?? ""));
}

/** 只保留某一侧的片段：side="a" 时返回 equal + delete（用于在记忆原文上高亮差异） */
export function sideOf(parts: DiffPart[], side: "a" | "b"): { text: string; changed: boolean }[] {
  const drop: DiffOp = side === "a" ? "insert" : "delete";
  return parts.filter((p) => p.op !== drop).map((p) => ({ text: p.text, changed: p.op !== "equal" }));
}

/** 字符级相似度 2·LCS / (|a| + |b|)（与 difflib.SequenceMatcher.ratio 的量纲一致，用于 mock） */
export function similarity(a: string, b: string): number {
  const ca = charTokens(a ?? "");
  const cb = charTokens(b ?? "");
  if (!ca.length && !cb.length) return 1;
  const parts = diffTokens(ca, cb);
  const same = parts.filter((p) => p.op === "equal").reduce((n, p) => n + Array.from(p.text).length, 0);
  return (2 * same) / (ca.length + cb.length);
}
