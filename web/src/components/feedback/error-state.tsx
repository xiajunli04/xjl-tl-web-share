"use client";

import { AlertTriangleIcon, RotateCwIcon } from "lucide-react";
import { FadeIn } from "@/components/motion/fade-in";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/http";
import { describeError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { CopyButton } from "./copy-button";

/** 从任意错误中提取展示所需的错误码、文案与 traceId */
export function errorInfo(error: unknown): { code?: string; message: string; traceId?: string } {
  if (error instanceof ApiError) {
    // describeError 会把 traceId 拼进文案，这里单独展示，所以用原始 message（含字段错误）
    const message = describeError(new ApiError(error.code, error.message, undefined, error.httpStatus, error.data));
    return { code: error.code, message, traceId: error.traceId };
  }
  return { message: error instanceof Error ? error.message : "未知错误" };
}

/** 错误状态：错误码 + 可复制的 traceId + 重试 */
export function ErrorState({
  error,
  title = "加载失败",
  onRetry,
  retrying,
  className,
  compact,
}: {
  error: unknown;
  title?: string;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
  compact?: boolean;
}) {
  const { code, message, traceId } = errorInfo(error);
  return (
    <FadeIn
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center px-6 text-center",
        compact ? "py-6" : "py-12",
        className,
      )}
    >
      <div className="mb-4 flex size-11 items-center justify-center rounded-2xl bg-danger-soft text-danger ring-1 ring-danger/20">
        <AlertTriangleIcon className="size-5" />
      </div>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1.5 max-w-md text-sm break-words text-muted-foreground">{message}</p>
      {(code || traceId) && (
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-xs">
          {code && (
            <span className="rounded-md bg-muted px-2 py-0.5 font-mono text-muted-foreground">
              {code}
            </span>
          )}
          {traceId && (
            <span className="inline-flex items-center gap-1 rounded-md border bg-card py-0.5 pr-0.5 pl-2 font-mono text-muted-foreground">
              traceId: {traceId}
              <CopyButton text={traceId} size="icon-xs" label="复制 traceId" toastMessage="traceId 已复制" />
            </span>
          )}
        </div>
      )}
      {onRetry && (
        <Button variant="outline" size="sm" className="mt-5" onClick={onRetry} disabled={retrying}>
          <RotateCwIcon className={cn(retrying && "animate-spin")} />
          重试
        </Button>
      )}
    </FadeIn>
  );
}
