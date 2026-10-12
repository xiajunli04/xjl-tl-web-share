"use client";

import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRightIcon,
  CoinsIcon,
  ExternalLinkIcon,
  MessageCircleQuestionIcon,
  MessagesSquareIcon,
  RouteIcon,
  StarIcon,
  TimerIcon,
  Trash2Icon,
  WandSparklesIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CopyButton } from "@/components/feedback/copy-button";
import { DetailSkeleton } from "@/components/feedback/skeletons";
import { ErrorState } from "@/components/feedback/error-state";
import { HighlightedText } from "@/components/agent/highlighted-text";
import { ScoreRing } from "@/components/agent/score-ring";
import { TermsPanel } from "@/components/agent/terms-panel";
import { formatMs, formatTokens } from "@/components/agent/node-meta";
import { translationRunStore } from "@/hooks/use-translation-run";
import { useGlossaryOptions, useModelOptions } from "@/hooks/use-options";
import { historyApi, type TranslationDetailVO } from "@/lib/api/history";
import { langName, modeLabel, pathLabel, styleLabel } from "@/lib/languages";
import { formatTime } from "@/lib/validators";
import { cn } from "@/lib/utils";
import { useWorkbenchStore } from "@/stores/workbench";
import { TraceReplay } from "./trace-replay";

/** 原始源语言为 auto 时展示识别结果 */
function srcLabel(d: TranslationDetailVO) {
  if (d.sourceLang === "auto") return `自动识别 · ${d.detectedLang ? langName(d.detectedLang) : "未知"}`;
  return langName(d.sourceLang);
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-sm font-medium">{children}</div>
    </div>
  );
}

/** 会话内记录：所属会话、修订要求、追问问答、是否为采用版本 */
function SessionInfo({ d, onOpen }: { d: TranslationDetailVO; onOpen: () => void }) {
  if (d.sessionId == null) return null;
  return (
    <div className="rounded-xl border border-brand/20 bg-brand-soft/40 p-3.5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <MessagesSquareIcon className="size-4 text-brand" />
        <span className="font-medium">会话 #{d.sessionId}</span>
        {d.revisionOf != null && (
          <span className="rounded-md bg-background/70 px-1.5 py-0.5 text-[11px] text-muted-foreground">修订自记录 #{d.revisionOf}</span>
        )}
        {d.adopted != null && (
          <span
            className={cn(
              "rounded-md px-1.5 py-0.5 text-[11px]",
              d.adopted ? "bg-success-soft text-success" : "bg-muted text-muted-foreground",
            )}
          >
            {d.adopted ? "采用版本" : "未采用"}
          </span>
        )}
        <Button size="xs" variant="outline" className="ml-auto" onClick={onOpen}>
          <ExternalLinkIcon />
          打开会话
        </Button>
      </div>
      {(d.reviseInstruction || d.clarification) && (
        <div className="mt-2.5 space-y-1.5 text-xs">
          {d.reviseInstruction && (
            <div className="flex gap-1.5">
              <WandSparklesIcon className="mt-0.5 size-3.5 shrink-0 text-brand" />
              <span>
                <span className="text-muted-foreground">修订要求：</span>
                {d.reviseInstruction}
              </span>
            </div>
          )}
          {d.clarification && (
            <div className="flex gap-1.5">
              <MessageCircleQuestionIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
              <span>
                <span className="text-muted-foreground">追问：{d.clarification.question}</span>
                <span className="ml-1 font-medium">→ {d.clarification.answer}</span>
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Compare({ d, onOpenSession }: { d: TranslationDetailVO; onOpenSession: () => void }) {
  const models = useModelOptions();
  const terms = (d.termHits ?? []).filter((h) => d.compliance?.find((c) => c.source === h.source)?.compliant !== false);
  return (
    <div className="space-y-5">
      <SessionInfo d={d} onOpen={onOpenSession} />
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-xl border bg-card shadow-card">
          <div className="flex items-center justify-between border-b px-4 py-2 text-xs text-muted-foreground">
            原文 · {srcLabel(d)}
            <CopyButton text={d.sourceText} size="icon-xs" label="复制原文" />
          </div>
          <p className="px-4 py-3 text-sm leading-7 whitespace-pre-wrap">{d.sourceText}</p>
        </div>
        <div className="rounded-xl border bg-card shadow-card">
          <div className="flex items-center justify-between border-b px-4 py-2 text-xs text-muted-foreground">
            译文 · {langName(d.targetLang)}
            <CopyButton text={d.targetText} size="icon-xs" label="复制译文" />
          </div>
          <p className="px-4 py-3 text-sm leading-7 whitespace-pre-wrap">
            <HighlightedText text={d.targetText} terms={terms} />
          </p>
        </div>
      </div>
      <div className="flex items-center gap-4 rounded-xl border bg-card p-4 shadow-card">
        {d.reviewScore !== null ? (
          <ScoreRing score={d.reviewScore} passed={d.reviewScore >= 85} />
        ) : (
          <span className="flex size-14 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground">
            未评审
          </span>
        )}
        <div className="grid flex-1 grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
          <span className="text-muted-foreground">
            修正轮次 <b className="font-medium text-foreground">{d.reviewRounds}</b>
          </span>
          <span className="text-muted-foreground">
            <TimerIcon className="mr-1 inline size-3.5" />
            {formatMs(d.latencyMs)}
          </span>
          <span className="text-muted-foreground">
            <CoinsIcon className="mr-1 inline size-3.5" />
            {formatTokens(d.promptTokens + d.completionTokens)} tokens
          </span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Meta label="路径">{pathLabel(d.path)}</Meta>
        <Meta label="模式">{modeLabel(d.mode)}</Meta>
        <Meta label="风格">{styleLabel(d.style)}</Meta>
        <Meta label="领域">{d.domain || "自动"}</Meta>
        <Meta label="识别语种">{d.detectedLang ? langName(d.detectedLang) : "—"}</Meta>
        <Meta label="模型">
          {d.modelConfigId ? (models.data?.find((m) => m.id === d.modelConfigId)?.name ?? `#${d.modelConfigId}`) : "默认模型"}
        </Meta>
      </div>
    </div>
  );
}

/** 历史详情（侧滑）：对照 / Agent 轨迹回放 / 术语 */
export function HistoryDetailSheet({
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
  const router = useRouter();
  const load = useWorkbenchStore((s) => s.load);
  const openSessionInStore = useWorkbenchStore((s) => s.openSession);
  const glossaries = useGlossaryOptions();
  const q = useQuery({
    queryKey: ["translations", "detail", id],
    queryFn: () => historyApi.get(id!),
    enabled: id !== null,
  });
  const d = q.data;

  const openInWorkbench = (d: TranslationDetailVO) => {
    load({
      text: d.sourceText,
      sourceLang: d.sourceLang,
      targetLang: d.targetLang,
      // 修订记录的 mode 为 revise，工作台没有该模式
      mode: (["auto", "fast", "standard"] as string[]).includes(d.mode) ? d.mode : "auto",
      style: d.style,
      domain: d.domain ?? "",
      glossaryIds: d.glossaryIds ?? [],
      modelConfigId: d.modelConfigId,
    });
    translationRunStore.getState().reset();
    onOpenChange(false);
    router.push("/translate");
  };

  /** 「打开会话」：工作台切到会话模式并打开该会话，选中这条记录所在的轮次 */
  const openSession = (d: TranslationDetailVO) => {
    if (d.sessionId == null) return;
    openSessionInStore(d.sessionId, d.id);
    if (translationRunStore.getState().status !== "running") translationRunStore.getState().reset();
    onOpenChange(false);
    router.push("/translate");
  };

  return (
    <Sheet open={id !== null} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            翻译详情
            {d && (
              <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                {srcLabel(d)}
                <ArrowRightIcon className="size-3" />
                {langName(d.targetLang)}
              </span>
            )}
          </SheetTitle>
          <SheetDescription>
            {d ? (
              <span className="inline-flex items-center gap-2">
                {formatTime(d.createdAt)}
                <span className="inline-flex items-center gap-1">
                  <RouteIcon className="size-3" />
                  {pathLabel(d.path)}
                </span>
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
            <Tabs defaultValue="compare" className="gap-4">
              <TabsList>
                <TabsTrigger value="compare">对照</TabsTrigger>
                <TabsTrigger value="trace">Agent 轨迹</TabsTrigger>
                <TabsTrigger value="terms">
                  术语
                  {(d.termHits?.length ?? 0) > 0 && (
                    <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums">{d.termHits?.length}</span>
                  )}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="compare">
                <Compare d={d} onOpenSession={() => openSession(d)} />
              </TabsContent>
              <TabsContent value="trace">
                <TraceReplay key={d.id} traces={d.traces} />
              </TabsContent>
              <TabsContent value="terms">
                <TermsPanel
                  hits={d.termHits ?? []}
                  compliance={d.compliance}
                  glossaryName={(gid) => glossaries.data?.find((g) => g.id === gid)?.name}
                  emptyDescription="这次翻译没有命中术语。"
                />
              </TabsContent>
            </Tabs>
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
            <div className="flex gap-2">
              {d.sessionId != null && (
                <Button variant="outline" onClick={() => openSession(d)}>
                  <MessagesSquareIcon />
                  打开会话
                </Button>
              )}
              <Button onClick={() => openInWorkbench(d)}>
                <ExternalLinkIcon />
                在工作台中打开
              </Button>
            </div>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}
