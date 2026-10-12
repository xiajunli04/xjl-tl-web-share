"use client";

import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { EraserIcon, Loader2Icon, SendHorizontalIcon, SquareIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DURATION } from "@/components/motion/tokens";
import { FALLBACK_LANGUAGES, langName } from "@/lib/languages";
import { cn } from "@/lib/utils";
import { useWorkbenchStore } from "@/stores/workbench";
import { SpeakButton } from "./speak-button";
import { SpeechInputButton } from "./speech-input-button";

export const MAX_CHARS = 5000;

/** 听写结果：追加到原文末尾，并把源语言设为识别出的语种（yue 视为中文） */
export function appendSpeech(text: string, t: string, detected: string, onChange: (t: string) => void) {
  const base = text.replace(/\s+$/, "");
  onChange(base ? `${base}\n${t}` : t);
  const code = detected === "yue" ? "zh" : detected;
  if (FALLBACK_LANGUAGES.some((l) => l.code === code)) {
    useWorkbenchStore.getState().patch({ sourceLang: code });
    toast.success(`已识别为${langName(code)}`, { description: "源语言已自动切换" });
  }
}

/** 原文编辑区：字数统计、清空、语音输入、朗读、Ctrl+Enter 翻译 / 运行中停止 */
export function SourcePanel({
  text,
  lang,
  onChange,
  onTranslate,
  onStop,
  running,
  className,
  placeholder = "输入或粘贴要翻译的文本…",
  actionLabel = "翻译",
}: {
  /** 当前生效的源语言（自动识别的结果），用于朗读 */
  lang?: string;
  className?: string;
  placeholder?: string;
  /** 主按钮文字（会话模式为"发送"） */
  actionLabel?: string;
  text: string;
  onChange: (t: string) => void;
  onTranslate: () => void;
  onStop: () => void;
  running: boolean;
}) {
  const count = Array.from(text).length;
  const over = count > MAX_CHARS;
  const empty = !text.trim();
  const sourceLang = useWorkbenchStore((s) => s.sourceLang);

  const onSpeech = (t: string, detected: string) => appendSpeech(text, t, detected, onChange);

  return (
    <div className={cn("@container flex min-h-72 flex-col lg:min-h-0", className)}>
      <div className="flex h-11 shrink-0 items-center justify-between px-5">
        <span className="text-xs font-medium tracking-wide text-muted-foreground">原文</span>
        <AnimatePresence>
          {!empty && !running && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button variant="ghost" size="icon-sm" aria-label="清空原文" onClick={() => onChange("")} />
                  }
                >
                  <EraserIcon />
                </TooltipTrigger>
                <TooltipContent>清空</TooltipContent>
              </Tooltip>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <textarea
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            if (!running) onTranslate();
          }
        }}
        placeholder={placeholder}
        aria-label="原文"
        spellCheck={false}
        className="scrollbar-thin min-h-0 w-full flex-1 resize-none bg-transparent px-5 pb-4 text-[15px] leading-7 outline-none placeholder:text-muted-foreground/60"
      />
      <AnimatePresence>
        {over && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: DURATION.page }}
            className="overflow-hidden"
          >
            <div className="mx-5 mb-3 flex items-center gap-2 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">
              <TriangleAlertIcon className="size-3.5 shrink-0" />
              原文超过 {MAX_CHARS} 字符。长文本请使用文档翻译（即将推出）。
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="flex h-14 shrink-0 items-center gap-3 border-t px-4">
        <div className="flex items-center gap-0.5">
          <SpeechInputButton lang={sourceLang} onResult={onSpeech} disabled={running} />
          <SpeakButton text={text} lang={lang ?? (sourceLang !== "auto" ? sourceLang : undefined)} label="朗读原文" />
        </div>
        <span className={cn("text-xs whitespace-nowrap tabular-nums text-muted-foreground", over && "font-medium text-danger")}>
          {count.toLocaleString()} / {MAX_CHARS.toLocaleString()}
        </span>
        <span className="ml-auto hidden items-center gap-1 text-[11px] whitespace-nowrap text-muted-foreground @lg:flex">
          <kbd className="rounded border bg-muted px-1.5 font-mono">Ctrl</kbd>
          <kbd className="rounded border bg-muted px-1.5 font-mono">Enter</kbd>
          翻译
        </span>
        <span className="flex-1 @lg:hidden" aria-hidden />
        <AnimatePresence mode="popLayout" initial={false}>
          {running ? (
            <motion.div
              key="stop"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
            >
              <Button variant="destructive" className="h-9 min-w-24 gap-2" onClick={onStop}>
                <SquareIcon className="size-3.5 fill-current" />
                停止
                <Loader2Icon className="size-3.5 animate-spin opacity-60" />
              </Button>
            </motion.div>
          ) : (
            <motion.div
              key="go"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
            >
              <Button className="h-9 min-w-24 gap-2" disabled={empty || over} onClick={onTranslate}>
                {actionLabel}
                <SendHorizontalIcon className="size-3.5" />
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
