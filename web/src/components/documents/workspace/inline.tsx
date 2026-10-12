import { Fragment } from "react";
import type { DocTermVO } from "@/lib/api/documents";

/** 构造术语匹配正则（长词优先；ASCII 词加单词边界；不区分大小写） */
export function termRegex(words: string[]): RegExp | null {
  const list = [...new Set(words.map((w) => w.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!list.length) return null;
  const parts = list.map((w) => {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return /^[\w\s-]+$/.test(w) ? `\\b${esc}s?\\b` : esc;
  });
  return new RegExp(`(${parts.join("|")})`, "gi");
}

export function activeTerms(terms: DocTermVO[] | null) {
  return (terms ?? []).filter((t) => t.status !== "REJECTED");
}

function highlight(text: string, re: RegExp | null, miss: RegExp | null, keyBase: string): React.ReactNode[] {
  if (!text) return [];
  const combined = miss ?? re;
  if (!combined) return [text];
  const out: React.ReactNode[] = [];
  let last = 0;
  // 先标记未遵循（红色波浪线），再标记术语高亮
  const all: { start: number; end: number; kind: "miss" | "term" }[] = [];
  const scan = (r: RegExp | null, kind: "miss" | "term") => {
    if (!r) return;
    r.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = r.exec(text))) {
      if (!m[0]) {
        r.lastIndex++;
        continue;
      }
      const start = m.index;
      const end = start + m[0].length;
      if (!all.some((x) => start < x.end && end > x.start)) all.push({ start, end, kind });
    }
  };
  scan(miss, "miss");
  scan(re, "term");
  all.sort((a, b) => a.start - b.start);
  all.forEach((x, i) => {
    if (x.start > last) out.push(text.slice(last, x.start));
    out.push(
      <mark
        key={`${keyBase}-${i}`}
        className={
          x.kind === "miss"
            ? "rounded-sm bg-transparent text-danger underline decoration-danger decoration-wavy underline-offset-4"
            : "rounded-sm bg-brand-soft px-0.5 text-inherit ring-1 ring-brand/15"
        }
      >
        {text.slice(x.start, x.end)}
      </mark>,
    );
    last = x.end;
  });
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;

/** 轻量行内 Markdown：行内代码、加粗、链接（只显示文字），其余文本做术语高亮 */
export function renderInline(text: string, opts: { terms?: RegExp | null; miss?: RegExp | null } = {}) {
  const out: React.ReactNode[] = [];
  let last = 0;
  let i = 0;
  INLINE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE.exec(text))) {
    if (m.index > last) out.push(...highlight(text.slice(last, m.index), opts.terms ?? null, opts.miss ?? null, `t${i}`));
    const tok = m[0];
    if (m[1]) {
      out.push(
        <code key={`c${i}`} className="rounded bg-muted px-1 py-px font-mono text-[0.85em] text-foreground/90">
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (m[2]) {
      out.push(
        <strong key={`b${i}`} className="font-semibold">
          {highlight(tok.slice(2, -2), opts.terms ?? null, opts.miss ?? null, `bt${i}`)}
        </strong>,
      );
    } else {
      const label = tok.slice(1, tok.indexOf("]("));
      out.push(
        <span key={`l${i}`} className="text-brand underline decoration-brand/30 underline-offset-2">
          {highlight(label, opts.terms ?? null, opts.miss ?? null, `lt${i}`)}
        </span>,
      );
    }
    last = m.index + tok.length;
    i++;
  }
  if (last < text.length) out.push(...highlight(text.slice(last), opts.terms ?? null, opts.miss ?? null, `t${i}`));
  return <Fragment>{out}</Fragment>;
}
