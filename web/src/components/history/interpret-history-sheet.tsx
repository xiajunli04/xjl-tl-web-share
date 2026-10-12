"use client";

import { useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  AudioLinesIcon,
  BotIcon,
  ClockIcon,
  GaugeIcon,
  Loader2Icon,
  SearchIcon,
  StarIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Segmented } from "@/components/ui/segmented";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { DetailSkeleton } from "@/components/feedback/skeletons";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorState } from "@/components/feedback/error-state";
import { NumberTicker } from "@/components/motion/number-ticker";
import { DURATION, EASE_OUT, staggerDelay } from "@/components/motion";
import {
  INTERPRET_HISTORY_QUERY_KEY,
  INTERPRET_MODE_LABEL,
  SEGMENT_PAGE_SIZE,
  averageE2e,
  formatDuration,
  formatOffset,
  interpretHistoryApi,
  segmentMatches,
  segmentText,
  sessionLanguages,
  type InterpretSegmentVO,
  type InterpretSessionVO,
} from "@/lib/api/interpret-history";
import { AI_PARTICIPANT } from "@/lib/interpret/resume";
import { langName } from "@/lib/languages";
import { formatTime } from "@/lib/validators";
import { cn } from "@/lib/utils";
import { MODE_STYLE, engineName } from "./interpret-history";

const SPEAKER_COLORS = [
  "bg-brand-soft text-brand",
  "bg-info-soft text-info",
  "bg-success-soft text-success",
  "bg-warning-soft text-warning",
  "bg-danger-soft text-danger",
];

/** 关键词高亮 */
function Highlight({ text, keyword }: { text: string; keyword: string }) {
  const k = keyword.trim();
  if (!k) return <>{text}</>;
  const parts = text.split(new RegExp(`(${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"));
  return (
    <>
      {parts.map((p, i) =>
        p.toLowerCase() === k.toLowerCase() ? (
          <mark key={i} className="rounded-sm bg-warning/30 px-0.5 text-foreground">
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

function Stat({ icon: Icon, label, children }: { icon: React.ComponentType<{ className?: string }>; label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border bg-card px-3 py-2.5 shadow-card">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{children}</div>
    </div>
  );
}

function SegmentRow({
  seg,
  index,
  lang,
  bilingual,
  keyword,
  color,
  side,
  chat,
}: {
  seg: InterpretSegmentVO;
  index: number;
  lang: string;
  bilingual: boolean;
  keyword: string;
  color: string;
  /** 双向对话：B 侧靠右 */
  side?: "left" | "right";
  /** AI 对话：每句以原文为主，AI 句附母语字幕 */
  chat?: boolean;
}) {
  const reduce = useReducedMotion();
  const ai = chat && seg.speakerParticipant === AI_PARTICIPANT;
  const subtitle = chat ? Object.values(seg.translations ?? {}).find(Boolean) : undefined;
  const main = chat ? seg.sourceText : segmentText(seg, lang);
  const isSource = chat || seg.sourceLang === lang || (seg.sourceLang === "yue" && lang === "zh");
  return (
    <motion.li
      layout={!reduce}
      initial={{ opacity: 0, y: reduce ? 0 : 6 }}
      animate={{ opacity: 1, y: 0, transition: { duration: DURATION.page, ease: EASE_OUT, delay: staggerDelay(index) } }}
      exit={{ opacity: 0 }}
      className={cn("flex gap-3", side === "right" && "flex-row-reverse")}
    >
      <div className={cn("flex w-14 shrink-0 flex-col gap-1 pt-0.5", side === "right" ? "items-end" : "items-start")}>
        <span className="font-mono text-[11px] text-muted-foreground">{formatOffset(seg.startedMs)}</span>
      </div>
      <div className={cn("min-w-0 max-w-[85%] flex-1", side === "right" && "flex flex-col items-end")}>
        <div className={cn("mb-1 flex items-center gap-1.5 text-xs", side === "right" && "flex-row-reverse")}>
          <span className={cn("rounded-md px-1.5 py-0.5 font-medium", ai ? "bg-brand-gradient text-brand-foreground" : color)}>
            {ai && <BotIcon className="mr-1 inline size-3 -translate-y-px" />}
            {seg.speakerName}
          </span>
          <span className="text-muted-foreground">{langName(seg.sourceLang)}</span>
          {seg.metrics?.e2eMs != null && <span className="text-muted-foreground tabular-nums">· {(seg.metrics.e2eMs / 1000).toFixed(1)} s</span>}
        </div>
        <div className={cn("rounded-2xl border bg-card px-3.5 py-2.5 shadow-card", side === "right" ? "rounded-tr-md" : "rounded-tl-md")}>
          <p className="text-sm leading-relaxed">
            {main ? <Highlight text={main} keyword={keyword} /> : <span className="text-muted-foreground italic">（无{langName(lang)}译文）</span>}
          </p>
          {bilingual && ai && subtitle && (
            <p className="mt-1.5 border-t pt-1.5 text-xs leading-relaxed text-muted-foreground">
              <Highlight text={subtitle} keyword={keyword} />
            </p>
          )}
          {bilingual && !isSource && (
            <p className="mt-1.5 border-t pt-1.5 text-xs leading-relaxed text-muted-foreground">
              <Highlight text={seg.sourceText} keyword={keyword} />
            </p>
          )}
        </div>
      </div>
    </motion.li>
  );
}

function Transcript({ session }: { session: InterpretSessionVO }) {
  const seg = useInfiniteQuery({
    queryKey: [...INTERPRET_HISTORY_QUERY_KEY, "segments", session.id],
    queryFn: ({ pageParam }) => interpretHistoryApi.segments(session.id, pageParam),
    initialPageParam: 1,
    getNextPageParam: (last, all) => (all.reduce((n, p) => n + p.records.length, 0) < last.total ? last.pageNum + 1 : undefined),
  });
  const segments = useMemo(() => seg.data?.pages.flatMap((p) => p.records) ?? [], [seg.data]);
  const langs = sessionLanguages(session, segments);
  const [langPick, setLangPick] = useState<string | null>(null);
  const lang = langPick && langs.includes(langPick) ? langPick : (langs[0] ?? "zh");
  const [bilingual, setBilingual] = useState(true);
  const [keyword, setKeyword] = useState("");
  const shown = segments.filter((s) => segmentMatches(s, keyword));
  const speakers = Array.from(new Set(segments.map((s) => s.speakerParticipant)));
  const avg = session.stats?.avgE2eMs ?? averageE2e(segments);
  const total = seg.data?.pages[0]?.total ?? session.stats?.utterances ?? 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat icon={ClockIcon} label="时长">{formatDuration(session.durationMs)}</Stat>
        <Stat icon={AudioLinesIcon} label="句数">
          <NumberTicker value={total} />
        </Stat>
        <Stat icon={GaugeIcon} label="平均延迟">
          {avg != null ? (
            <>
              <NumberTicker value={Math.round(avg / 100) / 10} decimals={1} />
              <span className="ml-0.5 text-xs font-normal text-muted-foreground">s</span>
            </>
          ) : (
            "—"
          )}
        </Stat>
        <Stat icon={UsersIcon} label={session.mode === "ROOM" ? "参与人数" : "发言方"}>
          <NumberTicker value={session.stats?.participants ?? speakers.length} />
        </Stat>
      </div>

      <div className="sticky top-0 z-10 -mx-1 flex flex-wrap items-center gap-2 bg-popover/95 px-1 py-2 backdrop-blur-sm">
        {langs.length > 1 && (
          <Segmented<string>
            ariaLabel="显示语言"
            size="sm"
            value={lang}
            onChange={setLangPick}
            options={langs.map((l) => ({ value: l, label: langName(l) }))}
          />
        )}
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={bilingual} onCheckedChange={setBilingual} aria-label="同时显示原文" />
          显示原文
        </label>
        <div className="relative ml-auto w-full sm:w-56">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="搜索转写" className="h-8 pl-8 text-sm" />
        </div>
      </div>

      {seg.isLoading ? (
        <DetailSkeleton lines={5} />
      ) : seg.isError ? (
        <ErrorState error={seg.error} onRetry={() => seg.refetch()} retrying={seg.isFetching} />
      ) : !segments.length ? (
        <EmptyState compact icon={AudioLinesIcon} title="这次会话没有转写" description="会话中没有识别到有效语音。" />
      ) : !shown.length ? (
        <EmptyState compact icon={SearchIcon} title="没有匹配的转写" description="换个关键词再试。" />
      ) : (
        <ul className="space-y-4">
          <AnimatePresence initial={false}>
            {shown.map((s, i) => (
              <SegmentRow
                key={s.seq}
                seg={s}
                index={i}
                lang={lang}
                bilingual={bilingual}
                keyword={keyword}
                color={SPEAKER_COLORS[Math.max(0, speakers.indexOf(s.speakerParticipant)) % SPEAKER_COLORS.length]}
                side={
                  session.mode === "CHAT"
                    ? s.speakerParticipant === AI_PARTICIPANT
                      ? "left"
                      : "right"
                    : session.mode === "CONVERSE" && speakers.indexOf(s.speakerParticipant) === 1
                      ? "right"
                      : "left"
                }
                chat={session.mode === "CHAT"}
              />
            ))}
          </AnimatePresence>
        </ul>
      )}
      {seg.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" disabled={seg.isFetchingNextPage} onClick={() => seg.fetchNextPage()}>
            {seg.isFetchingNextPage && <Loader2Icon className="animate-spin" />}
            加载更多（每次 {SEGMENT_PAGE_SIZE} 句）
          </Button>
        </div>
      )}
    </div>
  );
}

/** 同传记录详情（侧滑）：统计 + 按时间的双语转写（切换显示语言、搜索） */
export function InterpretHistorySheet({
  id,
  onOpenChange,
  onToggleFavorite,
  onDelete,
}: {
  id: number | null;
  onOpenChange: (o: boolean) => void;
  onToggleFavorite: (id: number, favorite: boolean) => void;
  onDelete: (id: number) => void;
}) {
  const q = useQuery({
    queryKey: [...INTERPRET_HISTORY_QUERY_KEY, "detail", id],
    queryFn: () => interpretHistoryApi.get(id!),
    enabled: id !== null,
  });
  const d = q.data;
  const style = d ? MODE_STYLE[d.mode] : null;

  return (
    <Sheet open={id !== null} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {style && d && (
              <span className={cn("flex size-7 items-center justify-center rounded-lg ring-1", style.cls)}>
                <style.icon className="size-4" />
              </span>
            )}
            <span className="truncate">{d ? (d.title ?? INTERPRET_MODE_LABEL[d.mode]) : "同传详情"}</span>
          </SheetTitle>
          <SheetDescription>
            {d ? (
              <span className="inline-flex flex-wrap items-center gap-2">
                {formatTime(d.startedAt)}
                <span>{INTERPRET_MODE_LABEL[d.mode]}</span>
                <span>{engineName(d.engine)}</span>
                {d.roomCode && <span className="font-mono">房间 {d.roomCode}</span>}
              </span>
            ) : (
              "加载中…"
            )}
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          {q.isLoading ? (
            <DetailSkeleton />
          ) : q.isError ? (
            <ErrorState error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} />
          ) : d ? (
            <Transcript key={d.id} session={d} />
          ) : null}
        </SheetBody>
        {d && (
          <SheetFooter className="justify-between">
            <div className="flex gap-1">
              <Button variant="ghost" size="sm" onClick={() => onToggleFavorite(d.id, !d.favorite)}>
                <StarIcon className={cn(d.favorite && "fill-warning text-warning")} />
                {d.favorite ? "已收藏" : "收藏"}
              </Button>
              <Button variant="ghost" size="sm" className="text-destructive" onClick={() => onDelete(d.id)}>
                <Trash2Icon />
                删除
              </Button>
            </div>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}
