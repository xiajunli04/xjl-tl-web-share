"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 非安全上下文的降级方案
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

/** 复制按钮：成功后图标切换为对勾 1.5 秒 */
export function CopyButton({
  text,
  label,
  className,
  size = "icon-sm",
  variant = "ghost",
  toastMessage = "已复制",
}: {
  text: string;
  label?: string;
  className?: string;
  size?: "icon-sm" | "icon-xs" | "sm" | "xs";
  variant?: "ghost" | "outline";
  toastMessage?: string | null;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={cn(className)}
      aria-label={label ?? "复制"}
      onClick={async (e) => {
        e.stopPropagation();
        if (await copyText(text)) {
          setCopied(true);
          if (toastMessage) toast.success(toastMessage);
        }
      }}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={copied ? "ok" : "copy"}
          className="inline-flex"
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.6 }}
          transition={{ duration: 0.15 }}
        >
          {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
        </motion.span>
      </AnimatePresence>
      {label && size !== "icon-sm" && size !== "icon-xs" && <span>{label}</span>}
    </Button>
  );
}
