"use client";

import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowRightIcon,
  MessageCircleQuestionIcon,
  MessageSquarePlusIcon,
  MessagesSquareIcon,
  MoreHorizontalIcon,
  PanelLeftCloseIcon,
  PencilLineIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/feedback/confirm-dialog";
import { ErrorState } from "@/components/feedback/error-state";
import { DURATION, EASE_OUT } from "@/components/motion/tokens";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useSessionList, useSessionMutations } from "@/hooks/use-sessions";
import type { SessionSummaryVO } from "@/lib/api/sessions";
import { toastError } from "@/lib/errors";
import { langName } from "@/lib/languages";
import { groupSessions } from "@/lib/session-thread";
import { cn } from "@/lib/utils";

export const SESSION_DRAWER_WIDTH = 272;

function timeLabel(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function SessionItem({
  s,
  active,
  disabled,
  onOpen,
  onRename,
  onDelete,
}: {
  s: SessionSummaryVO;
  active: boolean;
  disabled?: boolean;
  onOpen: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(s.title);
  const commit = () => {
    const t = title.trim();
    setEditing(false);
    if (t && t !== s.title) onRename(t.slice(0, 60));
    else setTitle(s.title);
  };
  return (
    <div
      className={cn(
        "group relative flex items-center gap-1 rounded-lg px-2 py-1.5 transition-colors",
        active ? "text-foreground" : "text-foreground/80 hover:bg-muted/70",
      )}
    >
      {active && (
        <motion.span
          layoutId="session-active"
          className="absolute inset-0 rounded-lg bg-background shadow-card ring-1 ring-foreground/5 dark:bg-input/50"
          transition={{ type: "spring", stiffness: 500, damping: 40 }}
        />
      )}
      {editing ? (
        <Input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setTitle(s.title);
              setEditing(false);
            }
          }}
          aria-label="会话标题"
          className="relative h-7 text-sm"
        />
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={onOpen}
          onDoubleClick={() => setEditing(true)}
          className="relative min-w-0 flex-1 text-left outline-none disabled:cursor-not-allowed"
          aria-current={active ? "true" : undefined}
        >
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{s.title || "新会话"}</span>
            {s.hasPending && (
              <MessageCircleQuestionIcon className="size-3.5 shrink-0 text-warning" aria-label="有待回答的追问" />
            )}
          </span>
          <span className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
            {langName(s.sourceLang)}
            <ArrowRightIcon className="size-2.5" />
            {langName(s.targetLang)}
            <span>· {s.turnCount} 轮</span>
            <span className="ml-auto tabular-nums">{timeLabel(s.updatedAt)}</span>
          </span>
        </button>
      )}
      {!editing && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="会话操作"
                className="relative shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
              />
            }
          >
            <MoreHorizontalIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-36">
            <DropdownMenuItem onClick={() => setEditing(true)}>
              <PencilLineIcon />
              重命名
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Trash2Icon />
              删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

/** 会话列表内容：新建、搜索、按时间分组、重命名、删除；新增项高度展开，删除项高度收起 */
export function SessionDrawerBody({
  activeId,
  busy,
  onOpen,
  onNew,
  onDeleted,
  onClose,
}: {
  activeId: number | null;
  /** 翻译进行中时禁止切换会话 */
  busy?: boolean;
  onOpen: (s: SessionSummaryVO) => void;
  onNew: () => void;
  onDeleted: (id: number) => void;
  onClose?: () => void;
}) {
  const reduce = useReducedMotion();
  const [keyword, setKeyword] = useState("");
  const kw = useDebouncedValue(keyword.trim(), 300);
  const list = useSessionList(kw);
  const { update, remove } = useSessionMutations();
  const [toDelete, setToDelete] = useState<SessionSummaryVO | null>(null);
  const records = list.data?.records ?? [];
  const groups = groupSessions(records);
  // 首次渲染不播放展开动画，之后新增的项才展开
  const [mounted, setMounted] = useState(false);
  if (!mounted && list.data) setMounted(true);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <span className="flex size-7 items-center justify-center rounded-lg bg-brand-soft text-brand">
          <MessagesSquareIcon className="size-4" />
        </span>
        <span className="flex-1 text-sm font-semibold">会话</span>
        <Button size="xs" onClick={onNew} disabled={busy}>
          <MessageSquarePlusIcon />
          新建
        </Button>
        {onClose && (
          <Button variant="ghost" size="icon-sm" aria-label="收起会话列表" onClick={onClose}>
            <PanelLeftCloseIcon />
          </Button>
        )}
      </div>
      <div className="px-3 pt-3">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索会话标题"
            aria-label="搜索会话"
            className="h-8 pl-8 text-sm"
          />
        </div>
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {list.isLoading ? (
          <div className="space-y-2 px-1" aria-busy="true">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="space-y-1.5 rounded-lg px-2 py-1.5">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            ))}
          </div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} retrying={list.isFetching} />
        ) : !records.length ? (
          <div className="px-3 py-10 text-center">
            <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <MessagesSquareIcon className="size-5" />
            </div>
            <p className="text-sm font-medium">{kw ? "没有匹配的会话" : "还没有会话"}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {kw ? "换个关键词试试。" : "新建会话后连续翻译，Agent 会记住前文的指代与专名。"}
            </p>
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.key} className="mb-3 last:mb-0">
              <div className="px-2 pb-1 text-[11px] font-medium text-muted-foreground">{g.label}</div>
              <AnimatePresence initial={false}>
                {g.items.map((s) => (
                  <motion.div
                    key={s.id}
                    initial={mounted && !reduce ? { height: 0, opacity: 0 } : false}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
                    transition={{ duration: DURATION.page, ease: EASE_OUT }}
                    className="overflow-hidden"
                  >
                    <SessionItem
                      s={s}
                      active={s.id === activeId}
                      disabled={busy && s.id !== activeId}
                      onOpen={() => onOpen(s)}
                      onRename={(title) =>
                        update.mutate(
                          { id: s.id, body: { title } },
                          { onSuccess: () => toast.success("已重命名"), onError: toastError },
                        )
                      }
                      onDelete={() => setToDelete(s)}
                    />
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          ))
        )}
      </div>
      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="删除会话"
        description={`「${toDelete?.title ?? ""}」将从会话列表中移除，其中的 ${toDelete?.turnCount ?? 0} 轮翻译仍保留在翻译历史中。`}
        confirmText="删除"
        pending={remove.isPending}
        onConfirm={() =>
          toDelete &&
          remove.mutate(toDelete.id, {
            onSuccess: () => {
              toast.success("会话已删除");
              onDeleted(toDelete.id);
              setToDelete(null);
            },
            onError: toastError,
          })
        }
      />
    </div>
  );
}

/** 宽屏下的会话抽屉：从左侧滑入 + 淡入（250ms） */
export function SessionDrawer({ open, children }: { open: boolean; children: React.ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.aside
          key="drawer"
          initial={{ width: 0, opacity: 0, x: reduce ? 0 : -16 }}
          animate={{ width: SESSION_DRAWER_WIDTH, opacity: 1, x: 0 }}
          exit={{ width: 0, opacity: 0, x: reduce ? 0 : -16 }}
          transition={{ duration: reduce ? DURATION.fast : 0.25, ease: EASE_OUT }}
          className="shrink-0 overflow-hidden border-r bg-surface"
          aria-label="会话列表"
        >
          <div className="h-full" style={{ width: SESSION_DRAWER_WIDTH }}>
            {children}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
