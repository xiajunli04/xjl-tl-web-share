"use client";

import Link from "next/link";
import { FileTextIcon, LanguagesIcon, SparklesIcon } from "lucide-react";
import { NumberTicker } from "@/components/motion/number-ticker";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { TmHit } from "@/lib/api/translate";
import { diffText, sideOf } from "@/lib/text-diff";
import { matchInfo, originInfo, type MatchKind } from "@/lib/tm-match";
import { cn } from "@/lib/utils";

const KIND_CLS: Record<MatchKind, string> = {
  exact: "bg-success-soft text-success ring-success/25",
  fuzzy: "bg-brand-soft text-brand ring-brand/25",
  semantic: "bg-info-soft text-info ring-info/25",
};

/** 匹配度徽章：数字 400ms 从 0 计数到目标值（减少动效时直接显示） */
export function MatchBadge({ hit, className }: { hit: Pick<TmHit, "fuzzy" | "semantic">; className?: string }) {
  const info = matchInfo(hit);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-semibold ring-1",
              KIND_CLS[info.kind],
              className,
            )}
            aria-label={`匹配度 ${info.label}`}
          />
        }
      >
        {info.kind === "semantic" ? (
          <>
            <SparklesIcon className="size-3" />
            语义
            <NumberTicker value={info.percent} suffix="%" className="font-normal opacity-80" />
          </>
        ) : (
          <NumberTicker value={info.percent} suffix="%" />
        )}
      </TooltipTrigger>
      <TooltipContent>{info.title}</TooltipContent>
    </Tooltip>
  );
}

/** 来源（可跳转到历史记录或文档段落） */
export function OriginLink({ origin, originRef, className }: { origin: string; originRef: string | null; className?: string }) {
  const o = originInfo(origin, originRef);
  const Icon = o.kind === "document" ? FileTextIcon : LanguagesIcon;
  const body = (
    <>
      <Icon className="size-3 shrink-0" />
      <span className="truncate">{o.label}</span>
    </>
  );
  const cls = cn("inline-flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground", className);
  return o.href ? (
    <Link href={o.href} className={cn(cls, "underline-offset-2 hover:text-foreground hover:underline")}>
      {body}
    </Link>
  ) : (
    <span className={cls}>{body}</span>
  );
}

/** 记忆原文：与当前原文不同的部分高亮（按词 / 逐字） */
export function DiffSource({ memory, current }: { memory: string; current?: string | null }) {
  if (!current) return <>{memory}</>;
  const parts = sideOf(diffText(memory, current), "a");
  return (
    <>
      {parts.map((p, i) =>
        p.changed ? (
          <mark
            key={i}
            className="rounded-[3px] bg-warning-soft px-px text-warning underline decoration-warning/50 decoration-dotted underline-offset-2"
          >
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

/** 一条记忆命中：徽章 + 来源 + 原文差异高亮 + 记忆译文 */
export function TmHitCard({ hit, current, compact }: { hit: TmHit; current?: string | null; compact?: boolean }) {
  const exact = matchInfo(hit).kind === "exact";
  return (
    <div className={cn("rounded-xl border bg-card shadow-card", compact ? "p-2.5" : "p-3")}>
      <div className="flex items-center gap-2">
        <MatchBadge hit={hit} />
        <OriginLink origin={hit.origin} originRef={hit.originRef} className="ml-auto" />
      </div>
      <p className="mt-2 text-xs leading-relaxed break-words text-foreground/80">
        <DiffSource memory={hit.source} current={exact ? null : current} />
      </p>
      <p className="mt-1.5 border-t pt-1.5 text-sm leading-relaxed break-words">{hit.target}</p>
    </div>
  );
}
