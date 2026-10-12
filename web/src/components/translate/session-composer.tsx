"use client";

import { useLayoutEffect, useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowUpIcon, SquareIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DURATION } from "@/components/motion/tokens";
import { cn } from "@/lib/utils";
import { useWorkbenchStore } from "@/stores/workbench";
import { appendSpeech, MAX_CHARS } from "./source-panel";
import { SpeakButton } from "./speak-button";
import { SpeechInputButton } from "./speech-input-button";

/** 输入框最多自动增高到的行数（之后内部滚动） */
const MAX_ROWS = 8;

/**
 * 会话模式底部输入框（聊天式）：随内容自动增高；Enter 发送、Shift+Enter 换行（输入法组字时不发送）；
 * 运行中主按钮变为停止。
 */
export function SessionComposer({
  text,
  lang,
  onChange,
  onSend,
  onStop,
  running,
  placeholder,
}: {
  text: string;
  /** 当前生效的源语言（自动识别的结果），用于朗读 */
  lang?: string;
  onChange: (t: string) => void;
  onSend: () => void;
  onStop: () => void;
  running: boolean;
  placeholder: string;
}) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLTextAreaElement>(null);
  const sourceLang = useWorkbenchStore((s) => s.sourceLang);
  const count = Array.from(text).length;
  const over = count > MAX_CHARS;
  const empty = !text.trim();

  // 自动增高：先收缩到 auto 再取 scrollHeight，超过 MAX_ROWS 行后内部滚动
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const line = parseFloat(getComputedStyle(el).lineHeight) || 24;
    el.style.height = `${Math.min(el.scrollHeight, line * MAX_ROWS + 8)}px`;
  }, [text]);

  return (
    <div className="@container shrink-0 border-t bg-card px-3 pt-2.5 pb-3 md:px-5">
      <div className="mx-auto w-full max-w-3xl">
        <AnimatePresence>
          {over && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: DURATION.page }}
              className="overflow-hidden"
            >
              <div className="mb-2 flex items-center gap-2 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">
                <TriangleAlertIcon className="size-3.5 shrink-0" />
                原文超过 {MAX_CHARS.toLocaleString()} 字符，长文本请使用文档翻译。
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <div
          className={cn(
            "rounded-2xl border bg-background shadow-card transition-[border-color,box-shadow] focus-within:border-brand/40 focus-within:ring-3 focus-within:ring-brand/10 dark:bg-input/30",
            over && "border-danger/40 focus-within:border-danger/50 focus-within:ring-danger/10",
          )}
        >
          <textarea
            ref={ref}
            rows={1}
            value={text}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
              e.preventDefault();
              if (!running && !empty && !over) onSend();
            }}
            placeholder={placeholder}
            aria-label="原文"
            spellCheck={false}
            className="scrollbar-thin block max-h-60 min-h-12 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[15px] leading-6 outline-none placeholder:text-muted-foreground/60"
          />
          <div className="flex items-center gap-1 px-2 pb-2">
            <SpeechInputButton
              lang={sourceLang}
              onResult={(t, detected) => appendSpeech(text, t, detected, onChange)}
              disabled={running}
            />
            <SpeakButton text={text} lang={lang ?? (sourceLang !== "auto" ? sourceLang : undefined)} label="朗读原文" />
            <AnimatePresence initial={false}>
              {count > 0 && (
                <motion.span
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className={cn("ml-1 text-[11px] tabular-nums text-muted-foreground", over && "font-medium text-danger")}
                >
                  {count.toLocaleString()} / {MAX_CHARS.toLocaleString()}
                </motion.span>
              )}
            </AnimatePresence>
            <span className="ml-auto hidden items-center gap-1 pr-1 text-[11px] whitespace-nowrap text-muted-foreground/80 @md:flex">
              <kbd className="rounded border bg-muted px-1 font-mono">Enter</kbd>发送
              <kbd className="ml-1 rounded border bg-muted px-1 font-mono">Shift</kbd>+
              <kbd className="rounded border bg-muted px-1 font-mono">Enter</kbd>换行
            </span>
            <span className="flex-1 @md:hidden" aria-hidden />
            <AnimatePresence mode="popLayout" initial={false}>
              {running ? (
                <motion.div
                  key="stop"
                  initial={{ opacity: 0, scale: reduce ? 1 : 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: reduce ? 1 : 0.8 }}
                >
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon"
                          className="size-8 rounded-full bg-foreground text-background hover:bg-foreground/85"
                          aria-label="停止"
                          onClick={onStop}
                        />
                      }
                    >
                      <SquareIcon className="size-3 fill-current" />
                    </TooltipTrigger>
                    <TooltipContent>停止本轮</TooltipContent>
                  </Tooltip>
                </motion.div>
              ) : (
                <motion.div
                  key="send"
                  initial={{ opacity: 0, scale: reduce ? 1 : 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: reduce ? 1 : 0.8 }}
                >
                  <Button
                    size="icon"
                    className="size-8 rounded-full"
                    aria-label="发送"
                    disabled={empty || over}
                    onClick={onSend}
                  >
                    <ArrowUpIcon />
                  </Button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}
