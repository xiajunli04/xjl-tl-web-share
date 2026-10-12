"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  CopyIcon,
  DownloadIcon,
  ImagePlusIcon,
  Loader2Icon,
  OctagonPauseIcon,
  RotateCcwIcon,
  StarIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ErrorState } from "@/components/feedback/error-state";
import { copyText } from "@/components/feedback/copy-button";
import { DURATION, EASE_OUT, staggerDelay } from "@/components/motion";
import { LanguagePicker } from "@/components/translate/language-picker";
import { useLanguages, useModelOptions } from "@/hooks/use-options";
import { useMediaQuery } from "@/hooks/use-media-query";
import { IMAGE_QUERY_KEY, imageApi } from "@/lib/api/image";
import { saveBlob } from "@/lib/download";
import { toastError } from "@/lib/errors";
import { ApiError } from "@/lib/http";
import { computeStyles, exportPng } from "@/lib/image-render";
import { STEP_LABEL, activeStep, allTranslations, stepProgress, stepsOf } from "@/lib/image-run";
import { langName } from "@/lib/languages";
import { cn } from "@/lib/utils";
import { CameraDialog } from "./camera-dialog";
import { DropZone } from "./drop-zone";
import { useImageStore } from "./image-store";
import { ImageToolbar, useImageEngines } from "./image-toolbar";
import { ImageViewer, type Highlight, type ViewMode } from "./image-viewer";
import { ResultPanel, type SaveState } from "./result-panel";
import { StepPills } from "./step-pills";
import { useImageElement } from "./use-image-element";

const ACTIVE_TEXT: Record<string, string> = {
  ocr: "正在识别图中文字…",
  terms: "正在匹配术语…",
  translate: "正在翻译…",
  render: "正在渲染译图…",
};

function isEditableTarget(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

/** 处理中右侧面板：步骤说明 + 逐块出现的识别结果 */
function ProcessingPanel() {
  const reduce = useReducedMotion();
  const run = useImageStore((s) => s.run);
  const stop = useImageStore((s) => s.stop);
  const steps = stepsOf(run.engine);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Loader2Icon className="size-4 animate-spin text-brand" />
        <span className="text-sm font-medium">{ACTIVE_TEXT[activeStep(run) ?? ""] ?? "处理中…"}</span>
        <Button size="xs" variant="ghost" className="ml-auto text-muted-foreground" onClick={stop}>
          <OctagonPauseIcon />
          停止
        </Button>
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <ol className="space-y-2">
          {steps.map((n) => {
            const s = run.steps[n];
            return (
              <li key={n} className="flex items-start gap-2.5 text-sm">
                <span
                  className={cn(
                    "mt-1.5 size-2 shrink-0 rounded-full transition-colors duration-300",
                    s.status === "done" ? "bg-success" : s.status === "running" ? "animate-breathe bg-brand text-brand" : "bg-muted-foreground/30",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className={cn("font-medium", s.status === "pending" && "text-muted-foreground")}>{STEP_LABEL[n]}</span>
                  <AnimatePresence initial={false}>
                    {s.summary && (
                      <motion.span
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        className="block overflow-hidden text-xs text-muted-foreground"
                      >
                        {s.summary}
                      </motion.span>
                    )}
                  </AnimatePresence>
                </span>
              </li>
            );
          })}
        </ol>
        <div>
          <div className="mb-2 text-xs font-medium text-muted-foreground">识别结果</div>
          {!run.blocks.length ? (
            <div className="space-y-2" aria-busy="true">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-11 w-full rounded-lg" />
              ))}
            </div>
          ) : (
            <ul className="space-y-1.5">
              {run.blocks.map((b, i) => (
                <motion.li
                  key={b.id}
                  initial={{ opacity: 0, y: reduce ? 0 : 4 }}
                  animate={{ opacity: 1, y: 0, transition: { duration: DURATION.page, ease: EASE_OUT, delay: staggerDelay(i) } }}
                  className="rounded-lg border bg-card px-3 py-2"
                >
                  <p className="text-xs text-muted-foreground">{b.text}</p>
                  <AnimatePresence mode="wait" initial={false}>
                    {b.translation ? (
                      <motion.p
                        key="t"
                        initial={{ opacity: 0, filter: reduce ? "none" : "blur(3px)" }}
                        animate={{ opacity: 1, filter: "blur(0px)", transition: { delay: reduce ? 0 : i * 0.07 } }}
                        className="mt-0.5 text-sm font-medium"
                      >
                        {b.translation}
                      </motion.p>
                    ) : (
                      <motion.span key="s" exit={{ opacity: 0 }} className="mt-1 block">
                        <Skeleton className="h-3.5 w-2/3" />
                      </motion.span>
                    )}
                  </AnimatePresence>
                </motion.li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/** 图片翻译页：空状态 → 处理中 → 结果（主从布局） */
export function ImageWorkspace({ initialId = null }: { initialId?: number | null }) {
  const reduce = useReducedMotion();
  const router = useRouter();
  const qc = useQueryClient();
  const languages = useLanguages();
  const coarse = useMediaQuery("(pointer: coarse)");
  const s = useImageStore();
  const { engines } = useImageEngines();
  const chatModels = useModelOptions();
  const visionModels = useQuery({ queryKey: ["model-configs", "options", "vision"], queryFn: imageApi.visionModels, staleTime: 60_000, retry: false });
  const [cameraOpen, setCameraOpen] = useState(false);
  const [mode, setMode] = useState<ViewMode>("translated");
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  const [saves, setSaves] = useState<Record<number, SaveState>>({});
  const [exporting, setExporting] = useState(false);
  const [favPending, setFavPending] = useState(false);
  const [opened, setOpened] = useState<{ id: number; error?: unknown } | null>(null);
  const [openAttempt, setOpenAttempt] = useState(0);
  const uploadRef = useRef<HTMLInputElement>(null);
  const img = useImageElement(s.source?.url);

  const run = s.run;
  const running = run.status === "running";
  const hasWork = !!s.source;
  const oneShot = run.engine === "qwen-mt-image";

  /* ---------- 打开历史记录（?id=） ---------- */
  const opening = initialId != null && opened?.id !== initialId;
  useEffect(() => {
    if (initialId == null) return;
    let alive = true;
    (async () => {
      try {
        const d = await imageApi.get(initialId);
        const [original, result] = await Promise.all([
          imageApi.image(initialId),
          d.hasResultImage ? imageApi.resultImage(initialId).catch(() => null) : Promise.resolve(null),
        ]);
        if (!alive) return;
        await useImageStore.getState().loadRecord(d, original, result);
        setOpened({ id: initialId });
        router.replace("/image");
      } catch (e) {
        if (alive) setOpened({ id: initialId, error: e });
      }
    })();
    return () => {
      alive = false;
    };
  }, [initialId, router, openAttempt]);

  // 已有图片时的输入错误（格式 / 尺寸）以 toast 提示
  const hasWorkNow = !!s.source;
  useEffect(() => {
    if (!s.inputError || !hasWorkNow) return;
    toast.error(s.inputError);
    useImageStore.getState().clearInputError();
  }, [s.inputError, hasWorkNow]);

  /* ---------- Ctrl+V 粘贴 ---------- */
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isEditableTarget(e.target) || useImageStore.getState().run.status === "running") return;
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.kind === "file" && i.type.startsWith("image/"));
      const file = item?.getAsFile();
      if (!file) return;
      e.preventDefault();
      void useImageStore.getState().submit(file, file.name && file.name !== "image.png" ? file.name : `clipboard-${Date.now()}.png`);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  const submit = (file: File) => {
    setHighlight(null);
    setSaves({});
    setMode("translated");
    void s.submit(file, file.name);
  };

  /* ---------- 编辑与保存 ---------- */
  const commit = async (id: number, text: string, previous: string) => {
    const recordId = run.recordId;
    if (recordId == null) return;
    setSaves((m) => ({ ...m, [id]: "saving" }));
    try {
      await imageApi.patchBlocks(recordId, [{ id, translation: text }]);
      setSaves((m) => ({ ...m, [id]: "saved" }));
      void qc.invalidateQueries({ queryKey: IMAGE_QUERY_KEY });
      setTimeout(
        () =>
          setSaves((m) => {
            if (m[id] !== "saved") return m;
            const next = { ...m };
            delete next[id];
            return next;
          }),
        1800,
      );
    } catch (e) {
      s.editBlock(id, previous);
      setSaves((m) => ({ ...m, [id]: "error" }));
      toastError(e);
    }
  };

  const download = async () => {
    if (!s.source) return;
    setExporting(true);
    try {
      let blob: Blob;
      if (s.resultUrl) {
        const res = await fetch(s.resultUrl);
        const raw = await res.blob();
        const el = await new Promise<HTMLImageElement>((resolve, reject) => {
          const i = new Image();
          i.onload = () => resolve(i);
          i.onerror = reject;
          i.src = URL.createObjectURL(raw);
        });
        blob = await exportPng(el, [], new Map());
        URL.revokeObjectURL(el.src);
      } else {
        if (!img) return;
        blob = await exportPng(img, run.blocks, computeStyles(img, run.blocks));
      }
      saveBlob(blob, `translated-${run.recordId ?? Date.now()}-${s.targetLang}.png`);
      toast.success("译图已下载", { description: `原图分辨率 ${s.source.width} × ${s.source.height}` });
    } catch (e) {
      toastError(e);
    } finally {
      setExporting(false);
    }
  };

  const toggleFavorite = async () => {
    if (run.recordId == null) return;
    setFavPending(true);
    try {
      await imageApi.favorite(run.recordId, !s.favorite);
      s.setFavorite(!s.favorite);
      toast.success(s.favorite ? "已取消收藏" : "已收藏");
      void qc.invalidateQueries({ queryKey: IMAGE_QUERY_KEY });
    } catch (e) {
      toastError(e);
    } finally {
      setFavPending(false);
    }
  };

  const engineInfo = engines.find((e) => e.id === run.engine);
  const modelName =
    run.engine === "qwen-mt-image"
      ? (engineInfo?.name ?? "千问图片翻译")
      : run.modelConfigId != null
        ? (visionModels.data?.find((m) => m.id === run.modelConfigId)?.name ??
          chatModels.data?.find((m) => m.id === run.modelConfigId)?.name ??
          `#${run.modelConfigId}`)
        : "默认视觉模型";
  const progress = stepProgress(run);
  const translatedCount = run.blocks.filter((b) => b.translation).length;
  const statusText = ACTIVE_TEXT[activeStep(run) ?? ""] ?? "识别中";

  const error = run.status === "error" ? run.error : undefined;
  const fade = { duration: reduce ? DURATION.fast : DURATION.page, ease: EASE_OUT };

  const resultActions = run.status === "done" && (
    <div className="flex flex-wrap items-center gap-1">
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="sm" disabled={exporting} onClick={download} />}>
          {exporting ? <Loader2Icon className="animate-spin" /> : <DownloadIcon />}
          下载 PNG
        </TooltipTrigger>
        <TooltipContent>以原图分辨率导出译图</TooltipContent>
      </Tooltip>
      {!oneShot && (
        <Button
          variant="ghost"
          size="sm"
          disabled={!translatedCount}
          onClick={async () => {
            if (await copyText(allTranslations(run.blocks))) toast.success(`已复制 ${translatedCount} 段译文`);
          }}
        >
          <CopyIcon />
          复制全部译文
        </Button>
      )}
      <span className="inline-flex items-center rounded-lg pl-2 text-xs text-muted-foreground">
        <RotateCcwIcon className="mr-0.5 size-3.5" />
        重译为
        <LanguagePicker label="换目标语言重译" value={s.targetLang} onChange={(v) => void s.retranslate(v)} languages={languages} />
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={s.favorite ? "取消收藏" : "收藏"}
        aria-pressed={s.favorite}
        disabled={favPending || run.recordId == null}
        onClick={toggleFavorite}
      >
        <motion.span
          key={String(s.favorite)}
          initial={{ scale: reduce ? 1 : 0.5 }}
          animate={{ scale: 1 }}
          transition={{ type: "spring", stiffness: 500, damping: 15 }}
          className="inline-flex"
        >
          <StarIcon className={cn(s.favorite && "fill-warning text-warning")} />
        </motion.span>
      </Button>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 md:p-5">
      <ImageToolbar
        disabled={running}
        actions={
          hasWork && !running ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                s.reset();
                setHighlight(null);
                setSaves({});
              }}
            >
              <ImagePlusIcon />
              新图片
            </Button>
          ) : null
        }
      />

      <AnimatePresence mode="wait" initial={false}>
        {opening ? (
          <motion.div key="opening" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade} className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_380px]">
            <Skeleton className="min-h-80 rounded-xl" />
            <Skeleton className="min-h-80 rounded-xl" />
          </motion.div>
        ) : opened?.error && !hasWork ? (
          <motion.div key="open-error" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="rounded-xl border bg-card shadow-card">
            <ErrorState
              title={opened.error instanceof ApiError && opened.error.code === "A0404" ? "记录不存在或已被删除" : "记录加载失败"}
              error={opened.error}
              onRetry={() => {
                setOpened(null);
                setOpenAttempt((n) => n + 1);
              }}
            />
          </motion.div>
        ) : !hasWork ? (
          <motion.div
            key="empty"
            initial={{ opacity: 0, y: reduce ? 0 : 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduce ? 0 : -8 }}
            transition={fade}
            className="flex flex-1 items-start justify-center py-2 md:py-6"
          >
            <DropZone
              onFile={submit}
              onCamera={() => setCameraOpen(true)}
              onSample={(sample, file) => {
                if (sample.targetLang !== s.targetLang) s.patch({ targetLang: sample.targetLang });
                submit(file);
              }}
              error={s.inputError}
              onDismissError={s.clearInputError}
              coarsePointer={coarse}
            />
          </motion.div>
        ) : (
          <motion.div
            key="work"
            initial={{ opacity: 0, scale: reduce ? 1 : 0.985 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={fade}
            className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_380px]"
          >
            {/* 左：画布查看器 */}
            <section className="flex min-h-112 flex-col rounded-xl border bg-card p-3 shadow-card lg:min-h-0">
              <div className="mb-2.5 flex flex-wrap items-center gap-2">
                <StepPills run={run} />
                <span className="ml-auto text-xs text-muted-foreground">
                  {s.source!.width} × {s.source!.height}
                  {run.detectedLang && ` · ${langName(run.detectedLang)} → ${langName(s.targetLang)}`}
                </span>
              </div>
              <AnimatePresence initial={false}>
                {resultActions && (
                  <motion.div
                    key="actions"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={fade}
                    className="overflow-hidden"
                  >
                    <div className="mb-2 border-b pb-2">{resultActions}</div>
                  </motion.div>
                )}
              </AnimatePresence>
              <ImageViewer
                key={s.runId}
                className="flex-1"
                src={s.source!.url}
                width={s.source!.width}
                height={s.source!.height}
                blocks={run.blocks}
                resultUrl={s.resultUrl}
                phase={run.phase}
                processing={running}
                progress={progress}
                statusText={statusText}
                highlight={highlight}
                mode={mode}
                onModeChange={setMode}
                onBlockClick={(id) => setHighlight((h) => ({ id, nonce: (h?.nonce ?? 0) + 1 }))}
              />
            </section>

            {/* 右：处理中步骤 / 结果标签页 / 错误 */}
            <aside className="flex min-h-80 flex-col overflow-hidden rounded-xl border bg-card shadow-card lg:min-h-0">
              <AnimatePresence mode="wait" initial={false}>
                {running ? (
                  <motion.div key="processing" className="flex min-h-0 flex-1 flex-col" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}>
                    <ProcessingPanel />
                  </motion.div>
                ) : run.status === "done" ? (
                  <motion.div key="result" className="flex min-h-0 flex-1 flex-col" initial={{ opacity: 0, x: reduce ? 0 : 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={fade}>
                    <ResultPanel
                      blocks={run.blocks}
                      termHits={run.termHits}
                      trace={run.trace}
                      oneShot={oneShot}
                      selectedId={highlight?.id ?? null}
                      saves={saves}
                      details={{
                        engineName: engineInfo?.name ?? (oneShot ? "千问图片翻译" : "视觉识别 + 平台翻译"),
                        modelName,
                        detectedLang: run.detectedLang,
                        targetLang: s.targetLang,
                        latencyMs: run.latencyMs,
                        usage: run.usage,
                        width: s.source!.width,
                        height: s.source!.height,
                        recordId: run.recordId,
                      }}
                      onSelect={(id) => setHighlight((h) => ({ id, nonce: (h?.nonce ?? 0) + 1 }))}
                      onEdit={(id, text) => s.editBlock(id, text)}
                      onCommit={(id, text, prev) => void commit(id, text, prev)}
                    />
                  </motion.div>
                ) : (
                  <motion.div key="error" className="flex flex-1 flex-col items-center justify-center p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}>
                    {run.status === "stopped" ? (
                      <div className="text-center">
                        <OctagonPauseIcon className="mx-auto mb-3 size-8 text-warning" />
                        <p className="text-sm font-medium">已停止，本次结果不会保存</p>
                        <Button className="mt-4" onClick={() => void s.retranslate()}>
                          <RotateCcwIcon />
                          重新翻译
                        </Button>
                      </div>
                    ) : (
                      <ErrorState
                        title="图片翻译失败"
                        error={error ? new ApiError(error.code, error.message, error.traceId) : new Error("未知错误")}
                        onRetry={() => void s.retranslate()}
                      />
                    )}
                    <Button variant="ghost" size="sm" className="mt-2" onClick={() => uploadRef.current?.click()}>
                      <ImagePlusIcon />
                      换一张图片
                    </Button>
                  </motion.div>
                )}
              </AnimatePresence>
            </aside>
          </motion.div>
        )}
      </AnimatePresence>

      <input
        ref={uploadRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/bmp"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) submit(f);
          e.target.value = "";
        }}
      />
      <CameraDialog open={cameraOpen} onOpenChange={setCameraOpen} onCapture={submit} onUpload={() => uploadRef.current?.click()} />
    </div>
  );
}
