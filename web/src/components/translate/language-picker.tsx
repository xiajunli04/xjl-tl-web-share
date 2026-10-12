"use client";

import { useMemo, useState } from "react";
import { CheckIcon, ChevronDownIcon, SearchIcon, SparklesIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { NumberTicker } from "@/components/motion/number-ticker";
import type { DetectResult, Language } from "@/lib/api/translate";
import { langName } from "@/lib/languages";
import { cn } from "@/lib/utils";

/** 语种选择器：弹层内可搜索的网格；源语言支持"自动识别"并显示识别结果与置信度 */
export function LanguagePicker({
  value,
  onChange,
  languages,
  allowAuto,
  detect,
  detecting,
  label,
}: {
  value: string;
  onChange: (code: string) => void;
  languages: Language[];
  allowAuto?: boolean;
  detect?: DetectResult | null;
  detecting?: boolean;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState("");
  const filtered = useMemo(() => {
    const k = keyword.trim().toLowerCase();
    if (!k) return languages;
    return languages.filter(
      (l) =>
        l.name.includes(k) || l.nativeName.toLowerCase().includes(k) || l.code.toLowerCase().includes(k),
    );
  }, [keyword, languages]);

  const pick = (code: string) => {
    onChange(code);
    setOpen(false);
    setKeyword("");
  };

  const isAuto = value === "auto";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={label}
            className="group inline-flex h-9 min-w-0 items-center gap-2 rounded-lg px-3 text-sm font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:bg-muted"
          />
        }
      >
        {isAuto ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <SparklesIcon className={cn("size-3.5 shrink-0 text-brand", detecting && "animate-pulse")} />
            <span className="truncate">
              自动识别
              {detect && (
                <span className="text-muted-foreground">
                  ：{langName(detect.lang, languages)}（
                  <NumberTicker value={Math.round(detect.confidence * 100)} suffix="%" />）
                </span>
              )}
            </span>
          </span>
        ) : (
          <span className="truncate">{langName(value, languages)}</span>
        )}
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-aria-expanded:rotate-180" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[360px] gap-0 p-0">
        <div className="flex items-center gap-2 border-b px-3">
          <SearchIcon className="size-4 text-muted-foreground" />
          <input
            autoFocus
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索语种（中文名 / 本族语 / 代码）"
            className="h-10 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="scrollbar-thin max-h-80 overflow-y-auto p-1.5">
          {allowAuto && !keyword && (
            <button
              type="button"
              onClick={() => pick("auto")}
              className={cn(
                "mb-1 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-muted",
                isAuto && "bg-brand-soft text-brand",
              )}
            >
              <SparklesIcon className="size-4" />
              <span className="flex-1">自动识别</span>
              {isAuto && <CheckIcon className="size-4" />}
            </button>
          )}
          <div className="grid grid-cols-2 gap-0.5">
            {filtered.map((l) => {
              const active = l.code === value;
              return (
                <button
                  key={l.code}
                  type="button"
                  onClick={() => pick(l.code)}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted",
                    active && "bg-brand-soft text-brand hover:bg-brand-soft",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{l.name}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{l.nativeName}</span>
                  </span>
                  {active && <CheckIcon className="size-4 shrink-0" />}
                </button>
              );
            })}
          </div>
          {!filtered.length && (
            <p className="py-6 text-center text-sm text-muted-foreground">没有匹配的语种</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
