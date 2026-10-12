"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeftRightIcon,
  FlaskConicalIcon,
  MessagesSquareIcon,
  PanelLeftOpenIcon,
  PanelRightOpenIcon,
  TextIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DURATION, EASE_OUT } from "@/components/motion/tokens";
import { nodeMeta } from "@/components/agent/node-meta";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useLanguages } from "@/hooks/use-options";
import { useSessionDetail, useSessionMutations } from "@/hooks/use-sessions";
import { translationRunStore, useTranslationRun } from "@/hooks/use-translation-run";
import { translateApi, type TranslateMode, type TranslateRequest } from "@/lib/api/translate";
import { sessionDetailKey, type SessionDetailVO, type SessionSummaryVO } from "@/lib/api/sessions";
import { toastError } from "@/lib/errors";
import { ApiError } from "@/lib/http";
import { MODE_OPTIONS, langName } from "@/lib/languages";
import { MOCK_STREAM } from "@/lib/mock/flags";
import { buildThread, defaultTitle, turnOfRecord, type ThreadTurn, type ThreadVersion } from "@/lib/session-thread";
import { currentTranslation } from "@/lib/translation-run";
import { useUiStore } from "@/stores/ui";
import { useWorkbenchStore, type WorkMode } from "@/stores/workbench";
import { AgentPanel, AgentPanelBody } from "./agent-panel";
import { ClarifyCard, type ClarifyPrompt } from "./clarify-card";
import { LanguagePicker } from "./language-picker";
import { SessionDrawer, SessionDrawerBody } from "./session-drawer";
import { SessionComposer } from "./session-composer";
import { SessionThread, type LiveTurn } from "./session-thread";
import { SettingsPopover } from "./settings-popover";
import { MAX_CHARS, SourcePanel } from "./source-panel";
import { TargetPanel } from "./target-panel";

const WORK_MODES = [
  { value: "single", label: <><TextIcon className="size-3.5" />单次</>, title: "每次翻译相互独立" },
  { value: "session", label: <><MessagesSquareIcon className="size-3.5" />会话</>, title: "连续翻译，携带前文上下文，可修订与追问" },
] as const;

/** 翻译工作台（默认首页）：单次 / 会话两种模式 */
export function Workbench() {
  const qc = useQueryClient();
  const languages = useLanguages();
  const run = useTranslationRun();
  const ws = useWorkbenchStore();
  const panelOpen = useUiStore((s) => s.agentPanelOpen);
  const setPanelOpen = useUiStore((s) => s.setAgentPanelOpen);
  const wide = useMediaQuery("(min-width: 1280px)");
  // 会话模式以对话线程为主：Agent 面板只在足够宽的屏幕上默认展开（不改动单次模式记住的偏好）
  const roomy = useMediaQuery("(min-width: 1600px)");
  const [sessionPanel, setSessionPanel] = useState(roomy);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [drawerSheet, setDrawerSheet] = useState(false);
  const [tab, setTab] = useState("timeline");
  const [swapTurn, setSwapTurn] = useState(0);

  const sessionMode = ws.workMode === "session";
  const panelVisible = sessionMode ? sessionPanel : panelOpen;
  const setPanelVisible = (open: boolean) => (sessionMode ? setSessionPanel(open) : setPanelOpen(open));
  /** 开始运行时展开 Agent 面板（会话模式在窄屏上不自动展开，进度直接显示在线程里） */
  const revealPanel = () => {
    if (wide && (!sessionMode || roomy)) setPanelVisible(true);
  };
  const sessionId = sessionMode ? ws.sessionId : null;
  const detailQ = useSessionDetail(sessionId);
  const detail = detailQ.data;
  const { create, update, adopt } = useSessionMutations();

  // 乐观采用：seq → recordId（接口返回后清除）
  const [overrides, setOverrides] = useState<Map<number, number>>(() => new Map());
  const turns = useMemo(() => buildThread(detail, overrides), [detail, overrides]);
  // 「打开会话」跳转：高亮并滚动到记录所在的轮次
  const focusSeq = turnOfRecord(turns, ws.focusRecordId);

  // 会话不存在（已删除 / 他人会话）：回到未选择状态
  useEffect(() => {
    if (detailQ.error instanceof ApiError && detailQ.error.code === "A0404") {
      ws.setSessionId(null);
      toast.info("会话不存在或已被删除");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailQ.error]);

  // 停止输入 600ms 后自动识别语种
  const debounced = useDebouncedValue(ws.text.trim(), 600);
  const detect = useQuery({
    queryKey: ["translate", "detect", debounced],
    queryFn: () => translateApi.detect(debounced),
    enabled: ws.sourceLang === "auto" && debounced.length > 0 && debounced.length <= MAX_CHARS,
    staleTime: Infinity,
    retry: false,
  });
  const detected = ws.sourceLang === "auto" && debounced ? detect.data : undefined;
  const effectiveSource =
    ws.sourceLang !== "auto" ? ws.sourceLang : (run.final?.sourceLang ?? detected?.lang);

  const running = run.status === "running";
  const runInThisSession = sessionMode && run.sessionId !== undefined && run.sessionId === sessionId;

  /** 打开会话：载入会话的默认参数 */
  const applySessionDefaults = (s: Pick<SessionDetailVO, "sourceLang" | "targetLang"> & Partial<SessionDetailVO>) => {
    ws.patch({
      sourceLang: s.sourceLang || ws.sourceLang,
      targetLang: s.targetLang || ws.targetLang,
      ...(s.style ? { style: s.style } : {}),
      ...(s.domain !== undefined ? { domain: s.domain ?? "" } : {}),
      ...(Array.isArray(s.glossaryIds) ? { glossaryIds: s.glossaryIds } : {}),
      ...(s.modelConfigId !== undefined ? { modelConfigId: s.modelConfigId } : {}),
    });
  };

  // 打开会话后，详情到达时再载入完整的默认参数（列表项只有语言对）
  const defaultsFor = useRef<number | null>(null);
  useEffect(() => {
    if (!detail || defaultsFor.current !== detail.id) return;
    defaultsFor.current = null;
    applySessionDefaults(detail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail]);

  const openSession = (s: SessionSummaryVO) => {
    if (s.id === sessionId) return;
    ws.setSessionId(s.id);
    setOverrides(new Map());
    applySessionDefaults(s);
    defaultsFor.current = s.id;
    if (!running) run.reset();
    setDrawerSheet(false);
  };

  const newSession = () => {
    ws.setSessionId(null);
    if (!running) run.reset();
    setDrawerSheet(false);
  };

  const switchMode = (m: WorkMode) => {
    if (m === ws.workMode) return;
    ws.setWorkMode(m);
    if (!running) run.reset();
  };

  /** 会话模式：确保有会话（首轮自动创建），并把当前设置同步为会话默认参数 */
  const ensureSession = async (text: string): Promise<number> => {
    const settings = {
      sourceLang: ws.sourceLang,
      targetLang: ws.targetLang,
      style: ws.style,
      domain: ws.domain || undefined,
      glossaryIds: ws.glossaryIds,
      modelConfigId: ws.modelConfigId ?? undefined,
    };
    if (sessionId !== null) {
      const d = detail;
      const changed =
        d &&
        (d.sourceLang !== settings.sourceLang ||
          d.targetLang !== settings.targetLang ||
          (d.style ?? "faithful") !== settings.style ||
          (d.domain ?? "") !== (settings.domain ?? "") ||
          JSON.stringify(d.glossaryIds ?? []) !== JSON.stringify(settings.glossaryIds) ||
          (d.modelConfigId ?? undefined) !== settings.modelConfigId);
      if (changed) {
        try {
          await update.mutateAsync({ id: sessionId, body: settings });
        } catch {
          // 同步失败不阻塞翻译：请求本身显式带上了参数
        }
      }
      return sessionId;
    }
    const s = await create.mutateAsync({ ...settings, title: defaultTitle(text), clarifyEnabled: true });
    ws.setSessionId(s.id);
    return s.id;
  };

  const translate = async () => {
    const text = ws.text;
    if (!text.trim()) return;
    if (Array.from(text).length > MAX_CHARS) {
      toast.error("长文本请使用文档翻译");
      return;
    }
    if (ws.sourceLang !== "auto" && ws.sourceLang === ws.targetLang) {
      toast.error("源语言与目标语言不能相同");
      return;
    }
    const req: TranslateRequest = {
      text,
      sourceLang: ws.sourceLang,
      targetLang: ws.targetLang,
      mode: ws.mode,
      style: ws.style,
      domain: ws.domain || undefined,
      glossaryIds: ws.glossaryIds.length ? ws.glossaryIds : undefined,
      modelConfigId: ws.modelConfigId ?? undefined,
    };
    if (sessionMode) {
      try {
        req.sessionId = await ensureSession(text);
      } catch (e) {
        toastError(e);
        return;
      }
      // 会话模式（聊天式）：发送即清空输入框，原文显示在线程中
      ws.setText("");
    }
    revealPanel();
    setTab("timeline");
    await run.start(req);
    // 失败或停止且输入框仍为空：把原文放回，便于修改后重发
    const st = translationRunStore.getState();
    if (sessionMode && (st.status === "error" || st.status === "stopped") && !useWorkbenchStore.getState().text) {
      ws.setText(text);
    }
  };

  const revise = (turn: ThreadTurn, instruction: string) => {
    if (sessionId === null) return;
    if (ws.focusRecordId !== null) ws.clearFocus();
    const base = turn.adopted;
    revealPanel();
    setTab("timeline");
    void run.run((o) => translateApi.revise(sessionId, { recordId: base.id, instruction }, o), {
      kind: "revise",
      sessionId,
      reviseOf: base.id,
      instruction,
      request: {
        text: base.sourceText,
        sourceLang: ws.sourceLang,
        targetLang: ws.targetLang,
        mode: ws.mode,
        style: ws.style,
        sessionId,
      },
    });
  };

  const onAdopt = (turn: ThreadTurn, v: ThreadVersion) => {
    if (sessionId === null) return;
    setOverrides((m) => new Map(m).set(turn.seq, v.id));
    adopt.mutate(
      { id: sessionId, recordId: v.id, seq: turn.seq },
      {
        onSuccess: () => toast.success(`第 ${turn.seq} 轮已采用 ${v.label}`, { description: "之后的会话上下文使用该版本" }),
        onError: (e) => {
          toastError(e);
          void qc.invalidateQueries({ queryKey: sessionDetailKey(sessionId) });
        },
        onSettled: () =>
          setOverrides((m) => {
            const n = new Map(m);
            n.delete(turn.seq);
            return n;
          }),
      },
    );
  };

  // 追问：本次运行以 clarify 结束优先；否则使用会话详情中的 pending（刷新页面后仍可回答）
  const pending = detail?.pending ?? null;
  const clarifyFromRun = run.status === "clarify" && runInThisSession && run.clarify ? run.clarify : null;
  const prompt: (ClarifyPrompt & { threadId: string }) | null = clarifyFromRun
    ? { ...clarifyFromRun, source: run.request?.text ?? pending?.source ?? null }
    : sessionMode && pending && !running
      ? { ...pending }
      : null;

  const answer = (a: string) => {
    if (sessionId === null || !prompt) return;
    const keep = run.status === "clarify" && runInThisSession;
    const clarify = { threadId: prompt.threadId, question: prompt.question, options: prompt.options, span: prompt.span, reason: prompt.reason ?? undefined, answer: a };
    revealPanel();
    setTab("timeline");
    void run
      .run((o) => translateApi.clarify(sessionId, { threadId: prompt.threadId, answer: a }, o), {
        kind: "resume",
        keep,
        sessionId,
        request: keep
          ? undefined
          : {
              text: prompt.source ?? "",
              sourceLang: ws.sourceLang,
              targetLang: ws.targetLang,
              mode: ws.mode,
              style: ws.style,
              sessionId,
            },
        seed: { clarify },
      })
      .then(() => {
        const st = translationRunStore.getState();
        if (st.status === "error" && st.error?.code === "A0440") {
          toast.error("追问已失效", { description: "该问题已被新的翻译取代，请重新提交原文" });
          void qc.invalidateQueries({ queryKey: sessionDetailKey(sessionId) });
        }
        if (st.status === "done" && useWorkbenchStore.getState().text.trim() === (prompt.source ?? "").trim()) ws.setText("");
      });
  };

  const retry = () => {
    if (run.kind && run.kind !== "translate") void run.retry();
    else if (run.request) void run.start(run.request);
    else void translate();
  };

  const swap = () => {
    const src = effectiveSource;
    if (!src) {
      toast.info("请先输入文本或选择源语言，再互换语种");
      return;
    }
    if (src === ws.targetLang) return;
    const translation = currentTranslation(run);
    ws.patch({ sourceLang: ws.targetLang, targetLang: src });
    if (translation && run.status !== "running" && !sessionMode) {
      ws.setText(translation);
      run.reset();
    }
    setSwapTurn((t) => t + 1);
  };

  const togglePanel = () => {
    if (wide) setPanelVisible(!panelVisible);
    else setSheetOpen(true);
  };

  const toggleDrawer = () => {
    if (wide) setDrawerOpen((o) => !o);
    else setDrawerSheet(true);
  };

  // 线程末尾的进行中一轮：翻译中 / 等待追问 / 失败 / 已停止；完成后在新轮次出现前保持显示，避免闪烁
  const finalRecordId = run.final?.recordId;
  const settled = finalRecordId != null && turns.some((t) => t.versions.some((v) => v.id === finalRecordId));
  const liveStatus: LiveTurn["status"] | null =
    !runInThisSession || run.kind === "revise" || !run.request
      ? null
      : running
        ? "running"
        : run.status === "clarify"
          ? "clarify"
          : run.status === "error"
            ? "error"
            : run.status === "stopped"
              ? "stopped"
              : run.status === "done" && finalRecordId != null && !settled
                ? "settling"
                : null;
  const lastNode = run.nodes.at(-1)?.node;
  const live: LiveTurn | null =
    liveStatus && run.request
      ? {
          source: run.request.text,
          text: currentTranslation(run),
          status: liveStatus,
          step: running && lastNode ? nodeMeta(lastNode).label : undefined,
          error: run.error ? new ApiError(run.error.code, run.error.message, run.error.traceId) : undefined,
        }
      : sessionMode && !runInThisSession && pending && !running
        ? { source: pending.source ?? "", text: "", status: "clarify" }
        : null;
  // 修订中（含完成后等待新版本刷新出来的间隙，避免译文闪回旧版本）
  const revisingSeq =
    runInThisSession && run.kind === "revise" && (running || (run.status === "done" && finalRecordId != null && !settled))
      ? turnOfRecord(turns, run.reviseOf)
      : null;

  const body = (onClose?: () => void) => (
    <AgentPanelBody run={run} tab={tab} onTabChange={setTab} onClose={onClose} />
  );
  const drawerBody = (onClose?: () => void) => (
    <SessionDrawerBody
      activeId={sessionId}
      busy={running}
      onOpen={openSession}
      onNew={newSession}
      onDeleted={(id) => id === sessionId && newSession()}
      onClose={onClose}
    />
  );

  return (
    <div className="flex min-h-0 flex-1">
      {sessionMode && wide && <SessionDrawer open={drawerOpen}>{drawerBody(() => setDrawerOpen(false))}</SessionDrawer>}

      <div className="flex min-w-0 flex-1 flex-col gap-3 p-3 md:p-5">
        {/* 工具条 */}
        <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-card px-2 py-1.5 shadow-card">
          <AnimatePresence initial={false}>
            {sessionMode && (!wide || !drawerOpen) && (
              <motion.div
                key="drawer-toggle"
                initial={{ opacity: 0, width: 0 }}
                animate={{ opacity: 1, width: "auto" }}
                exit={{ opacity: 0, width: 0 }}
                className="overflow-hidden"
              >
                <Tooltip>
                  <TooltipTrigger
                    render={<Button variant="ghost" size="icon-sm" aria-label="展开会话列表" onClick={toggleDrawer} />}
                  >
                    <PanelLeftOpenIcon />
                  </TooltipTrigger>
                  <TooltipContent>展开会话列表</TooltipContent>
                </Tooltip>
              </motion.div>
            )}
          </AnimatePresence>
          <Segmented<WorkMode>
            ariaLabel="工作模式"
            size="sm"
            value={ws.workMode}
            onChange={switchMode}
            options={WORK_MODES.map((o) => ({ value: o.value, label: o.label, title: o.title }))}
          />
          <div className="flex min-w-0 items-center">
            <LanguagePicker
              label="源语言"
              allowAuto
              value={ws.sourceLang}
              onChange={(v) => ws.patch({ sourceLang: v })}
              languages={languages}
              detect={detected}
              detecting={detect.isFetching}
            />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="互换语种"
                    onClick={swap}
                    disabled={running}
                    className="mx-1 text-muted-foreground"
                  />
                }
              >
                <motion.span
                  animate={{ rotate: swapTurn * 180 }}
                  transition={{ type: "spring", stiffness: 300, damping: 22 }}
                  className="inline-flex"
                >
                  <ArrowLeftRightIcon />
                </motion.span>
              </TooltipTrigger>
              <TooltipContent>互换语种</TooltipContent>
            </Tooltip>
            <LanguagePicker
              label="目标语言"
              value={ws.targetLang}
              onChange={(v) => ws.patch({ targetLang: v })}
              languages={languages}
            />
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {MOCK_STREAM && (
              <span className="hidden items-center gap-1 rounded-full bg-warning-soft px-2 py-1 text-[11px] text-warning 2xl:inline-flex">
                <FlaskConicalIcon className="size-3" />
                离线演示流
              </span>
            )}
            <Segmented<TranslateMode>
              ariaLabel="模式"
              size="sm"
              value={ws.mode}
              onChange={(v) => ws.patch({ mode: v })}
              options={MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label, title: o.hint }))}
            />
            <SettingsPopover effectiveSource={effectiveSource} />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant={wide && panelVisible ? "secondary" : "ghost"}
                    size="icon"
                    className="size-9"
                    aria-label="Agent 面板"
                    aria-pressed={wide && panelVisible}
                    onClick={togglePanel}
                  />
                }
              >
                <PanelRightOpenIcon />
              </TooltipTrigger>
              <TooltipContent>{wide && panelVisible ? "收起 Agent 面板" : "展开 Agent 面板"}</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {sessionMode ? (
          /* 会话模式：单栏对话线程 + 底部输入框 */
          <motion.div
            key="session"
            initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: DURATION.page, ease: EASE_OUT }}
            className="flex min-h-128 flex-1 flex-col overflow-hidden rounded-xl border bg-card shadow-card lg:min-h-0"
          >
            <SessionThread
              sessionId={sessionId}
              detail={detail}
              loading={detailQ.isLoading}
              error={detailQ.isError && !(detailQ.error instanceof ApiError && detailQ.error.code === "A0404") ? detailQ.error : undefined}
              onRetry={() => void detailQ.refetch()}
              turns={turns}
              targetLang={detail?.targetLang || ws.targetLang}
              highlightSeq={focusSeq}
              onAdopt={onAdopt}
              onRevise={revise}
              onToggleClarify={(v) =>
                sessionId !== null &&
                update.mutate(
                  { id: sessionId, body: { clarifyEnabled: v } },
                  { onSuccess: () => toast.success(v ? "已开启歧义追问" : "已关闭歧义追问"), onError: toastError },
                )
              }
              live={live}
              clarifySlot={prompt ? <ClarifyCard key={prompt.threadId} prompt={prompt} pending={running} onAnswer={answer} /> : undefined}
              onRetryLive={retry}
              onShowProcess={wide && panelVisible ? undefined : togglePanel}
              revising={revisingSeq !== null ? { seq: revisingSeq, text: currentTranslation(run) } : null}
              busy={running}
              onExample={(t) => ws.setText(t)}
            />
            <SessionComposer
              text={ws.text}
              lang={effectiveSource}
              onChange={ws.setText}
              onSend={() => void translate()}
              onStop={run.stop}
              running={running}
              placeholder={sessionId === null ? "输入第一句原文，发送后自动创建会话…" : "输入下一句，Agent 会结合前文翻译…"}
            />
          </motion.div>
        ) : (
          /* 单次模式：左右分栏编辑区 */
          <motion.div
            key="single"
            initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: DURATION.page, ease: EASE_OUT }}
            className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden rounded-xl border bg-card shadow-card lg:grid-cols-2 lg:divide-x max-lg:divide-y"
          >
            <SourcePanel
              text={ws.text}
              lang={effectiveSource}
              onChange={ws.setText}
              onTranslate={() => void translate()}
              onStop={run.stop}
              running={running}
            />
            <TargetPanel run={run} onRetry={retry} onStop={run.stop} />
          </motion.div>
        )}
        {ws.sourceLang === "auto" && detected && detected.lang === ws.targetLang && (
          <p className="text-xs text-warning">
            识别到的源语言（{langName(detected.lang, languages)}）与目标语言相同，请切换目标语言。
          </p>
        )}
      </div>

      {wide ? (
        <AgentPanel open={panelVisible}>{body(() => setPanelVisible(false))}</AgentPanel>
      ) : (
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent className="sm:max-w-md">
            <SheetTitle className="sr-only">Agent 面板</SheetTitle>
            {body()}
          </SheetContent>
        </Sheet>
      )}
      {sessionMode && !wide && (
        <Sheet open={drawerSheet} onOpenChange={setDrawerSheet}>
          <SheetContent side="left" className="w-75 bg-surface sm:max-w-75">
            <SheetTitle className="sr-only">会话列表</SheetTitle>
            {drawerBody()}
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
