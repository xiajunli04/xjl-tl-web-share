"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowRightIcon, BookMarkedIcon, CheckIcon, ChevronDownIcon, CpuIcon, FlaskConicalIcon, ScanTextIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { LanguagePicker } from "@/components/translate/language-picker";
import { useGlossaryOptions, useLanguages } from "@/hooks/use-options";
import { imageApi } from "@/lib/api/image";
import { SPEECH_ENGINES_QUERY_KEY, speechApi, type EngineInfo } from "@/lib/api/speech";
import { MOCK_API } from "@/lib/mock/flags";
import { cn } from "@/lib/utils";
import { useImageStore } from "./image-store";

const triggerCls =
  "group inline-flex h-9 min-w-0 items-center gap-2 rounded-lg px-3 text-sm font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:bg-muted disabled:pointer-events-none disabled:opacity-50";

/** 内置引擎清单（引擎接口不可用时兜底） */
const FALLBACK_ENGINES: EngineInfo[] = [
  { id: "vision", type: "image", name: "视觉识别 + 平台翻译", vendor: "本平台", kind: "config", available: true, reason: null, languages: [], modelConfigId: null },
];

export function useImageEngines() {
  const q = useQuery({ queryKey: SPEECH_ENGINES_QUERY_KEY, queryFn: () => speechApi.engines(), staleTime: 60_000, retry: false });
  return { engines: q.data?.image?.length ? q.data.image : FALLBACK_ENGINES, loading: q.isLoading };
}

function EnginePicker({ disabled }: { disabled?: boolean }) {
  const engine = useImageStore((s) => s.engine);
  const patch = useImageStore((s) => s.patch);
  const { engines } = useImageEngines();
  const [open, setOpen] = useState(false);
  const current = engines.find((e) => e.id === engine) ?? engines[0];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<button type="button" aria-label="图片翻译引擎" disabled={disabled} className={triggerCls} />}>
        <ScanTextIcon className="size-4 text-brand" />
        <span className="max-w-40 truncate">{current?.name ?? "选择引擎"}</span>
        <ChevronDownIcon className="size-3.5 text-muted-foreground transition-transform group-aria-expanded:rotate-180" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 gap-0 p-1.5">
        {engines.map((e) => {
          const active = e.id === current?.id;
          return (
            <button
              key={e.id}
              type="button"
              disabled={!e.available}
              title={e.available ? undefined : (e.reason ?? "不可用")}
              onClick={() => {
                patch({ engine: e.id });
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                e.available ? "hover:bg-muted" : "cursor-not-allowed opacity-55",
                active && "bg-brand-soft hover:bg-brand-soft",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className={cn("font-medium", active && "text-brand")}>{e.name}</span>
                  <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{e.vendor}</span>
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {e.available
                    ? e.id === "qwen-mt-image"
                      ? "一体化译图，保留版式；只提供原图 / 译图对比"
                      : "视觉模型识别文字与位置 → 术语 → 平台翻译，可逐块编辑"
                    : (e.reason ?? "不可用")}
                </span>
              </span>
              {active && <CheckIcon className="mt-0.5 size-4 shrink-0 text-brand" />}
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

function VisionModelPicker({ disabled }: { disabled?: boolean }) {
  const modelConfigId = useImageStore((s) => s.modelConfigId);
  const patch = useImageStore((s) => s.patch);
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ["model-configs", "options", "vision"], queryFn: imageApi.visionModels, staleTime: 60_000, retry: false });
  const models = q.data ?? [];
  const current = models.find((m) => m.id === modelConfigId);
  const label = current?.name ?? (models.length ? `默认（${models[0].name}）` : q.isLoading ? "加载中…" : "无视觉模型");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<button type="button" aria-label="视觉模型" disabled={disabled} className={cn(triggerCls, !models.length && !q.isLoading && "text-warning")} />}
      >
        <CpuIcon className="size-4 text-muted-foreground" />
        <span className="max-w-44 truncate">{label}</span>
        <ChevronDownIcon className="size-3.5 text-muted-foreground transition-transform group-aria-expanded:rotate-180" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 gap-0 p-1.5">
        <p className="px-2.5 pt-1 pb-2 text-[11px] text-muted-foreground">只列出标记为「支持图片输入」的对话模型</p>
        {!models.length ? (
          <p className="px-2.5 py-4 text-center text-xs text-muted-foreground">
            暂无视觉模型，请管理员在
            <Link href="/admin/model-configs" className="mx-0.5 text-brand hover:underline">
              模型配置
            </Link>
            中开启「支持图片输入」
          </p>
        ) : (
          [{ id: null as number | null, name: `默认（${models[0].name}）` }, ...models.map((m) => ({ id: m.id as number | null, name: m.name }))].map((m) => {
            const active = m.id === modelConfigId || (m.id === null && !current);
            return (
              <button
                key={m.id ?? "default"}
                type="button"
                onClick={() => {
                  patch({ modelConfigId: m.id });
                  setOpen(false);
                }}
                className={cn("flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-muted", active && "bg-brand-soft text-brand hover:bg-brand-soft")}
              >
                <span className="flex-1 truncate">{m.name}</span>
                {active && <CheckIcon className="size-4" />}
              </button>
            );
          })
        )}
      </PopoverContent>
    </Popover>
  );
}

function GlossaryPicker({ disabled }: { disabled?: boolean }) {
  const glossaryIds = useImageStore((s) => s.glossaryIds);
  const patch = useImageStore((s) => s.patch);
  const q = useGlossaryOptions();
  const toggle = (id: number) =>
    patch({ glossaryIds: glossaryIds.includes(id) ? glossaryIds.filter((x) => x !== id) : [...glossaryIds, id] });
  return (
    <Popover>
      <PopoverTrigger render={<button type="button" aria-label="术语库" disabled={disabled} className={triggerCls} />}>
        <BookMarkedIcon className="size-4 text-muted-foreground" />
        术语库
        {glossaryIds.length > 0 && (
          <span className="flex size-4.5 items-center justify-center rounded-full bg-brand-gradient text-[10px] font-semibold text-brand-foreground">
            {glossaryIds.length}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 gap-0 p-1.5">
        <div className="flex items-center justify-between px-2.5 pt-1 pb-2">
          <span className="text-[11px] text-muted-foreground">术语作为翻译的硬约束</span>
          <Link href="/glossaries" className="text-[11px] text-brand hover:underline">
            管理术语库
          </Link>
        </div>
        <div className="scrollbar-thin max-h-64 overflow-y-auto">
          {!q.data?.length ? (
            <p className="px-2.5 py-4 text-center text-xs text-muted-foreground">{q.isLoading ? "加载中…" : "还没有术语库"}</p>
          ) : (
            q.data.map((g) => (
              <label key={g.id} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm hover:bg-muted">
                <Checkbox checked={glossaryIds.includes(g.id)} onCheckedChange={() => toggle(g.id)} />
                <span className="min-w-0 flex-1 truncate">{g.name}</span>
                <span className="text-[11px] text-muted-foreground">
                  {g.sourceLang} → {g.targetLang}
                </span>
              </label>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** 顶部工具条：源 / 目标语言、引擎、视觉模型、术语库 */
export function ImageToolbar({ disabled, actions }: { disabled?: boolean; actions?: React.ReactNode }) {
  const languages = useLanguages();
  const sourceLang = useImageStore((s) => s.sourceLang);
  const targetLang = useImageStore((s) => s.targetLang);
  const engine = useImageStore((s) => s.engine);
  const patch = useImageStore((s) => s.patch);
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-xl border bg-card px-2 py-1.5 shadow-card">
      <div className={cn("flex min-w-0 items-center", disabled && "pointer-events-none opacity-60")}>
        <LanguagePicker label="源语言" allowAuto value={sourceLang} onChange={(v) => patch({ sourceLang: v })} languages={languages} />
        <ArrowRightIcon className="mx-0.5 size-4 shrink-0 text-muted-foreground" />
        <LanguagePicker label="目标语言" value={targetLang} onChange={(v) => patch({ targetLang: v })} languages={languages} />
      </div>
      <span className="mx-1 hidden h-5 w-px bg-border sm:block" />
      <EnginePicker disabled={disabled} />
      {engine === "vision" && <VisionModelPicker disabled={disabled} />}
      {engine === "vision" && <GlossaryPicker disabled={disabled} />}
      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        {MOCK_API && (
          <span className="hidden items-center gap-1 rounded-full bg-warning-soft px-2 py-1 text-[11px] text-warning xl:inline-flex">
            <FlaskConicalIcon className="size-3" />
            离线演示数据
          </span>
        )}
        {actions}
      </div>
    </div>
  );
}
