"use client";

import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { CornerDownLeftIcon, Loader2Icon, MessageCircleQuestionIcon, PencilLineIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DURATION, EASE_OUT } from "@/components/motion/tokens";
import { cn } from "@/lib/utils";

export interface ClarifyPrompt {
  question: string;
  options: string[];
  span: string;
  reason?: string | null;
  /** 被追问的原文（用于高亮歧义片段） */
  source?: string | null;
}

/** 把原文切成 [前, 片段, 后]（不区分大小写，找不到时返回 null） */
export function splitSpan(source: string, span: string): [string, string, string] | null {
  if (!source || !span) return null;
  const i = source.toLowerCase().indexOf(span.toLowerCase());
  if (i === -1) return null;
  return [source.slice(0, i), source.slice(i, i + span.length), source.slice(i + span.length)];
}

const MAX_ANSWER = 200;

/** 歧义片段：出现时带一次脉冲（减少动效时静态高亮） */
function SpanMark({ text }: { text: string }) {
  const reduce = useReducedMotion();
  return (
    <mark className="relative rounded-[4px] bg-warning-soft px-0.5 font-medium text-warning ring-1 ring-warning/40">
      {text}
      {!reduce && (
        <motion.span
          aria-hidden
          className="pointer-events-none absolute -inset-0.5 rounded-[5px] ring-2 ring-warning"
          initial={{ opacity: 0.9, scale: 1 }}
          animate={{ opacity: 0, scale: 1.3 }}
          transition={{ duration: 0.9, ease: EASE_OUT, delay: 0.3 }}
        />
      )}
    </mark>
  );
}

/**
 * 追问卡片：问题、高亮的歧义片段、选项按钮与"其他…"自由输入。
 * 进场为弹簧缩放（0.96 → 1）+ 淡入；回答后由父级 AnimatePresence 做高度收起。
 */
export function ClarifyCard({
  prompt,
  pending,
  onAnswer,
}: {
  prompt: ClarifyPrompt;
  pending?: boolean;
  onAnswer: (answer: string) => void;
}) {
  const reduce = useReducedMotion();
  const [other, setOther] = useState(false);
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const parts = splitSpan(prompt.source ?? "", prompt.span);
  const options = Array.isArray(prompt.options) ? prompt.options.filter(Boolean) : [];
  const trimmed = text.trim();

  const answer = (a: string) => {
    if (pending) return;
    setPicked(a);
    onAnswer(a);
  };

  return (
    <motion.section
      role="region"
      aria-label="歧义追问"
      initial={{ opacity: 0, scale: reduce ? 1 : 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={reduce ? { duration: DURATION.fast } : { type: "spring", stiffness: 420, damping: 30 }}
      className="relative overflow-hidden rounded-xl border border-warning/35 bg-card shadow-popover"
    >
      <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-warning/70" />
      <div className="space-y-3 px-4 py-3.5 pl-5">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-warning-soft text-warning">
            <MessageCircleQuestionIcon className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-medium tracking-wide text-warning">需要你确认一处歧义</div>
            <p className="mt-0.5 text-sm leading-relaxed font-medium">{prompt.question}</p>
          </div>
        </div>

        {prompt.source && (
          <p className="rounded-lg bg-muted/50 px-3 py-2 text-sm leading-relaxed break-words">
            {parts ? (
              <>
                {parts[0]}
                <SpanMark text={parts[1]} />
                {parts[2]}
              </>
            ) : (
              prompt.source
            )}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {options.map((o) => (
            <Button
              key={o}
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => answer(o)}
              className={cn("min-w-16 hover:border-brand/40 hover:bg-brand-soft hover:text-brand", picked === o && "border-brand/50 bg-brand-soft text-brand")}
            >
              {pending && picked === o && <Loader2Icon className="animate-spin" />}
              {o}
            </Button>
          ))}
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            aria-expanded={other}
            onClick={() => setOther((v) => !v)}
            className="text-muted-foreground"
          >
            <PencilLineIcon />
            其他…
          </Button>
        </div>

        <AnimatePresence initial={false}>
          {other && (
            <motion.form
              key="other"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: DURATION.page, ease: EASE_OUT }}
              className="overflow-hidden"
              onSubmit={(e) => {
                e.preventDefault();
                if (trimmed && trimmed.length <= MAX_ANSWER) answer(trimmed);
              }}
            >
              <div className="flex items-center gap-2 pt-0.5">
                <Input
                  autoFocus
                  value={text}
                  maxLength={MAX_ANSWER}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="用一句话说明你的意思，例如：指公司的开户银行"
                  aria-label="自由回答"
                  className="h-8"
                />
                <Button type="submit" size="sm" disabled={!trimmed || pending}>
                  {pending && picked === trimmed ? <Loader2Icon className="animate-spin" /> : <CornerDownLeftIcon />}
                  回答
                </Button>
              </div>
            </motion.form>
          )}
        </AnimatePresence>

        {prompt.reason && <p className="text-[11px] text-muted-foreground">判断依据：{prompt.reason}</p>}
      </div>
    </motion.section>
  );
}
