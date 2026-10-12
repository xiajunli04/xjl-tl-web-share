"use client";

import Link from "next/link";
import { BookMarkedIcon, CheckIcon, CpuIcon, Settings2Icon, StarIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useGlossaryOptions, useModelOptions } from "@/hooks/use-options";
import { DOMAIN_PRESETS, STYLE_OPTIONS, langName } from "@/lib/languages";
import type { TranslateStyle } from "@/lib/api/translate";
import { cn } from "@/lib/utils";
import { useSpeechPrefs } from "@/stores/speech-prefs";
import { useWorkbenchStore } from "@/stores/workbench";

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** 「翻译设置」弹层：风格分段控件、领域、术语库多选、模型选择、完成后自动朗读 */
export function SettingsPopover({ effectiveSource }: { effectiveSource?: string }) {
  const style = useWorkbenchStore((s) => s.style);
  const domain = useWorkbenchStore((s) => s.domain);
  const glossaryIds = useWorkbenchStore((s) => s.glossaryIds);
  const modelConfigId = useWorkbenchStore((s) => s.modelConfigId);
  const targetLang = useWorkbenchStore((s) => s.targetLang);
  const patch = useWorkbenchStore((s) => s.patch);
  const autoRead = useSpeechPrefs((s) => s.autoRead);
  const setAutoRead = useSpeechPrefs((s) => s.setAutoRead);

  const glossaries = useGlossaryOptions();
  const models = useModelOptions();

  const changed =
    (style !== "faithful" ? 1 : 0) +
    (domain ? 1 : 0) +
    (glossaryIds.length ? 1 : 0) +
    (modelConfigId !== null ? 1 : 0) +
    (autoRead ? 1 : 0);

  const toggleGlossary = (id: number) =>
    patch({
      glossaryIds: glossaryIds.includes(id) ? glossaryIds.filter((x) => x !== id) : [...glossaryIds, id],
    });

  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" className="h-9 gap-2" />}>
        <Settings2Icon />
        翻译设置
        {changed > 0 && (
          <span className="flex size-4.5 items-center justify-center rounded-full bg-brand-gradient text-[10px] font-semibold text-brand-foreground">
            {changed}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[380px] gap-5 p-4">
        <Section title="风格">
          <Segmented<TranslateStyle>
            ariaLabel="翻译风格"
            className="w-full"
            value={style}
            onChange={(v) => patch({ style: v })}
            options={STYLE_OPTIONS.map((o) => ({ value: o.value, label: o.label, title: o.hint }))}
          />
          <p className="text-[11px] text-muted-foreground">
            {STYLE_OPTIONS.find((o) => o.value === style)?.hint}
          </p>
        </Section>

        <Section title="领域">
          <div className="flex flex-wrap gap-1.5">
            {["", ...DOMAIN_PRESETS].map((d) => {
              const active = domain === d;
              return (
                <button
                  key={d || "auto"}
                  type="button"
                  onClick={() => patch({ domain: d })}
                  className={cn(
                    "h-7 rounded-full border px-3 text-xs transition-colors",
                    active
                      ? "border-brand/40 bg-brand-soft text-brand"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {d || "自动判定"}
                </button>
              );
            })}
          </div>
        </Section>

        <Section
          title="术语库"
          aside={
            <Link href="/glossaries" className="text-[11px] text-brand hover:underline">
              管理术语库
            </Link>
          }
        >
          <div className="scrollbar-thin max-h-44 space-y-1 overflow-y-auto rounded-lg border p-1">
            {glossaries.isLoading ? (
              <div className="space-y-1.5 p-1.5">
                <Skeleton className="h-8" />
                <Skeleton className="h-8" />
              </div>
            ) : glossaries.isError ? (
              <p className="px-2 py-3 text-xs text-muted-foreground">术语库加载失败，可稍后重试</p>
            ) : !glossaries.data?.length ? (
              <p className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
                <BookMarkedIcon className="size-3.5" />
                还没有术语库
              </p>
            ) : (
              glossaries.data.map((g) => {
                const checked = glossaryIds.includes(g.id);
                const mismatch =
                  g.targetLang !== targetLang || (!!effectiveSource && effectiveSource !== g.sourceLang);
                return (
                  <button
                    key={g.id}
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    onClick={() => toggleGlossary(g.id)}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted",
                      checked && "bg-brand-soft hover:bg-brand-soft",
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
                        checked ? "border-transparent bg-brand-gradient text-brand-foreground" : "border-input",
                      )}
                    >
                      {checked && <CheckIcon className="size-3" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{g.name}</span>
                      <span className="block text-[11px] text-muted-foreground">
                        {langName(g.sourceLang)} → {langName(g.targetLang)} · {g.termCount} 条
                        {g.scope === "PUBLIC" && " · 公共"}
                      </span>
                    </span>
                    {mismatch && (
                      <span className="shrink-0 rounded bg-warning-soft px-1.5 text-[10px] text-warning">
                        语言对不符
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
          {glossaryIds.length > 0 && (
            <p className="text-[11px] text-muted-foreground">
              已选 {glossaryIds.length} 个；语言对与本次翻译不一致的术语库会被 Agent 跳过。
            </p>
          )}
        </Section>

        <Section title="模型">
          <div className="space-y-1">
            {models.isLoading ? (
              <Skeleton className="h-9" />
            ) : (
              <>
                <ModelRow
                  active={modelConfigId === null}
                  onClick={() => patch({ modelConfigId: null })}
                  title="默认模型"
                  subtitle={models.data?.find((m) => m.isDefault)?.name ?? "由管理员指定"}
                />
                {models.data?.map((m) => (
                  <ModelRow
                    key={m.id}
                    active={modelConfigId === m.id}
                    onClick={() => patch({ modelConfigId: m.id })}
                    title={m.name}
                    subtitle={m.provider === "ANTHROPIC" ? "Anthropic" : "OpenAI 兼容"}
                    isDefault={m.isDefault}
                  />
                ))}
              </>
            )}
          </div>
        </Section>

        <Section title="朗读">
          <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
            <span className="min-w-0">
              <span className="block text-sm">完成后自动朗读</span>
              <span className="block text-[11px] text-muted-foreground">
                单次翻译或会话最新一轮完成时自动朗读译文；音色与语速在朗读按钮旁设置
              </span>
            </span>
            <Switch checked={autoRead} onCheckedChange={setAutoRead} aria-label="完成后自动朗读" />
          </label>
        </Section>
      </PopoverContent>
    </Popover>
  );
}

function ModelRow({
  active,
  onClick,
  title,
  subtitle,
  isDefault,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  subtitle: string;
  isDefault?: boolean;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left text-sm transition-colors",
        active ? "border-brand/40 bg-brand-soft" : "hover:bg-muted",
      )}
    >
      <CpuIcon className={cn("size-4 shrink-0", active ? "text-brand" : "text-muted-foreground")} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 truncate">
          {title}
          {isDefault && <StarIcon className="size-3 fill-warning text-warning" />}
        </span>
        <span className="block text-[11px] text-muted-foreground">{subtitle}</span>
      </span>
      {active && <CheckIcon className="size-4 text-brand" />}
    </button>
  );
}
