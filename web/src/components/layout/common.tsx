"use client";

import * as React from "react";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

export { ConfirmDialog } from "@/components/feedback/confirm-dialog";

/** 常规页面容器：限制宽度并提供统一内边距 */
export function PageContainer({
  children,
  className,
  wide,
}: {
  children: React.ReactNode;
  className?: string;
  wide?: boolean;
}) {
  return (
    <div className={cn("mx-auto flex w-full flex-1 flex-col px-4 py-6 md:px-8", wide ? "max-w-360" : "max-w-6xl", className)}>
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  icon: Icon,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
      <div className="flex min-w-0 items-center gap-3">
        {Icon && (
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border bg-card text-brand shadow-card">
            <Icon className="size-5" />
          </span>
        )}
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Field({
  label,
  error,
  htmlFor,
  children,
  hint,
}: {
  label: string;
  error?: string;
  htmlFor?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? (
        <motion.p
          initial={{ opacity: 0, y: -2 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-xs text-destructive"
        >
          {error}
        </motion.p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

export const NativeSelect = React.forwardRef<HTMLSelectElement, React.ComponentProps<"select">>(
  function NativeSelect({ className, ...props }, ref) {
    return (
      <select
        ref={ref}
        className={cn(
          "h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30",
          className,
        )}
        {...props}
      />
    );
  },
);

export function Pagination({
  pageNum,
  pageSize,
  total,
  onChange,
  className,
}: {
  pageNum: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
  className?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className={cn("flex items-center justify-between gap-3 text-sm text-muted-foreground", className)}>
      <span>
        共 <span className="font-medium text-foreground tabular-nums">{total}</span> 条
      </span>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="上一页"
          disabled={pageNum <= 1}
          onClick={() => onChange(pageNum - 1)}
        >
          <ChevronLeftIcon />
        </Button>
        <span className="min-w-14 text-center tabular-nums">
          {pageNum} / {pages}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="下一页"
          disabled={pageNum >= pages}
          onClick={() => onChange(pageNum + 1)}
        >
          <ChevronRightIcon />
        </Button>
      </div>
    </div>
  );
}

export function TableMessage({ colSpan, children }: { colSpan: number; children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="p-0">
        {children}
      </td>
    </tr>
  );
}

/** 已生效筛选条件的小标签（可移除） */
export function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <motion.span
      layout
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      className="inline-flex h-7 items-center gap-1 rounded-full border bg-card pr-1 pl-2.5 text-xs text-foreground shadow-card"
    >
      {label}
      <button
        type="button"
        aria-label={`移除筛选：${label}`}
        onClick={onRemove}
        className="flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <XIcon className="size-3" />
      </button>
    </motion.span>
  );
}

/** 表面卡片（列表 / 表格容器） */
export function Surface({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("overflow-hidden rounded-xl border bg-card text-card-foreground shadow-card", className)}
      {...props}
    />
  );
}
