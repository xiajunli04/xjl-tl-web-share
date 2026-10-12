"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowRightIcon,
  BookMarkedIcon,
  CheckIcon,
  ChevronDownIcon,
  ClipboardPasteIcon,
  ClockIcon,
  CpuIcon,
  FileTextIcon,
  FlaskConicalIcon,
  Loader2Icon,
  LayersIcon,
  ScanSearchIcon,
  SparklesIcon,
  UploadCloudIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ErrorState } from "@/components/feedback/error-state";
import { Stepper } from "@/components/glossary/import-dialog";
import { NumberTicker } from "@/components/motion/number-ticker";
import { DURATION, EASE_OUT, SPRING_LAYOUT } from "@/components/motion/tokens";
import { LanguagePicker } from "@/components/translate/language-picker";
import { useGlossaryOptions, useLanguages, useModelOptions } from "@/hooks/use-options";
import { docApi, type DocFormat, type DocOptions, type DocStrategy, type DocTaskSettings } from "@/lib/api/documents";
import type { TranslateStyle } from "@/lib/api/translate";
import { DOMAIN_PRESETS, STYLE_OPTIONS, langName, styleLabel } from "@/lib/languages";
import { SAME_AS_TRANSLATOR_UNSET, reviewOptionOf } from "@/lib/review-model";
import { cn } from "@/lib/utils";
import { ProgressBar } from "./bits";
import {
  DEFAULT_CONFIRM_TERMS,
  DEFAULT_OPTIONS,
  DEFAULT_STRATEGY,
  OPTION_META,
  PRESETS,
  STRATEGY_META,
  estimateChunks,
  estimateGroups,
  estimateSeconds,
  formatChars,
  presetLabel,
  presetOf,
  type Preset,
} from "./meta";

export const MAX_DOC_CHARS = 50_000;
const STEPS = ["上传或粘贴", "翻译设置", "确认创建"] as const;
const ACCEPT = [".md", ".markdown", ".txt"];

function extOf(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function guessFormat(text: string): DocFormat {
  return /^(#{1,6}\s|\s*[-*+]\s|\s*\d+\.\s|```|>\s|\|.*\|)/m.test(text) ? "md" : "txt";
}

function guessTitle(text: string) {
  const h = text.match(/^#\s+(.+)$/m)?.[1];
  if (h) return h.trim().slice(0, 80);
  const first = text.split(/\r?\n/).find((l) => l.trim());
  return first ? first.trim().slice(0, 40) : "";
}

function Section({ title, aside, children, className }: { title: string; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("space-y-2", className)}>
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
        {aside}
      </div>
      {children}
    </section>
  );
}

function PresetButton({ p, active, onPick }: { p: Preset; active: boolean; onPick: () => void }) {
  const recommended = p.group === "recommended";
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onPick}
      className={cn(
        "relative rounded-lg border bg-card px-2.5 py-2 text-left transition-colors",
        active ? "border-brand/50" : "hover:bg-muted/60",
      )}
    >
      {active && (
        <motion.span
          layoutId="doc-preset-active"
          className="absolute inset-0 rounded-lg bg-brand-soft ring-1 ring-brand/30"
          transition={SPRING_LAYOUT}
        />
      )}
      <span className="relative flex items-center gap-1.5">
        {recommended ? (
          <SparklesIcon className={cn("size-3.5", active ? "text-brand" : "text-muted-foreground")} />
        ) : (
          <span className={cn("font-mono text-xs font-semibold", active ? "text-brand" : "text-muted-foreground")}>{p.key}</span>
        )}
        <span className="truncate text-xs font-medium">{recommended ? "推荐配置" : p.name}</span>
      </span>
      <span className="relative mt-0.5 block truncate text-[11px] text-muted-foreground">
        {p.caption} · {STRATEGY_META[p.strategy].label}
      </span>
    </button>
  );
}

function SummaryItem({ label, children, icon: Icon }: { label: string; children: React.ReactNode; icon: typeof FileTextIcon }) {
  return (
    <div className="flex gap-3 rounded-xl border bg-card p-3 shadow-card">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0">
        <div className="text-[11px] text-muted-foreground">{label}</div>
        <div className="mt-0.5 text-sm">{children}</div>
      </div>
    </div>
  );
}

/** 新建文档任务：① 上传 / 粘贴 → ② 翻译设置（含可折叠的实验选项）→ ③ 确认 */
export function NewTaskDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const reduce = useReducedMotion();
  const languages = useLanguages();
  const glossaries = useGlossaryOptions();
  const models = useModelOptions();
  const inputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  const [mode, setMode] = useState<"file" | "paste">("file");
  const [file, setFile] = useState<File | null>(null);
  const [fileText, setFileText] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [paste, setPaste] = useState("");
  const [pasteFormat, setPasteFormat] = useState<DocFormat | null>(null);
  const [title, setTitle] = useState<string | null>(null);

  const [sourceLang, setSourceLang] = useState("auto");
  const [targetLang, setTargetLang] = useState("zh");
  const [style, setStyle] = useState<TranslateStyle>("faithful");
  const [domain, setDomain] = useState("");
  const [glossaryIds, setGlossaryIds] = useState<number[]>([]);
  const [modelConfigId, setModelConfigId] = useState<number | null>(null);
  const [strategy, setStrategy] = useState<DocStrategy>(DEFAULT_STRATEGY);
  const [confirmTerms, setConfirmTerms] = useState(DEFAULT_CONFIRM_TERMS);
  const [options, setOptions] = useState<DocOptions>(DEFAULT_OPTIONS);
  const [expOpen, setExpOpen] = useState(false);

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const text = mode === "file" ? fileText : paste;
  const format: DocFormat =
    mode === "file" ? (file && extOf(file.name) === "txt" ? "txt" : "md") : (pasteFormat ?? guessFormat(paste));
  const chars = text.length;
  const over = chars > MAX_DOC_CHARS;
  const empty = !text.trim();
  const autoTitle = mode === "file" && file ? file.name.replace(/\.[^.]+$/, "") : guessTitle(paste);
  const finalTitle = (title ?? autoTitle).trim();
  const chunks = useMemo(() => estimateChunks(text, format), [text, format]);
  const preset = presetOf(options, strategy);
  const groups = useMemo(() => estimateGroups(text, format), [text, format]);
  const seconds = estimateSeconds(chunks, options, strategy, groups);
  // 评审模型由 Spring 在创建时解析（管理员设置的评审模型，未设置时与译者相同），这里只做展示
  const reviewModel = reviewOptionOf(models.data);
  const translatorModel = modelConfigId !== null ? models.data?.find((m) => m.id === modelConfigId) : models.data?.find((m) => m.isDefault);
  const reviewText = models.isLoading
    ? "评审模型：加载中…"
    : reviewModel
      ? `评审模型：${reviewModel.name}`
      : models.isError
        ? "评审模型：管理员设置的评审模型（未设置时与译者相同）"
        : SAME_AS_TRANSLATOR_UNSET;
  const reviewSameAsTranslator = !!reviewModel && reviewModel.id === translatorModel?.id;
  const canNext0 = !empty && !over && !fileError;

  const reset = () => {
    setStep(0);
    setMode("file");
    setFile(null);
    setFileText("");
    setFileError(null);
    setPaste("");
    setPasteFormat(null);
    setTitle(null);
    setError(null);
    setExpOpen(false);
  };

  const go = (s: number) => {
    setDir(s > step ? 1 : -1);
    setError(null);
    setStep(s);
  };

  const pick = async (f: File | undefined | null) => {
    if (!f) return;
    setFile(f);
    setTitle(null);
    setError(null);
    if (!ACCEPT.includes(`.${extOf(f.name)}`)) {
      setFileText("");
      setFileError("仅支持 .md / .markdown / .txt 文件");
      return;
    }
    try {
      const raw = await f.text();
      setFileText(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
      setFileError(null);
    } catch {
      setFileText("");
      setFileError("无法读取文件，请确认是 UTF-8 编码的文本文件");
    }
  };

  const applyPreset = (key: string) => {
    const p = PRESETS.find((x) => x.key === key);
    if (!p) return;
    setOptions(p.options);
    setStrategy(p.strategy);
  };

  const submit = async () => {
    setPending(true);
    setError(null);
    const settings: DocTaskSettings = {
      title: finalTitle || undefined,
      sourceLang,
      targetLang,
      style,
      domain: domain || undefined,
      glossaryIds: glossaryIds.length ? glossaryIds : undefined,
      modelConfigId: modelConfigId ?? undefined,
      strategy,
      confirmTerms,
      options,
    };
    try {
      const vo =
        mode === "file" && file
          ? await docApi.createWithFile(file, settings)
          : await docApi.create({ ...settings, text, format });
      toast.success("任务已创建，正在解析文档");
      void qc.invalidateQueries({ queryKey: ["doc-tasks"] });
      onOpenChange(false);
      setTimeout(reset, 200);
      router.push(`/documents/${vo.id}`);
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
  const stepMotion = {
    custom: dir,
    variants: slide,
    initial: "initial",
    animate: "animate",
    exit: "exit",
    transition: { duration: DURATION.page, ease: EASE_OUT },
  } as const;

  const sameLang = sourceLang !== "auto" && sourceLang === targetLang;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setTimeout(reset, 200);
      }}
    >
      <DialogContent className="gap-5 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>新建文档翻译任务</DialogTitle>
          <DialogDescription>Markdown 结构（标题、列表、表格、代码块）会原样保留，只翻译正文</DialogDescription>
        </DialogHeader>
        <Stepper step={step} steps={STEPS} />

        <div className="scrollbar-thin relative -mx-1 max-h-[60vh] min-h-80 overflow-x-hidden overflow-y-auto px-1">
          <AnimatePresence mode="wait" custom={dir} initial={false}>
            {step === 0 && (
              <motion.div key="s0" {...stepMotion} className="space-y-4">
                <Segmented<"file" | "paste">
                  ariaLabel="文档来源"
                  value={mode}
                  onChange={(v) => {
                    setMode(v);
                    setTitle(null);
                  }}
                  options={[
                    { value: "file", label: <><UploadCloudIcon className="size-4" />上传文件</> },
                    { value: "paste", label: <><ClipboardPasteIcon className="size-4" />粘贴文本</> },
                  ]}
                />
                <AnimatePresence mode="wait" initial={false}>
                  {mode === "file" ? (
                    <motion.div
                      key="file"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: DURATION.fast }}
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
                          void pick(e.dataTransfer.files?.[0]);
                        }}
                        className={cn(
                          "flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-9 text-center transition-colors",
                          dragging ? "border-brand bg-brand-soft" : "hover:border-brand/50 hover:bg-muted/50",
                        )}
                      >
                        <motion.span
                          animate={dragging && !reduce ? { y: -4, scale: 1.06 } : { y: 0, scale: 1 }}
                          transition={SPRING_LAYOUT}
                          className="flex size-11 items-center justify-center rounded-xl bg-brand-soft text-brand"
                        >
                          <UploadCloudIcon className="size-5" />
                        </motion.span>
                        <span className="text-sm font-medium">点击选择或拖拽文档到这里</span>
                        <span className="text-xs text-muted-foreground">.md / .markdown / .txt · UTF-8 · 不超过 5 万字符</span>
                      </button>
                      <input
                        ref={inputRef}
                        type="file"
                        accept=".md,.markdown,.txt,text/markdown,text/plain"
                        className="hidden"
                        aria-label="选择文档"
                        onChange={(e) => {
                          void pick(e.target.files?.[0]);
                          e.target.value = "";
                        }}
                      />
                      <AnimatePresence>
                        {file && (
                          <motion.div
                            initial={{ opacity: 0, y: 4 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0 }}
                            className={cn(
                              "flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5",
                              fileError && "border-danger/40 bg-danger-soft",
                            )}
                          >
                            <FileTextIcon className={cn("size-5", fileError ? "text-danger" : "text-brand")} />
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-medium">{file.name}</div>
                              <div className={cn("text-xs", fileError ? "text-danger" : "text-muted-foreground")}>
                                {fileError ?? `${(file.size / 1024).toFixed(1)} KB · ${format === "md" ? "Markdown" : "纯文本"}`}
                              </div>
                            </div>
                            {!fileError && (
                              <span className="rounded-md bg-brand-soft px-1.5 py-0.5 text-[11px] font-medium text-brand uppercase">
                                {format}
                              </span>
                            )}
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label="移除文件"
                              onClick={() => {
                                setFile(null);
                                setFileText("");
                                setFileError(null);
                              }}
                            >
                              <XIcon />
                            </Button>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </motion.div>
                  ) : (
                    <motion.div
                      key="paste"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: DURATION.fast }}
                      className="space-y-2"
                    >
                      <Textarea
                        value={paste}
                        onChange={(e) => setPaste(e.target.value)}
                        placeholder="粘贴 Markdown 或纯文本…"
                        aria-label="文档内容"
                        aria-invalid={over || undefined}
                        className="scrollbar-thin h-52 resize-none font-mono text-xs leading-relaxed field-sizing-fixed"
                      />
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        格式
                        <Segmented<DocFormat>
                          ariaLabel="文档格式"
                          size="sm"
                          value={format}
                          onChange={setPasteFormat}
                          options={[
                            { value: "md", label: "Markdown" },
                            { value: "txt", label: "纯文本" },
                          ]}
                        />
                        {pasteFormat === null && paste.trim() && (
                          <span className="inline-flex items-center gap-1 text-brand">
                            <SparklesIcon className="size-3" />
                            已自动识别
                          </span>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                  <div className="grid gap-1.5">
                    <Label htmlFor="doc-title">任务标题</Label>
                    <Input
                      id="doc-title"
                      value={title ?? autoTitle}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="默认取文件名或首个标题"
                      maxLength={200}
                    />
                  </div>
                  <div className="rounded-lg border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground sm:w-56">
                    <div className="flex items-baseline justify-between gap-2">
                      <span>字符数</span>
                      <span className={cn("tabular-nums", over ? "font-semibold text-danger" : "text-foreground")}>
                        <NumberTicker value={chars} /> / {MAX_DOC_CHARS.toLocaleString("en-US")}
                      </span>
                    </div>
                    <ProgressBar value={chars / MAX_DOC_CHARS} tone={over ? "danger" : chars > MAX_DOC_CHARS * 0.85 ? "warning" : "brand"} className="mt-1.5 h-1" />
                  </div>
                </div>
                <AnimatePresence>
                  {over && (
                    <motion.p
                      initial={{ opacity: 0, y: -2 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      role="alert"
                      className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger"
                    >
                      文档超过 5 万字符上限（当前 {chars.toLocaleString("en-US")}），请拆分后分别创建任务。
                    </motion.p>
                  )}
                </AnimatePresence>
              </motion.div>
            )}

            {step === 1 && (
              <motion.div key="s1" {...stepMotion} className="space-y-5">
                <div className="grid gap-5 md:grid-cols-2">
                  <div className="space-y-5">
                    <Section title="语言">
                      <div className="flex items-center rounded-lg border bg-card px-1 py-0.5">
                        <LanguagePicker label="源语言" allowAuto value={sourceLang} onChange={setSourceLang} languages={languages} />
                        <ArrowRightIcon className="mx-1 size-4 shrink-0 text-muted-foreground" />
                        <LanguagePicker label="目标语言" value={targetLang} onChange={setTargetLang} languages={languages} />
                      </div>
                      {sameLang && <p className="text-xs text-danger">源语言与目标语言不能相同</p>}
                    </Section>
                    <Section title="风格">
                      <Segmented<TranslateStyle>
                        ariaLabel="翻译风格"
                        className="w-full"
                        value={style}
                        onChange={setStyle}
                        options={STYLE_OPTIONS.map((o) => ({ value: o.value, label: o.label, title: o.hint }))}
                      />
                    </Section>
                    <Section title="领域">
                      <div className="flex flex-wrap gap-1.5">
                        {["", ...DOMAIN_PRESETS].map((d) => (
                          <button
                            key={d || "auto"}
                            type="button"
                            onClick={() => setDomain(d)}
                            className={cn(
                              "h-7 rounded-full border px-3 text-xs transition-colors",
                              domain === d ? "border-brand/40 bg-brand-soft text-brand" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                            )}
                          >
                            {d || "自动判定"}
                          </button>
                        ))}
                      </div>
                    </Section>
                    <Section title="术语库" aside={<span className="text-[11px] text-muted-foreground">术语库译法优先于抽取结果</span>}>
                      <div className="scrollbar-thin max-h-32 space-y-0.5 overflow-y-auto rounded-lg border p-1">
                        {glossaries.isLoading ? (
                          <div className="space-y-1 p-1">
                            <Skeleton className="h-7" />
                            <Skeleton className="h-7" />
                          </div>
                        ) : !glossaries.data?.length ? (
                          <p className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
                            <BookMarkedIcon className="size-3.5" />
                            {glossaries.isError ? "术语库加载失败" : "还没有术语库"}
                          </p>
                        ) : (
                          glossaries.data.map((g) => {
                            const checked = glossaryIds.includes(g.id);
                            return (
                              <button
                                key={g.id}
                                type="button"
                                role="checkbox"
                                aria-checked={checked}
                                onClick={() =>
                                  setGlossaryIds((ids) => (checked ? ids.filter((x) => x !== g.id) : [...ids, g.id]))
                                }
                                className={cn(
                                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted",
                                  checked && "bg-brand-soft hover:bg-brand-soft",
                                )}
                              >
                                <span
                                  className={cn(
                                    "flex size-3.5 shrink-0 items-center justify-center rounded border transition-colors",
                                    checked ? "border-transparent bg-brand-gradient text-brand-foreground" : "border-input",
                                  )}
                                >
                                  {checked && <CheckIcon className="size-2.5" />}
                                </span>
                                <span className="min-w-0 flex-1 truncate">{g.name}</span>
                                <span className="shrink-0 text-[11px] text-muted-foreground">
                                  {langName(g.sourceLang)}→{langName(g.targetLang)} · {g.termCount}
                                </span>
                              </button>
                            );
                          })
                        )}
                      </div>
                    </Section>
                  </div>

                  <div className="space-y-5">
                    <Section title="分块策略">
                      <div role="radiogroup" aria-label="分块策略" className="space-y-2">
                        {(Object.keys(STRATEGY_META) as DocStrategy[]).map((k) => {
                          const m = STRATEGY_META[k];
                          const Icon = m.icon;
                          const active = strategy === k;
                          return (
                            <button
                              key={k}
                              type="button"
                              role="radio"
                              aria-checked={active}
                              onClick={() => setStrategy(k)}
                              className={cn(
                                "relative flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors",
                                active ? "border-brand/50" : "hover:bg-muted/50",
                              )}
                            >
                              {active && (
                                <motion.span
                                  layoutId="doc-strategy-active"
                                  className="absolute inset-0 rounded-xl bg-brand-soft ring-1 ring-brand/30"
                                  transition={SPRING_LAYOUT}
                                />
                              )}
                              <span
                                className={cn(
                                  "relative flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors",
                                  active ? "bg-brand-gradient text-brand-foreground" : "bg-muted text-muted-foreground",
                                )}
                              >
                                <Icon className="size-4" />
                              </span>
                              <span className="relative min-w-0 flex-1">
                                <span className="flex items-center gap-1.5 text-sm font-medium">
                                  {m.label}
                                  {m.recommended && (
                                    <span
                                      className={cn(
                                        "inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-[10px] font-medium transition-colors duration-200",
                                        active ? "bg-brand-gradient text-brand-foreground shadow-brand" : "bg-brand-soft text-brand ring-1 ring-brand/20",
                                      )}
                                    >
                                      <SparklesIcon className="size-2.5" />
                                      推荐
                                    </span>
                                  )}
                                </span>
                                <span className="block text-xs leading-relaxed text-muted-foreground">{m.desc}</span>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </Section>
                    <label className="flex cursor-pointer items-start gap-3 rounded-xl border bg-card p-3">
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">人工确认术语</span>
                        <span className="block text-xs leading-relaxed text-muted-foreground">
                          全文分析后暂停，由你确认或修改候选术语，再按确认后的术语表翻译
                        </span>
                      </span>
                      <Switch checked={confirmTerms} onCheckedChange={setConfirmTerms} aria-label="人工确认术语" />
                    </label>
                    {(models.data?.length ?? 0) > 0 && (
                      <Section title="模型">
                        <div className="flex flex-wrap gap-1.5">
                          {[{ id: null as number | null, name: "默认模型" }, ...(models.data ?? []).map((m) => ({ id: m.id as number | null, name: m.name }))].map((m) => (
                            <button
                              key={m.id ?? "default"}
                              type="button"
                              onClick={() => setModelConfigId(m.id)}
                              className={cn(
                                "h-7 rounded-full border px-3 text-xs transition-colors",
                                modelConfigId === m.id ? "border-brand/40 bg-brand-soft text-brand" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                              )}
                            >
                              {m.name}
                            </button>
                          ))}
                        </div>
                      </Section>
                    )}
                  </div>
                </div>

                {/* 实验选项（D12）：默认折叠 */}
                <div className="overflow-hidden rounded-xl border bg-muted/30">
                  <button
                    type="button"
                    aria-expanded={expOpen}
                    onClick={() => setExpOpen((o) => !o)}
                    className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm hover:bg-muted/50"
                  >
                    <FlaskConicalIcon className="size-4 text-brand" />
                    <span className="font-medium">实验选项</span>
                    <span className="hidden text-xs text-muted-foreground sm:inline">默认即推荐配置，也可切换到消融对照组</span>
                    <span
                      className={cn(
                        "ml-auto rounded-full px-2 py-0.5 text-[11px] font-medium",
                        preset ? "bg-brand-soft text-brand" : "bg-warning-soft text-warning",
                      )}
                    >
                      {presetLabel(preset)}
                    </span>
                    <ChevronDownIcon className={cn("size-4 text-muted-foreground transition-transform duration-200", expOpen && "rotate-180")} />
                  </button>
                  <AnimatePresence initial={false}>
                    {expOpen && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: DURATION.page, ease: EASE_OUT }}
                        className="overflow-hidden"
                      >
                        <div className="space-y-4 border-t px-3 pt-3 pb-4">
                          <div className="space-y-3">
                            <div className="text-xs text-muted-foreground">
                              快捷预设：选中后自动设置下面五个开关与分块策略
                            </div>
                            <div>
                              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                                <SparklesIcon className="size-3 text-brand" />
                                推荐
                              </div>
                              <div className="grid gap-2">
                                {PRESETS.filter((p) => p.group === "recommended").map((p) => (
                                  <PresetButton key={p.key} p={p} active={preset?.key === p.key} onPick={() => applyPreset(p.key)} />
                                ))}
                              </div>
                            </div>
                            <div>
                              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                                <FlaskConicalIcon className="size-3" />
                                实验对照 D0–D6
                                <span className="font-normal">· 论文消融组，均关闭翻译记忆</span>
                              </div>
                              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                                {PRESETS.filter((p) => p.group === "experiment").map((p) => (
                                  <PresetButton key={p.key} p={p} active={preset?.key === p.key} onPick={() => applyPreset(p.key)} />
                                ))}
                              </div>
                            </div>
                          </div>
                          <div className="grid gap-2 sm:grid-cols-2">
                            {OPTION_META.map((m) => (
                              <label key={m.key} className="flex cursor-pointer items-start gap-3 rounded-lg border bg-card p-2.5">
                                <span className="min-w-0 flex-1">
                                  <span className="flex items-center gap-1.5 text-sm font-medium">
                                    {m.label}
                                    <span className="font-mono text-[10px] font-normal text-muted-foreground">{m.key}</span>
                                  </span>
                                  <span className="block text-[11px] leading-relaxed text-muted-foreground">{m.desc}</span>
                                </span>
                                <Switch
                                  size="sm"
                                  checked={options[m.key]}
                                  onCheckedChange={(v) => setOptions((o) => ({ ...o, [m.key]: v }))}
                                  aria-label={m.label}
                                />
                              </label>
                            ))}
                          </div>
                          {/* 打开「评审修正」时展开将使用的评审模型（高度 + 淡入 200ms） */}
                          <AnimatePresence initial={false}>
                            {options.review && (
                              <motion.div
                                key="review-model"
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: "auto", opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                transition={{ duration: 0.2, ease: EASE_OUT }}
                                className="overflow-hidden"
                              >
                                <div
                                  role="status"
                                  className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-info/25 bg-info-soft px-2.5 py-2 text-xs"
                                >
                                  <ScanSearchIcon className="size-3.5 shrink-0 text-info" />
                                  <span className="font-medium text-info">{reviewText}</span>
                                  {reviewSameAsTranslator && (
                                    <span className="text-muted-foreground">· 与所选译者为同一模型，评审偏宽松</span>
                                  )}
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                          {strategy !== "serial" && options.contextWindow && (
                            <p className="text-[11px] text-muted-foreground">
                              提示：{STRATEGY_META[strategy].label}策略下块间不串行，前块上下文只在组内串行时生效。
                            </p>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </motion.div>
            )}

            {step === 2 && (
              <motion.div key="s2" {...stepMotion} className="space-y-4">
                <div className="relative overflow-hidden rounded-xl border bg-card p-4 shadow-card">
                  <div className="pointer-events-none absolute inset-0 bg-auth-glow opacity-70" aria-hidden />
                  <div className="relative flex items-center gap-4">
                    <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-brand-gradient text-brand-foreground shadow-brand">
                      <FileTextIcon className="size-6" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-base font-semibold">{finalTitle || "未命名文档"}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        <span className="rounded-md bg-muted px-1.5 py-0.5 font-medium uppercase">{format}</span>
                        <span>{formatChars(chars)}</span>
                        <span>·</span>
                        <span>{mode === "file" ? file?.name : "粘贴文本"}</span>
                      </div>
                    </div>
                    <div className="grid shrink-0 grid-cols-2 gap-4 text-right">
                      <div>
                        <div className="text-[11px] text-muted-foreground">预估分块</div>
                        <div className="text-xl font-semibold">
                          <NumberTicker value={chunks} />
                          <span className="ml-0.5 text-xs font-normal text-muted-foreground">块</span>
                        </div>
                      </div>
                      <div>
                        <div className="text-[11px] text-muted-foreground">预估耗时</div>
                        <div className="text-xl font-semibold">
                          <NumberTicker value={Math.max(1, Math.round(seconds / 60))} />
                          <span className="ml-0.5 text-xs font-normal text-muted-foreground">分钟</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="grid gap-2.5 sm:grid-cols-2">
                  <SummaryItem label="语言" icon={ArrowRightIcon}>
                    {langName(sourceLang)} → {langName(targetLang)}
                  </SummaryItem>
                  <SummaryItem label="风格 · 领域" icon={SparklesIcon}>
                    {styleLabel(style)} · {domain || "自动判定"}
                  </SummaryItem>
                  <SummaryItem label="术语" icon={BookMarkedIcon}>
                    {glossaryIds.length ? `${glossaryIds.length} 个术语库` : "不使用术语库"} · {confirmTerms ? "人工确认" : "自动确认"}
                  </SummaryItem>
                  <SummaryItem label="分块策略" icon={LayersIcon}>
                    {STRATEGY_META[strategy].label}
                    {strategy === "hybrid" && (
                      <span className="text-muted-foreground"> · {groups > 1 ? `约 ${groups} 章并行` : "无二级标题，等同串行"}</span>
                    )}
                  </SummaryItem>
                  <SummaryItem label="译者模型" icon={CpuIcon}>
                    {translatorModel?.name ?? "默认模型"}
                  </SummaryItem>
                  <SummaryItem label="评审修正" icon={ScanSearchIcon}>
                    {options.review ? (
                      <>
                        <span className="font-medium text-info">开启</span>
                        <span className="text-muted-foreground"> · {reviewModel ? `评审模型：${reviewModel.name}` : SAME_AS_TRANSLATOR_UNSET}</span>
                      </>
                    ) : (
                      <>
                        关闭
                        <span className="text-muted-foreground"> · 质量优先时可在实验选项中开启</span>
                      </>
                    )}
                  </SummaryItem>
                </div>
                <div className="rounded-xl border bg-muted/30 p-3">
                  <div className="mb-2 flex items-center gap-2 text-xs">
                    <FlaskConicalIcon className="size-3.5 text-brand" />
                    <span className="font-medium">实验配置</span>
                    <span className="text-muted-foreground">{presetLabel(preset, "自定义组合")}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {OPTION_META.map((m) => (
                      <span
                        key={m.key}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ring-1",
                          options[m.key] ? "bg-success-soft text-success ring-success/25" : "bg-muted text-muted-foreground line-through ring-border",
                        )}
                      >
                        {options[m.key] ? <CheckIcon className="size-3" /> : <XIcon className="size-3" />}
                        {m.label}
                      </span>
                    ))}
                  </div>
                </div>
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ClockIcon className="size-3.5" />
                  创建后可以离开页面，任务在后台继续执行；失败或取消后可从断点继续。
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {error !== null && <ErrorState compact error={error} title="创建失败" className="rounded-lg border bg-muted/30" />}

        <div className="-mx-5 -mb-5 flex items-center gap-2 rounded-b-2xl border-t bg-muted/40 px-5 py-4">
          <span className="text-xs text-muted-foreground">
            {step === 0 && !empty && !over && `约 ${chunks} 块 · ${format === "md" ? "Markdown" : "纯文本"}`}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {step > 0 && (
              <Button variant="outline" onClick={() => go(step - 1)} disabled={pending}>
                上一步
              </Button>
            )}
            {step === 0 && (
              <Button onClick={() => go(1)} disabled={!canNext0}>
                下一步：翻译设置
              </Button>
            )}
            {step === 1 && (
              <Button onClick={() => go(2)} disabled={sameLang}>
                下一步：确认
              </Button>
            )}
            {step === 2 && (
              <Button onClick={submit} disabled={pending || !canNext0}>
                {pending && <Loader2Icon className="animate-spin" />}
                创建任务
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
