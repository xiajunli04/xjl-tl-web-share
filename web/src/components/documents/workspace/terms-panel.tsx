"use client";

import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  BookMarkedIcon,
  CheckIcon,
  ChevronRightIcon,
  InfoIcon,
  Loader2Icon,
  PlusIcon,
  SparklesIcon,
  Trash2Icon,
  UserPenIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/feedback/empty-state";
import { ListSkeleton } from "@/components/feedback/skeletons";
import { DURATION, EASE_OUT, staggerDelay } from "@/components/motion";
import { docApi, type DocTermOrigin, type DocTermStatus, type DocTermVO } from "@/lib/api/documents";
import { groupTerms, type TermGroup } from "@/lib/doc-terms";
import { toastError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { useWorkspace } from "./context";

function OriginBadge({ origin }: { origin: DocTermOrigin }) {
  const meta = {
    glossary: { label: "术语库", icon: BookMarkedIcon, cls: "bg-info-soft text-info" },
    extracted: { label: "抽取", icon: SparklesIcon, cls: "bg-brand-soft text-brand" },
    user: { label: "手动添加", icon: UserPenIcon, cls: "bg-success-soft text-success" },
  }[origin] ?? { label: origin, icon: SparklesIcon, cls: "bg-muted text-muted-foreground" };
  const Icon = meta.icon;
  return (
    <span className={cn("inline-flex h-5 shrink-0 items-center gap-0.5 rounded px-1.5 text-[10px] font-medium whitespace-nowrap", meta.cls)}>
      <Icon className="size-2.5" />
      {meta.label}
    </span>
  );
}

interface DraftRow {
  key: string;
  id?: number;
  source: string;
  target: string;
  origin: DocTermOrigin;
  /** 本次确认中新增的行（源词可编辑、可删除） */
  isNew?: boolean;
  frequency: number;
  accepted: boolean;
}

const toDraft = (terms: DocTermVO[]): DraftRow[] =>
  terms.map((t) => ({
    key: `t${t.id}`,
    id: t.id,
    source: t.source,
    target: t.target,
    origin: t.origin,
    frequency: t.frequency,
    accepted: t.status !== "REJECTED",
  }));

/** 待确认：可编辑的候选术语表 + 批量接受/拒绝 + 底部固定「确认并继续翻译」 */
export function TermsConfirm({ terms }: { terms: DocTermVO[] }) {
  const { id, store } = useWorkspace();
  const reduce = useReducedMotion();
  const [rows, setRows] = useState<DraftRow[]>(() => toDraft(terms));
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(false);
  const [newKey, setNewKey] = useState(0);

  const patch = (key: string, p: Partial<DraftRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));
  const accepted = rows.filter((r) => r.accepted);
  const invalid = accepted.some((r) => !r.source.trim() || !r.target.trim());
  const allPicked = picked.size > 0 && picked.size === rows.length;

  const batch = (accept: boolean) => {
    setRows((rs) => rs.map((r) => (picked.has(r.key) ? { ...r, accepted: accept } : r)));
    setPicked(new Set());
  };

  const add = () => {
    const key = `n${newKey}`;
    setNewKey((k) => k + 1);
    setRows((rs) => [{ key, source: "", target: "", origin: "user", isNew: true, frequency: 0, accepted: true }, ...rs]);
  };

  const submit = async () => {
    setPending(true);
    try {
      const payload = rows
        .filter((r) => r.source.trim() && (r.target.trim() || !r.accepted))
        .map((r) => ({
          id: r.id,
          source: r.source.trim(),
          target: r.target.trim(),
          status: r.accepted ? ("CONFIRMED" as const) : ("REJECTED" as const),
        }));
      const latest = await docApi.confirmTerms(id, payload);
      // 以服务端返回的最新列表为准（未列出的待确认术语被置为 REJECTED）
      store.getState().setTerms(
        Array.isArray(latest)
          ? latest
          : payload.map((p, i) => {
              const prev = rows.find((r) => r.id !== undefined && r.id === p.id);
              return {
                id: p.id ?? -(i + 1),
                source: p.source,
                target: p.target,
                origin: prev?.origin ?? "user",
                frequency: prev?.frequency ?? 0,
                status: p.status,
              };
            }),
      );
      toast.success(`已确认 ${payload.filter((p) => p.status === "CONFIRMED").length} 条术语，继续翻译`);
    } catch (e) {
      toastError(e);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 px-4 pt-3 pb-2">
        <div className="rounded-lg bg-warning-soft px-3 py-2 text-xs leading-relaxed text-warning">
          全文分析完成，已暂停等待确认。确认后的术语将作为<strong>任务术语表</strong>，在全部分块中强制使用。
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            checked={allPicked}
            indeterminate={picked.size > 0 && !allPicked}
            onCheckedChange={(v) => setPicked(v ? new Set(rows.map((r) => r.key)) : new Set())}
            aria-label="全选"
          />
          <AnimatePresence mode="wait" initial={false}>
            {picked.size > 0 ? (
              <motion.div
                key="batch"
                initial={{ opacity: 0, x: reduce ? 0 : -4 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
                className="flex items-center gap-1.5"
              >
                <span className="text-xs text-muted-foreground">已选 {picked.size}</span>
                <Button variant="outline" size="xs" onClick={() => batch(true)}>
                  <CheckIcon />
                  接受
                </Button>
                <Button variant="outline" size="xs" onClick={() => batch(false)}>
                  <XIcon />
                  拒绝
                </Button>
              </motion.div>
            ) : (
              <motion.span key="count" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-xs text-muted-foreground">
                {rows.length} 条候选 · 按频次排序
              </motion.span>
            )}
          </AnimatePresence>
          <Button variant="ghost" size="xs" className="ml-auto text-brand" onClick={add}>
            <PlusIcon />
            新增术语
          </Button>
        </div>
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 pb-3">
        <ul className="space-y-1.5">
          <AnimatePresence initial={false}>
            {rows.map((r, i) => (
              <motion.li
                key={r.key}
                layout={!reduce}
                initial={{ opacity: 0, x: reduce ? 0 : 10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: DURATION.page, ease: EASE_OUT, delay: r.isNew ? 0 : staggerDelay(i) }}
                className={cn(
                  "rounded-lg border bg-card p-2 transition-colors",
                  !r.accepted && "bg-muted/40",
                  picked.has(r.key) && "border-brand/40 ring-1 ring-brand/20",
                )}
              >
                <div className="flex items-center gap-2">
                  <Checkbox
                    checked={picked.has(r.key)}
                    onCheckedChange={(v) =>
                      setPicked((s) => {
                        const n = new Set(s);
                        if (v) n.add(r.key);
                        else n.delete(r.key);
                        return n;
                      })
                    }
                    aria-label={`选择 ${r.source || "新术语"}`}
                  />
                  {r.isNew ? (
                    <Input
                      autoFocus
                      value={r.source}
                      onChange={(e) => patch(r.key, { source: e.target.value })}
                      placeholder="源词"
                      aria-label="源词"
                      className="h-7 flex-1 text-sm"
                    />
                  ) : (
                    <span className={cn("min-w-0 flex-1 truncate text-sm font-medium", !r.accepted && "text-muted-foreground line-through")}>
                      {r.source}
                    </span>
                  )}
                  <OriginBadge origin={r.origin} />
                  {!r.isNew && (
                    <span className="w-8 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums" title="出现次数">
                      ×{r.frequency}
                    </span>
                  )}
                  <div className="flex shrink-0 rounded-md bg-muted p-0.5" role="radiogroup" aria-label="接受或拒绝">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={r.accepted}
                      aria-label="接受"
                      onClick={() => patch(r.key, { accepted: true })}
                      className={cn(
                        "flex size-6 items-center justify-center rounded transition-colors",
                        r.accepted ? "bg-success text-success-foreground shadow-card" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <CheckIcon className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={!r.accepted}
                      aria-label="拒绝"
                      onClick={() => patch(r.key, { accepted: false })}
                      className={cn(
                        "flex size-6 items-center justify-center rounded transition-colors",
                        !r.accepted ? "bg-danger text-danger-foreground shadow-card" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <XIcon className="size-3.5" />
                    </button>
                  </div>
                  {r.isNew && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="删除新增术语"
                      onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                    >
                      <Trash2Icon />
                    </Button>
                  )}
                </div>
                <div className="mt-1.5 flex items-center gap-2 pl-6">
                  <span className="text-[11px] text-muted-foreground">译为</span>
                  <Input
                    value={r.target}
                    onChange={(e) => patch(r.key, { target: e.target.value })}
                    disabled={!r.accepted}
                    placeholder="建议译法"
                    aria-label={`${r.source || "新术语"} 的译法`}
                    aria-invalid={r.accepted && !r.target.trim() ? true : undefined}
                    className="h-7 flex-1 text-sm"
                  />
                </div>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      </div>

      <div className="shrink-0 border-t bg-surface/95 px-4 py-3 backdrop-blur">
        <div className="mb-2 flex items-center gap-3 text-[11px] text-muted-foreground tabular-nums">
          <span className="inline-flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-success" />
            接受 {accepted.length}
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-danger" />
            拒绝 {rows.length - accepted.length}
          </span>
          {invalid && <span className="ml-auto text-danger">有已接受的术语缺少译法</span>}
        </div>
        <Button className="w-full" size="lg" onClick={submit} disabled={pending || invalid}>
          {pending ? <Loader2Icon className="animate-spin" /> : <CheckIcon />}
          确认并继续翻译
        </Button>
      </div>
    </div>
  );
}

const STATUS_STYLE: Record<DocTermStatus, { label: string; cls: string; tip: string }> = {
  CONFIRMED: { label: "强制", cls: "bg-success-soft text-success", tip: "已确认或来自术语库，翻译时必须使用" },
  AUTO: { label: "参考", cls: "bg-info-soft text-info ring-1 ring-info/25", tip: "未经确认，仅供模型参考，不强制" },
  REJECTED: { label: "已拒绝", cls: "bg-muted text-muted-foreground", tip: "已拒绝，不参与翻译" },
  PENDING: { label: "候选", cls: "bg-warning-soft text-warning", tip: "尚未确认的候选术语" },
};

function StatusChip({ status }: { status: string }) {
  const meta = STATUS_STYLE[status as DocTermStatus] ?? { label: status, cls: "bg-muted text-muted-foreground", tip: status };
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span tabIndex={0} />}
        className={cn("inline-flex h-5 shrink-0 cursor-help items-center gap-0.5 rounded px-1.5 text-[10px] font-medium whitespace-nowrap", meta.cls)}
      >
        {status === "AUTO" && <InfoIcon className="size-2.5" />}
        {meta.label}
      </TooltipTrigger>
      <TooltipContent>{meta.tip}</TooltipContent>
    </Tooltip>
  );
}

/** 组内列表项依次淡入的间隔（design.md 动效清单：30ms），超过 20 项不再递增 */
const TERM_STAGGER = 0.03;

/** 一个状态分组：吸顶标题 + 可折叠列表，展开时列表项依次淡入 */
function TermGroupSection({ group }: { group: TermGroup }) {
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(group.defaultOpen);
  const muted = group.key === "rejected";
  return (
    <section aria-label={group.label}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="sticky top-0 z-10 flex w-full items-center gap-2 border-b bg-surface/95 px-4 py-2 text-left text-xs backdrop-blur transition-colors hover:bg-muted/60"
      >
        <ChevronRightIcon className={cn("size-3.5 text-muted-foreground transition-transform duration-200", open && "rotate-90")} />
        <span className={cn("font-medium", muted && "text-muted-foreground")}>{group.label}</span>
        <span className="rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground tabular-nums">{group.terms.length}</span>
        <span className={cn("ml-auto text-[11px]", group.key === "auto" ? "text-info" : "text-muted-foreground")}>{group.hint}</span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="list"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: DURATION.page, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            {group.key === "auto" && (
              <p className="mx-4 mt-2 rounded-lg bg-info-soft px-2.5 py-1.5 text-[11px] leading-relaxed text-info">
                未开启人工确认时自动采用的抽取术语，只作为参考译法提供给模型，可按领域惯例调整，不强制、不计入术语遵循。
              </p>
            )}
            <ul className="space-y-1.5 px-4 py-2">
              {group.terms.map((t, i) => (
                <motion.li
                  key={`${t.id}-${t.source}`}
                  initial={{ opacity: 0, y: reduce ? 0 : 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: DURATION.page, ease: EASE_OUT, delay: Math.min(i, 20) * TERM_STAGGER }}
                  className={cn(
                    "flex items-center gap-2 rounded-lg border bg-card px-2.5 py-2",
                    muted && "opacity-60",
                    t.status === "AUTO" && "border-dashed",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className={cn("truncate text-sm font-medium", muted && "line-through")}>{t.source}</div>
                    <div className={cn("truncate text-xs", t.status === "AUTO" ? "text-info" : "text-brand")}>{t.target}</div>
                  </div>
                  <OriginBadge origin={t.origin} />
                  <span className="w-8 text-right text-[11px] text-muted-foreground tabular-nums">×{t.frequency}</span>
                  <StatusChip status={t.status} />
                </motion.li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

/** 非待确认状态：按状态分组的只读术语表 */
export function TermsReadonly({ terms, loading, preAnalysis }: { terms: DocTermVO[] | null; loading: boolean; preAnalysis: boolean }) {
  if (preAnalysis) {
    return (
      <EmptyState
        compact
        icon={SparklesIcon}
        title="尚未生成候选术语"
        description="全文分析完成后，Agent 会合并术语库命中与抽取结果，形成任务术语表。"
      />
    );
  }
  if (!terms) return loading ? <ListSkeleton rows={4} className="px-4 py-3" /> : null;
  if (!terms.length) {
    return <EmptyState compact icon={BookMarkedIcon} title="没有任务术语" description="未命中术语库，也未抽取到需要统一的术语。" />;
  }
  return (
    <div className="pb-2">
      {groupTerms(terms).map((g) => (
        <TermGroupSection key={g.key} group={g} />
      ))}
    </div>
  );
}
