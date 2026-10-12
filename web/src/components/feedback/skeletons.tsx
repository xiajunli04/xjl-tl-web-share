import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** 表格骨架：与真实表格同样的行高与列数 */
export function TableSkeleton({ rows = 8, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="divide-y" aria-busy="true" aria-label="加载中">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 px-4 py-3.5">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton
              key={c}
              className={cn("h-4", c === 0 ? "w-28" : c === cols - 1 ? "ml-auto w-16" : "flex-1")}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** 卡片网格骨架 */
export function CardGridSkeleton({ count = 6, className }: { count?: number; className?: string }) {
  return (
    <div className={cn("grid gap-4 sm:grid-cols-2 xl:grid-cols-3", className)} aria-busy="true">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-xl border bg-card p-5 shadow-card">
          <div className="flex items-center gap-3">
            <Skeleton className="size-10 rounded-xl" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
          <Skeleton className="mt-5 h-3 w-full" />
          <Skeleton className="mt-2 h-3 w-4/5" />
          <div className="mt-5 flex gap-2">
            <Skeleton className="h-7 w-20" />
            <Skeleton className="h-7 w-16" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** 列表骨架（主从布局左栏、历史列表等） */
export function ListSkeleton({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-2", className)} aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="rounded-xl border bg-card p-4">
          <div className="flex items-center justify-between gap-3">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-12" />
          </div>
          <Skeleton className="mt-3 h-3 w-5/6" />
          <Skeleton className="mt-2 h-3 w-2/3" />
        </div>
      ))}
    </div>
  );
}

/** 详情 / 表单骨架 */
export function DetailSkeleton({ lines = 6 }: { lines?: number }) {
  return (
    <div className="space-y-4" aria-busy="true">
      <Skeleton className="h-6 w-1/3" />
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-4 w-full" />
        </div>
      ))}
    </div>
  );
}
