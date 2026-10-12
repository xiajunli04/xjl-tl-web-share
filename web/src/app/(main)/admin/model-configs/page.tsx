"use client";

import { useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  AlertTriangleIcon,
  ChevronDownIcon,
  CpuIcon,
  ImageIcon,
  KeyRoundIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  PlugZapIcon,
  PlusIcon,
  ScanSearchIcon,
  StarIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ConfirmDialog, PageContainer, PageHeader, Pagination } from "@/components/layout/common";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorState } from "@/components/feedback/error-state";
import { CardGridSkeleton } from "@/components/feedback/skeletons";
import { StaggerItem, StaggerList } from "@/components/motion/stagger";
import { DURATION, EASE_OUT, SPRING_LAYOUT } from "@/components/motion/tokens";
import { SearchInput } from "@/components/admin/search-input";
import { ModelConfigForm } from "@/components/admin/model-config-form";
import { CapabilityIcon, ProviderIcon } from "@/components/admin/model-config-icons";
import { modelConfigApi } from "@/lib/api/model-configs";
import type { ModelCapability, ModelConfigVO, ModelTestResult } from "@/lib/api/types";
import { toastError } from "@/lib/errors";
import {
  CAPABILITY_DESC,
  CAPABILITY_LABEL,
  PROVIDER_LABEL,
  TEST_REPLY_LABEL,
  capabilityOf,
  groupByCapability,
} from "@/lib/model-capability";
import { reviewNoticeOf, type ReviewNotice } from "@/lib/review-model";
import { formatTime } from "@/lib/validators";
import { cn } from "@/lib/utils";

type TestState = { testing: true } | { testing: false; result: ModelTestResult };

/** 连通性测试结果：成功打勾 / 失败抖动（减少动效时不抖动）；摘要标签随能力变化 */
function TestPanel({
  state,
  capability,
  onDismiss,
}: {
  state: TestState;
  capability: ModelCapability;
  onDismiss: () => void;
}) {
  const reduce = useReducedMotion();
  if (state.testing) {
    return (
      <div className="relative overflow-hidden rounded-lg border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
        <span className="absolute inset-0 -translate-x-full animate-shimmer bg-linear-to-r from-transparent via-brand/10 to-transparent motion-reduce:hidden" />
        <span className="relative inline-flex items-center gap-2">
          <Loader2Icon className="size-3.5 animate-spin" />
          正在测试{CAPABILITY_LABEL[capability]}连通性…
        </span>
      </div>
    );
  }
  const r = state.result;
  const errorText = r.errorCode === "C0121" ? "API Key 无效" : r.errorMessage || "连接失败";
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={r.ok || reduce ? { opacity: 1 } : { opacity: 1, x: [0, -6, 6, -4, 4, 0] }}
      transition={{ duration: 0.4, ease: EASE_OUT }}
      className={cn(
        "relative rounded-lg border px-3 py-2.5 pr-8 text-xs",
        r.ok ? "border-success/30 bg-success-soft" : "border-danger/30 bg-danger-soft",
      )}
    >
      <button
        type="button"
        aria-label="关闭测试结果"
        onClick={onDismiss}
        className="absolute top-2 right-2 rounded p-0.5 text-muted-foreground hover:text-foreground"
      >
        <XIcon className="size-3.5" />
      </button>
      <div className={cn("flex items-center gap-1.5 font-medium", r.ok ? "text-success" : "text-danger")}>
        {r.ok ? (
          <svg viewBox="0 0 24 24" className="size-3.5" fill="none" aria-hidden>
            <motion.path
              d="M5 12.5l4.2 4.2L19 7"
              stroke="currentColor"
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={{ pathLength: reduce ? 1 : 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 0.35 }}
            />
          </svg>
        ) : (
          <AlertTriangleIcon className="size-3.5" />
        )}
        {r.ok ? "连接成功" : errorText}
        <span className="ml-auto font-normal text-muted-foreground tabular-nums">{r.latencyMs} ms</span>
      </div>
      <div className="mt-1 space-y-0.5 text-muted-foreground">
        {r.ok ? (
          <>
            <div className="truncate">
              {TEST_REPLY_LABEL[capability]}：{(r.reply ?? "").slice(0, 80) || "（空）"}
            </div>
            {r.usage && (
              <div>
                Token：输入 {r.usage.promptTokens} / 输出 {r.usage.completionTokens}
              </div>
            )}
          </>
        ) : (
          <div className="break-all">
            <span className="font-mono">{r.errorCode ?? "-"}</span> · {r.errorMessage ?? "-"}
          </div>
        )}
      </div>
    </motion.div>
  );
}

function ModelCard({
  m,
  index,
  test,
  onTest,
  onDismissTest,
  onEdit,
  onDelete,
  onDefault,
  onReview,
  onEnabled,
  busy,
}: {
  m: ModelConfigVO;
  index: number;
  test?: TestState;
  onTest: () => void;
  onDismissTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onDefault: () => void;
  /** 打开设为 / 取消评审模型的确认弹窗（只对 CHAT 能力显示） */
  onReview: () => void;
  onEnabled: (v: boolean) => void;
  busy: boolean;
}) {
  const reduce = useReducedMotion();
  const capability = capabilityOf(m);
  const chat = capability === "CHAT";
  return (
    <StaggerItem
      index={index}
      className={cn(
        "group @container flex min-w-0 flex-col rounded-xl border bg-card p-4 shadow-card transition-shadow hover:shadow-popover sm:p-5",
        m.isDefault && "ring-1 ring-brand/30",
        !m.enabled && "bg-muted/30",
      )}
    >
      <div className="flex items-start gap-3">
        <ProviderIcon provider={m.provider} className={cn(!m.enabled && "opacity-60")} />
        <div className="min-w-0 flex-1">
          {/* 名称优先完整显示，空间不足时徽标换行 */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="max-w-full truncate font-semibold" title={m.name}>{m.name}</span>
            {m.isDefault && (
              <motion.span
                layout
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                title={`${CAPABILITY_LABEL[capability]}能力的默认配置`}
                className="inline-flex shrink-0 items-center gap-1 rounded-full bg-brand-gradient px-2 py-0.5 text-[11px] font-medium text-brand-foreground"
              >
                <StarIcon className="size-3 fill-current" />
                默认
              </motion.span>
            )}
            {chat && m.supportsVision && (
              <span
                title="支持图片输入，可作为图片翻译的视觉 OCR 模型"
                className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-medium text-success ring-1 ring-success/25"
              >
                <ImageIcon className="size-3" />
                支持图片
              </span>
            )}
            {/* 评审徽标：全局唯一，跨卡片切换时通过 layoutId 从旧卡片滑到新卡片 */}
            <AnimatePresence initial={false}>
              {chat && m.isReviewDefault && (
                <motion.span
                  key="review"
                  layoutId="model-review-badge"
                  initial={{ opacity: 0, scale: reduce ? 1 : 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: reduce ? 1 : 0.8 }}
                  transition={{ duration: DURATION.fast, ease: EASE_OUT, layout: SPRING_LAYOUT }}
                  title="评审模型：开启「评审修正」时负责评审打分"
                  className="inline-flex shrink-0 items-center gap-1 rounded-full bg-info-soft px-2 py-0.5 text-[11px] font-medium text-info ring-1 ring-info/25"
                >
                  <ScanSearchIcon className="size-3" />
                  评审
                </motion.span>
              )}
            </AnimatePresence>
          </div>
          <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{m.modelName}</div>
        </div>
        <Tooltip>
          <TooltipTrigger render={<span className="mt-1 flex items-center gap-2" />}>
            <span
              className={cn(
                "size-2 rounded-full transition-colors duration-300",
                m.enabled ? "animate-breathe bg-success text-success" : "bg-muted-foreground/40",
              )}
            />
            <Switch checked={m.enabled} disabled={busy} onCheckedChange={onEnabled} aria-label="启用" />
          </TooltipTrigger>
          <TooltipContent>{m.enabled ? "已启用" : "已停用"}</TooltipContent>
        </Tooltip>
      </div>

      <div className="mt-4 space-y-1.5 text-xs">
        <div className="flex items-center gap-2 text-muted-foreground">
          <PlugZapIcon className="size-3.5 shrink-0" />
          <span className="truncate" title={m.baseUrl}>
            {m.baseUrl}
          </span>
        </div>
        <div className="flex items-center gap-2 text-muted-foreground">
          <KeyRoundIcon className="size-3.5 shrink-0" />
          <span className="font-mono">{m.apiKeyMask}</span>
        </div>
        <div className="flex flex-wrap gap-1.5 pt-1">
          <span className="rounded-md bg-muted px-1.5 py-0.5 text-muted-foreground">{PROVIDER_LABEL[m.provider]?.short ?? m.provider}</span>
          {m.params?.temperature !== undefined && (
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-muted-foreground">temp {m.params.temperature}</span>
          )}
          {m.params?.maxTokens !== undefined && (
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-muted-foreground">max {m.params.maxTokens}</span>
          )}
          {m.params?.timeoutSeconds !== undefined && (
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-muted-foreground">超时 {m.params.timeoutSeconds}s</span>
          )}
          {Object.entries(m.params?.extra ?? {}).map(([k, v]) => (
            <span key={k} className="rounded-md bg-brand-soft/60 px-1.5 py-0.5 font-mono text-brand" title="额外参数">
              {k}={v}
            </span>
          ))}
        </div>
        {m.remark && <p className="pt-1 text-muted-foreground">{m.remark}</p>}
      </div>

      <AnimatePresence initial={false}>
        {test && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            <div className="pt-4">
              <TestPanel state={test} capability={capability} onDismiss={onDismissTest} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex-1" />
      <div className="mt-4 flex items-center gap-1.5 border-t pt-4">
        <Button variant="outline" size="sm" disabled={test?.testing} onClick={onTest}>
          <PlugZapIcon />
          测试连通性
        </Button>
        <Button variant="ghost" size="sm" disabled={m.isDefault || !m.enabled || busy} onClick={onDefault}>
          <StarIcon />
          设为默认
        </Button>
        {/* 卡片较窄时隐藏更新日期，保证"更多操作"不被挤出卡片 */}
        <span className="ml-auto hidden text-[11px] whitespace-nowrap text-muted-foreground @[22rem]:inline">
          {formatTime(m.updatedAt).split(" ")[0]}
        </span>
        <span className="ml-auto @[22rem]:hidden" aria-hidden />
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="更多操作" />}>
            <MoreHorizontalIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-36">
            <DropdownMenuItem onClick={onEdit}>
              <PencilIcon />
              编辑
            </DropdownMenuItem>
            {chat && (
              <DropdownMenuItem disabled={busy || (!m.isReviewDefault && !m.enabled)} onClick={onReview}>
                <ScanSearchIcon />
                {m.isReviewDefault ? "取消评审模型" : "设为评审模型"}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Trash2Icon />
              删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </StaggerItem>
  );
}

/** 评审模型提示条：未设置评审模型，或评审模型与默认模型相同时说明影响（可关闭） */
function ReviewNoticeBar({ notice, onDismiss }: { notice: ReviewNotice; onDismiss: () => void }) {
  const title = notice.kind === "unset" ? "尚未设置评审模型" : "评审模型与默认模型相同";
  const body =
    notice.kind === "unset"
      ? "开启「评审修正」的翻译将由译者模型给自己的译文打分，自评通常偏宽松、难以发现自身错误。建议在另一个对话模型卡片的菜单中选择「设为评审模型」。"
      : `「${notice.name}」同时是默认模型和评审模型，使用默认模型翻译时评审等同于译者自评，打分偏宽松。建议改由另一个模型负责评审。`;
  return (
    <div role="status" className="relative mb-4 flex items-start gap-3 rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 pr-10 text-sm">
      <ScanSearchIcon className="mt-0.5 size-4 shrink-0 text-warning" />
      <div>
        <div className="font-medium text-warning">{title}</div>
        <div className="text-muted-foreground">{body}</div>
      </div>
      <button
        type="button"
        aria-label="关闭提示"
        onClick={onDismiss}
        className="absolute top-2.5 right-2.5 rounded-md p-1 text-muted-foreground transition-colors hover:bg-warning/10 hover:text-foreground"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}

/** 能力分组：可折叠的标题栏（图标、名称、数量、默认配置）+ 卡片网格 */
function CapabilityGroup({
  capability,
  items,
  children,
}: {
  capability: ModelCapability;
  items: ModelConfigVO[];
  children: React.ReactNode;
}) {
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(true);
  const def = items.find((m) => m.isDefault && m.enabled);
  return (
    <section className="rounded-2xl border bg-surface/40 p-1.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className="flex size-8 items-center justify-center rounded-lg bg-card text-brand shadow-card ring-1 ring-foreground/5">
          <CapabilityIcon capability={capability} className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-sm font-semibold">
            {CAPABILITY_LABEL[capability]}
            <span className="rounded-full bg-muted px-1.5 text-[11px] font-normal text-muted-foreground tabular-nums">{items.length}</span>
          </span>
          <span className="block truncate text-xs text-muted-foreground">{CAPABILITY_DESC[capability]}</span>
        </span>
        <span
          className={cn(
            "hidden shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] sm:inline-flex",
            def ? "bg-brand-soft text-brand" : "bg-warning-soft text-warning",
          )}
        >
          {def ? (
            <>
              <StarIcon className="size-3 fill-current" />
              默认：{def.name}
            </>
          ) : (
            <>
              <AlertTriangleIcon className="size-3" />
              未设默认
            </>
          )}
        </span>
        <motion.span animate={{ rotate: open ? 0 : -90 }} transition={{ duration: DURATION.fast }} className="text-muted-foreground">
          <ChevronDownIcon className="size-4" />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: reduce ? DURATION.fast : DURATION.page, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            <div className="p-2 pt-1.5">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

type ReviewAction = { m: ModelConfigVO; action: "set" | "clear" };

const PAGE_SIZE = 100;

/** 模型配置：按能力分组的卡片网格 + 侧滑编辑表单 + 连通性测试动画 */
export default function ModelConfigsPage() {
  const qc = useQueryClient();
  const [keyword, setKeyword] = useState("");
  const [query, setQuery] = useState<{ pageNum: number; pageSize: number; keyword?: string }>({
    pageNum: 1,
    pageSize: PAGE_SIZE,
  });
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<ModelConfigVO | null>(null);
  const [toDelete, setToDelete] = useState<ModelConfigVO | null>(null);
  const [tests, setTests] = useState<Record<number, TestState>>({});
  const [reviewAction, setReviewAction] = useState<ReviewAction | null>(null);
  /** 已关闭的提示条 key；情形变化（key 不同）时提示重新出现 */
  const [dismissedNotice, setDismissedNotice] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["model-configs", "page", query],
    queryFn: () => modelConfigApi.page(query),
    placeholderData: keepPreviousData,
  });
  // 用于判断是否存在启用的对话默认模型（默认模型按能力唯一）
  const overview = useQuery({
    queryKey: ["model-configs", "overview"],
    queryFn: () => modelConfigApi.page({ pageNum: 1, pageSize: 100 }),
  });
  const chatConfigs = overview.data?.records.filter((m) => capabilityOf(m) === "CHAT");
  const hasDefault = chatConfigs?.some((m) => m.isDefault && m.enabled);
  const currentReview = chatConfigs?.find((m) => m.isReviewDefault && m.enabled);
  const notice = hasDefault ? reviewNoticeOf(chatConfigs) : null;
  const showNotice = !!notice && notice.key !== dismissedNotice;

  const invalidate = () => qc.invalidateQueries({ queryKey: ["model-configs"] });
  const defaultM = useMutation({
    mutationFn: (m: ModelConfigVO) => modelConfigApi.setDefault(m.id),
    onSuccess: (_d, m) => {
      toast.success(`已设为${CAPABILITY_LABEL[capabilityOf(m)]}默认模型`);
      invalidate();
    },
    onError: toastError,
  });
  const reviewM = useMutation({
    mutationFn: (p: ReviewAction) =>
      p.action === "set" ? modelConfigApi.setReviewDefault(p.m.id) : modelConfigApi.clearReviewDefault(p.m.id),
    onSuccess: (_d, p) => {
      toast.success(p.action === "set" ? `已将「${p.m.name}」设为评审模型` : "已取消评审模型，评审将使用译者模型");
      setReviewAction(null);
      invalidate();
    },
    onError: toastError,
  });
  const enabledM = useMutation({
    mutationFn: (p: { id: number; enabled: boolean }) => modelConfigApi.setEnabled(p.id, p.enabled),
    onSuccess: (_d, p) => {
      toast.success(p.enabled ? "已启用" : "已停用");
      invalidate();
    },
    onError: toastError,
  });
  const deleteM = useMutation({
    mutationFn: (id: number) => modelConfigApi.remove(id),
    onSuccess: () => {
      toast.success("已删除");
      setToDelete(null);
      invalidate();
    },
    onError: toastError,
  });

  const runTest = async (m: ModelConfigVO) => {
    setTests((t) => ({ ...t, [m.id]: { testing: true } }));
    try {
      const result = await modelConfigApi.test(m.id);
      setTests((t) => ({ ...t, [m.id]: { testing: false, result } }));
    } catch (e) {
      toastError(e);
      setTests((t) => {
        const next = { ...t };
        delete next[m.id];
        return next;
      });
    }
  };

  const openSheet = (m: ModelConfigVO | null) => {
    setEditing(m);
    setSheetOpen(true);
  };
  const records = list.data?.records ?? [];
  const groups = groupByCapability(records);
  let cardIndex = 0;

  return (
    <PageContainer>
      <PageHeader
        title="模型配置"
        description="按能力管理对话、语音识别、语音合成、实时同传与图片翻译的接入配置"
        icon={CpuIcon}
        actions={
          <Button onClick={() => openSheet(null)}>
            <PlusIcon />
            新建配置
          </Button>
        }
      />
      <AnimatePresence>
        {overview.isSuccess && !hasDefault && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="mb-4 flex items-start gap-3 rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm">
              <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-danger" />
              <div>
                <div className="font-medium text-danger">尚未设置可用的默认对话模型</div>
                <div className="text-muted-foreground">请新建或启用一个对话能力的模型配置，并将其设为默认模型，否则 AI 能力无法使用。</div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {showNotice && notice && (
          <motion.div
            key="review-notice"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            <ReviewNoticeBar notice={notice} onDismiss={() => setDismissedNotice(notice.key)} />
          </motion.div>
        )}
      </AnimatePresence>
      <div className="mb-4 flex items-center gap-2">
        <SearchInput
          value={keyword}
          onChange={setKeyword}
          onSubmit={() => setQuery({ ...query, pageNum: 1, keyword: keyword.trim() || undefined })}
          placeholder="按名称或模型名搜索，回车确认"
        />
      </div>

      {list.isLoading ? (
        <CardGridSkeleton count={6} />
      ) : list.isError ? (
        <div className="rounded-xl border bg-card shadow-card">
          <ErrorState error={list.error} onRetry={() => list.refetch()} retrying={list.isFetching} />
        </div>
      ) : !records.length ? (
        <div className="rounded-xl border bg-card shadow-card">
          <EmptyState
            icon={CpuIcon}
            title={query.keyword ? "没有匹配的模型配置" : "还没有模型配置"}
            description="接入一个 OpenAI 兼容或 Anthropic 对话模型，翻译 Agent 才能工作。"
            action={
              <Button onClick={() => openSheet(null)}>
                <PlusIcon />
                新建配置
              </Button>
            }
          />
        </div>
      ) : (
        <>
          <div className="space-y-4">
            {groups.map((g) => (
              <CapabilityGroup key={g.capability} capability={g.capability} items={g.items}>
                <StaggerList className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {g.items.map((m) => (
                    <ModelCard
                      key={m.id}
                      m={m}
                      index={cardIndex++}
                      test={tests[m.id]}
                      busy={enabledM.isPending || defaultM.isPending || reviewM.isPending}
                      onTest={() => runTest(m)}
                      onDismissTest={() =>
                        setTests((t) => {
                          const next = { ...t };
                          delete next[m.id];
                          return next;
                        })
                      }
                      onEdit={() => openSheet(m)}
                      onDelete={() => setToDelete(m)}
                      onDefault={() => defaultM.mutate(m)}
                      onReview={() => setReviewAction({ m, action: m.isReviewDefault ? "clear" : "set" })}
                      onEnabled={(v) => enabledM.mutate({ id: m.id, enabled: v })}
                    />
                  ))}
                </StaggerList>
              </CapabilityGroup>
            ))}
          </div>
          {list.data && list.data.total > query.pageSize && (
            <Pagination
              className="mt-4"
              pageNum={query.pageNum}
              pageSize={query.pageSize}
              total={list.data.total}
              onChange={(p) => setQuery({ ...query, pageNum: p })}
            />
          )}
        </>
      )}

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent className="sm:max-w-lg">
          <ModelConfigForm key={editing?.id ?? "new"} editing={editing} onClose={() => setSheetOpen(false)} />
        </SheetContent>
      </Sheet>
      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="删除模型配置"
        description={`确定删除「${toDelete?.name}」吗？${toDelete?.isDefault ? `该配置是当前${CAPABILITY_LABEL[capabilityOf(toDelete)]}默认模型，删除后需重新指定默认模型。` : ""}${toDelete?.isReviewDefault ? "该配置是当前评审模型，删除后评审将使用译者模型。" : ""}`}
        confirmText="删除"
        pending={deleteM.isPending}
        onConfirm={() => toDelete && deleteM.mutate(toDelete.id)}
      />
      <ConfirmDialog
        open={!!reviewAction}
        onOpenChange={(o) => !o && setReviewAction(null)}
        destructive={false}
        title={reviewAction?.action === "clear" ? "取消评审模型" : "设为评审模型"}
        description={
          reviewAction?.action === "clear"
            ? `取消后系统将没有评审模型，开启「评审修正」时由译者模型给自己的译文打分，自评偏宽松。确定取消「${reviewAction.m.name}」的评审模型标记吗？`
            : reviewAction
              ? [
                  `开启「评审修正」的翻译将由「${reviewAction.m.name}」负责评审打分，修正与补译仍使用译者模型。`,
                  currentReview && currentReview.id !== reviewAction.m.id ? `原评审模型「${currentReview.name}」的标记将被取消。` : "",
                  reviewAction.m.isDefault ? "注意：该配置同时是默认模型，使用默认模型翻译时评审等同于自评。" : "",
                ].join("")
              : undefined
        }
        confirmText={reviewAction?.action === "clear" ? "取消评审模型" : "设为评审模型"}
        pending={reviewM.isPending}
        onConfirm={() => reviewAction && reviewM.mutate(reviewAction)}
      />
    </PageContainer>
  );
}
