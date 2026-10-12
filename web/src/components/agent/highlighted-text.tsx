"use client";

import { Fragment, useMemo } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export interface HighlightTerm {
  source: string;
  target: string;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 把文本按术语译法切分（最长优先、不区分大小写） */
export function splitByTerms(text: string, terms: HighlightTerm[]) {
  const list = terms.filter((t) => t.target.trim()).sort((a, b) => b.target.length - a.target.length);
  if (!list.length || !text) return [{ text, term: undefined as HighlightTerm | undefined }];
  const re = new RegExp(list.map((t) => escape(t.target)).join("|"), "gi");
  const out: { text: string; term?: HighlightTerm }[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ text: text.slice(last, idx) });
    const term = list.find((t) => t.target.toLowerCase() === m[0].toLowerCase());
    out.push({ text: m[0], term });
    last = idx + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** 译文中的术语高亮，悬停显示原术语 */
export function HighlightedText({ text, terms }: { text: string; terms: HighlightTerm[] }) {
  const parts = useMemo(() => splitByTerms(text, terms), [text, terms]);
  return (
    <>
      {parts.map((p, i) =>
        p.term ? (
          <Tooltip key={i}>
            <TooltipTrigger
              render={
                <mark className="rounded-sm bg-brand-soft px-0.5 text-inherit underline decoration-brand/60 decoration-2 underline-offset-4" />
              }
            >
              {p.text}
            </TooltipTrigger>
            <TooltipContent>原术语：{p.term.source}</TooltipContent>
          </Tooltip>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        ),
      )}
    </>
  );
}
