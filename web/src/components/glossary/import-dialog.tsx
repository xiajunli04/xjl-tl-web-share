"use client";

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  CheckIcon,
  FileSpreadsheetIcon,
  Loader2Icon,
  RefreshCwIcon,
  SkipForwardIcon,
  UploadCloudIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ErrorState } from "@/components/feedback/error-state";
import { NumberTicker } from "@/components/motion/number-ticker";
import { DURATION, EASE_OUT } from "@/components/motion/tokens";
import {
  glossaryApi,
  type GlossaryVO,
  type ImportPreview,
  type ImportResult,
  type ImportStrategy,
} from "@/lib/api/glossaries";
import { cn } from "@/lib/utils";

const STEPS = ["上传文件", "预览与冲突", "选择策略并确认"];

/** 三步对话框的步骤条（文档翻译的新建任务对话框复用） */
export function Stepper({ step, steps = STEPS }: { step: number; steps?: readonly string[] }) {
  return (
    <ol className="flex items-center gap-2">
      {steps.map((label, i) => {
        const done = i < step;
        const active = i === step;
        return (
          <li key={label} className="flex flex-1 items-center gap-2">
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors duration-150",
                done && "bg-success text-success-foreground",
                active && "bg-brand-gradient text-brand-foreground shadow-brand",
                !done && !active && "bg-muted text-muted-foreground",
              )}
            >
              {done ? <CheckIcon className="size-3.5" /> : i + 1}
            </span>
            <span className={cn("text-xs whitespace-nowrap", active ? "font-medium" : "text-muted-foreground")}>
              {label}
            </span>
            {i < steps.length - 1 && (
              <span className="relative h-px flex-1 overflow-hidden bg-border">
                <motion.span
                  className="absolute inset-0 origin-left bg-success"
                  initial={false}
                  animate={{ scaleX: done ? 1 : 0 }}
                  transition={{ duration: 0.3, ease: EASE_OUT }}
                />
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "success" | "warning" | "danger" | "brand" }) {
  return (
    <div className="rounded-xl border bg-card p-3 shadow-card">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <NumberTicker
        value={value}
        className={cn(
          "mt-1 block text-xl font-semibold",
          tone === "success" && "text-success",
          tone === "warning" && "text-warning",
          tone === "danger" && "text-danger",
          tone === "brand" && "text-brand",
        )}
      />
    </div>
  );
}

/** 三步导入：① 上传 → ② 预览与冲突 → ③ 选择策略并确认（完成后动画展示结果） */
export function ImportDialog({
  glossary,
  open,
  onOpenChange,
}: {
  glossary: GlossaryVO;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const reduce = useReducedMotion();
  const inputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [strategy, setStrategy] = useState<ImportStrategy>("skip");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const reset = () => {
    setStep(0);
    setFile(null);
    setPreview(null);
    setResult(null);
    setError(null);
    setStrategy("skip");
  };

  const go = (s: number) => {
    setDir(s > step ? 1 : -1);
    setError(null);
    setStep(s);
  };

  const pick = (f: File | undefined | null) => {
    if (!f) return;
    setFile(f);
    setError(null);
  };

  const runPreview = async () => {
    if (!file) return;
    setPending(true);
    setError(null);
    try {
      setPreview(await glossaryApi.importPreview(glossary.id, file));
      go(1);
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  };

  const runImport = async () => {
    if (!file) return;
    setPending(true);
    setError(null);
    try {
      setResult(await glossaryApi.importTerms(glossary.id, file, strategy));
      void qc.invalidateQueries({ queryKey: ["glossaries"] });
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  };

  const slide = {
    initial: (d: number) => ({ opacity: 0, x: reduce ? 0 : d * 24 }),
    animate: { opacity: 1, x: 0 },
    exit: (d: number) => ({ opacity: 0, x: reduce ? 0 : d * -24 }),
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setTimeout(reset, 200);
      }}
    >
      <DialogContent className="gap-5 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>导入术语</DialogTitle>
          <DialogDescription>导入到「{glossary.name}」· UTF-8 CSV，列为 source,target,note</DialogDescription>
        </DialogHeader>
        <Stepper step={result ? 3 : step} />

        <div className="relative min-h-64 overflow-hidden">
          <AnimatePresence mode="wait" custom={dir} initial={false}>
            {step === 0 && (
              <motion.div
                key="s0"
                custom={dir}
                variants={slide}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={{ duration: DURATION.page, ease: EASE_OUT }}
                className="space-y-3"
              >
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragging(false);
                    pick(e.dataTransfer.files?.[0]);
                  }}
                  className={cn(
                    "flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-9 text-center transition-colors",
                    dragging ? "border-brand bg-brand-soft" : "hover:border-brand/50 hover:bg-muted/50",
                  )}
                >
                  <span className="flex size-11 items-center justify-center rounded-xl bg-brand-soft text-brand">
                    <UploadCloudIcon className="size-5" />
                  </span>
                  <span className="text-sm font-medium">点击选择或拖拽 CSV 文件到这里</span>
                  <span className="text-xs text-muted-foreground">单次最多 5000 行，首行为表头，可带 BOM</span>
                </button>
                <input
                  ref={inputRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  aria-label="选择 CSV 文件"
                  onChange={(e) => pick(e.target.files?.[0])}
                />
                <AnimatePresence>
                  {file && (
                    <motion.div
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5"
                    >
                      <FileSpreadsheetIcon className="size-5 text-success" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{file.name}</div>
                        <div className="text-xs text-muted-foreground">{(file.size / 1024).toFixed(1)} KB</div>
                      </div>
                      <Button variant="ghost" size="icon-sm" aria-label="移除文件" onClick={() => setFile(null)}>
                        <XIcon />
                      </Button>
                    </motion.div>
                  )}
                </AnimatePresence>
                <pre className="rounded-lg bg-muted/60 px-3 py-2 font-mono text-xs leading-relaxed text-muted-foreground">
                  source,target,note{"\n"}GPU,图形处理器,不要译作“显卡”{"\n"}machine learning,机器学习,
                </pre>
              </motion.div>
            )}

            {step === 1 && preview && (
              <motion.div
                key="s1"
                custom={dir}
                variants={slide}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={{ duration: DURATION.page, ease: EASE_OUT }}
                className="space-y-4"
              >
                <div className="grid grid-cols-4 gap-2">
                  <Stat label="总行数" value={preview.total} />
                  <Stat label="有效" value={preview.valid} tone="success" />
                  <Stat label="新增" value={preview.newCount} tone="brand" />
                  <Stat label="将覆盖" value={preview.updateCount} tone="warning" />
                </div>
                {preview.errors.length > 0 && (
                  <div className="rounded-lg border border-danger/30 bg-danger-soft">
                    <div className="border-b border-danger/20 px-3 py-2 text-xs font-medium text-danger">
                      {preview.errors.length} 行存在错误，导入时会被跳过
                    </div>
                    <ul className="scrollbar-thin max-h-28 overflow-y-auto px-3 py-2 text-xs">
                      {preview.errors.map((er) => (
                        <li key={er.line} className="flex gap-3 py-0.5">
                          <span className="w-12 shrink-0 font-mono text-danger">第 {er.line} 行</span>
                          <span className="text-foreground/80">{er.message}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {preview.sample.length > 0 && (
                  <div className="overflow-hidden rounded-lg border">
                    <div className="border-b bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">样例</div>
                    <table className="w-full text-xs">
                      <tbody className="divide-y">
                        {preview.sample.map((r, i) => (
                          <tr key={i}>
                            <td className="px-3 py-1.5 font-medium">{r.sourceTerm}</td>
                            <td className="px-3 py-1.5 text-brand">{r.targetTerm}</td>
                            <td className="px-3 py-1.5 text-muted-foreground">{r.note || "—"}</td>
                            <td className="w-16 px-3 py-1.5 text-right">
                              {r.exists && (
                                <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning">将覆盖</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </motion.div>
            )}

            {step === 2 && preview && !result && (
              <motion.div
                key="s2"
                custom={dir}
                variants={slide}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={{ duration: DURATION.page, ease: EASE_OUT }}
                className="space-y-3"
              >
                <p className="text-sm text-muted-foreground">
                  共有 <span className="font-medium text-foreground">{preview.updateCount}</span> 条与已有术语重复，选择处理方式：
                </p>
                {(
                  [
                    { v: "skip", icon: SkipForwardIcon, title: "跳过已存在", desc: "保留现有译法，只新增不存在的术语" },
                    { v: "overwrite", icon: RefreshCwIcon, title: "覆盖已存在", desc: "用文件中的译法与备注替换现有术语" },
                  ] as const
                ).map((o) => {
                  const active = strategy === o.v;
                  const Icon = o.icon;
                  return (
                    <button
                      key={o.v}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setStrategy(o.v)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-xl border p-4 text-left transition-colors",
                        active ? "border-brand/50 bg-brand-soft ring-1 ring-brand/30" : "hover:bg-muted/50",
                      )}
                    >
                      <span className={cn("flex size-9 items-center justify-center rounded-lg", active ? "bg-brand-gradient text-brand-foreground" : "bg-muted text-muted-foreground")}>
                        <Icon className="size-4" />
                      </span>
                      <span className="flex-1">
                        <span className="block text-sm font-medium">{o.title}</span>
                        <span className="block text-xs text-muted-foreground">{o.desc}</span>
                      </span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        预计新增 {preview.newCount}
                        {o.v === "overwrite" ? ` · 覆盖 ${preview.updateCount}` : ` · 跳过 ${preview.updateCount}`}
                      </span>
                    </button>
                  );
                })}
              </motion.div>
            )}

            {result && (
              <motion.div
                key="done"
                initial={{ opacity: 0, scale: reduce ? 1 : 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: DURATION.page, ease: EASE_OUT }}
                className="flex flex-col items-center gap-4 py-2 text-center"
              >
                <motion.span
                  initial={{ scale: reduce ? 1 : 0.5, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: "spring", stiffness: 380, damping: 20 }}
                  className="flex size-14 items-center justify-center rounded-full bg-success-soft text-success ring-8 ring-success/10"
                >
                  <svg viewBox="0 0 24 24" className="size-7" fill="none" aria-hidden>
                    <motion.path
                      d="M5 12.5l4.2 4.2L19 7"
                      stroke="currentColor"
                      strokeWidth={2.4}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      initial={{ pathLength: reduce ? 1 : 0 }}
                      animate={{ pathLength: 1 }}
                      transition={{ duration: 0.45, delay: 0.15, ease: EASE_OUT }}
                    />
                  </svg>
                </motion.span>
                <div className="text-sm font-medium">导入完成</div>
                <div className="grid w-full grid-cols-4 gap-2">
                  <Stat label="新增" value={result.inserted} tone="brand" />
                  <Stat label="更新" value={result.updated} tone="warning" />
                  <Stat label="跳过" value={result.skipped} />
                  <Stat label="失败" value={result.failed} tone="danger" />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {error !== null && <ErrorState compact error={error} title="操作失败" className="rounded-lg border bg-muted/30" />}

        <div className="-mx-5 -mb-5 flex items-center justify-end gap-2 rounded-b-2xl border-t bg-muted/40 px-5 py-4">
          {result ? (
            <Button onClick={() => onOpenChange(false)}>完成</Button>
          ) : (
            <>
              {step > 0 && (
                <Button variant="outline" onClick={() => go(step - 1)} disabled={pending}>
                  上一步
                </Button>
              )}
              {step === 0 && (
                <Button onClick={runPreview} disabled={!file || pending}>
                  {pending && <Loader2Icon className="animate-spin" />}
                  下一步：预览
                </Button>
              )}
              {step === 1 && (
                <Button onClick={() => go(2)} disabled={!preview?.valid}>
                  下一步
                </Button>
              )}
              {step === 2 && (
                <Button onClick={runImport} disabled={pending}>
                  {pending && <Loader2Icon className="animate-spin" />}
                  确认导入
                </Button>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
