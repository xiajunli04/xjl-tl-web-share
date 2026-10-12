"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowRightIcon, ExternalLinkIcon, ScanTextIcon, StarIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { DetailSkeleton } from "@/components/feedback/skeletons";
import { ErrorState } from "@/components/feedback/error-state";
import { ImageViewer, type Highlight, type ViewMode } from "@/components/image/image-viewer";
import { ResultPanel } from "@/components/image/result-panel";
import { useModelOptions } from "@/hooks/use-options";
import { IMAGE_QUERY_KEY, imageApi } from "@/lib/api/image";
import { langName } from "@/lib/languages";
import { formatTime } from "@/lib/validators";
import { cn } from "@/lib/utils";
import { ENGINE_LABEL, useRecordImage } from "./image-history";

/** 图片记录详情（侧滑）：只读查看器（译图 / 原图 / 对比）+ 逐块文本 / 术语 / 详情与步骤轨迹 */
export function ImageHistorySheet({
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
  const models = useModelOptions();
  const [mode, setMode] = useState<ViewMode>("translated");
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  const q = useQuery({
    queryKey: [...IMAGE_QUERY_KEY, "detail", id],
    queryFn: () => imageApi.get(id!),
    enabled: id !== null,
  });
  const d = q.data;
  const original = useRecordImage(id);
  const result = useRecordImage(id, "result-image", !!d?.hasResultImage);
  const select = (bid: number) => setHighlight((h) => ({ id: bid, nonce: (h?.nonce ?? 0) + 1 }));

  return (
    <Sheet
      open={id !== null}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) {
          setHighlight(null);
          setMode("translated");
        }
      }}
    >
      <SheetContent className="sm:max-w-5xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            图片翻译详情
            {d && (
              <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                {d.detectedLang ? langName(d.detectedLang) : "自动"}
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
                  <ScanTextIcon className="size-3" />
                  {ENGINE_LABEL[d.engine] ?? d.engine}
                </span>
              </span>
            ) : (
              "加载中…"
            )}
          </SheetDescription>
        </SheetHeader>
        <SheetBody className="flex min-h-0 flex-col">
          {q.isLoading ? (
            <DetailSkeleton />
          ) : q.isError ? (
            <ErrorState error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} />
          ) : d ? (
            <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="flex min-h-[26rem] flex-col">
                {original.data && (!d.hasResultImage || result.data || result.isError) ? (
                  <ImageViewer
                    compact
                    className="flex-1"
                    src={original.data}
                    width={d.width}
                    height={d.height}
                    blocks={d.blocks}
                    resultUrl={result.data ?? null}
                    mode={mode}
                    onModeChange={setMode}
                    highlight={highlight}
                    onBlockClick={select}
                  />
                ) : original.isError ? (
                  <ErrorState title="原图加载失败" error={original.error} onRetry={() => original.refetch()} />
                ) : (
                  <Skeleton className="flex-1 rounded-xl" />
                )}
              </div>
              <div className="flex min-h-80 flex-col overflow-hidden rounded-xl border bg-card shadow-card">
                <ResultPanel
                  readOnly
                  blocks={d.blocks}
                  termHits={d.termHits ?? []}
                  trace={d.trace ?? []}
                  oneShot={d.engine === "qwen-mt-image"}
                  selectedId={highlight?.id ?? null}
                  onSelect={select}
                  details={{
                    engineName: ENGINE_LABEL[d.engine] ?? d.engine,
                    modelName: d.modelConfigId ? (models.data?.find((m) => m.id === d.modelConfigId)?.name ?? `#${d.modelConfigId}`) : "默认模型",
                    detectedLang: d.detectedLang,
                    targetLang: d.targetLang,
                    latencyMs: d.latencyMs,
                    usage: d.promptTokens != null ? { promptTokens: d.promptTokens, completionTokens: d.completionTokens ?? 0 } : null,
                    width: d.width,
                    height: d.height,
                    recordId: d.id,
                  }}
                />
              </div>
            </div>
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
            <Button
              onClick={() => {
                onOpenChange(false);
                router.push(`/image?id=${d.id}`);
              }}
            >
              <ExternalLinkIcon />
              在图片翻译中打开
            </Button>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}
