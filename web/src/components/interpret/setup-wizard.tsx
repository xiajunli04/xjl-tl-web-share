"use client";

import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { CheckIcon, FlaskConicalIcon, MicIcon } from "lucide-react";
import { DURATION, EASE_OUT, SPRING_LAYOUT } from "@/components/motion";
import { useSpeechEngines } from "@/hooks/use-speech-engines";
import { interpretRuntime } from "@/hooks/use-interpret-socket";
import type { InterpretMode } from "@/lib/api/interpret";
import { engineListFor } from "@/lib/interpret/setup";
import { MOCK_API } from "@/lib/mock/flags";
import { cn } from "@/lib/utils";
import { useInterpretSetup, useInterpretStore } from "@/stores/interpret-store";
import { JoinRoomDialog } from "./join-room-dialog";
import { MicDeniedCard } from "./mic-denied-card";
import { ResumeCard } from "./resume-card";
import { ModeStep } from "./mode-step";
import { SettingsStep } from "./settings-step";

const STEPS = ["选择模式", "语言与引擎"];

function Stepper({ step, onStep }: { step: number; onStep: (s: number) => void }) {
  return (
    <ol className="flex items-center gap-2" aria-label="准备步骤">
      {STEPS.map((label, i) => {
        const done = i < step;
        const active = i === step;
        return (
          <li key={label} className="flex items-center gap-2">
            {i > 0 && <span className={cn("h-px w-6 transition-colors sm:w-10", done || active ? "bg-brand/50" : "bg-border")} />}
            <button
              type="button"
              disabled={i > step}
              onClick={() => onStep(i)}
              className={cn(
                "relative inline-flex h-8 items-center gap-2 rounded-full px-3 text-xs font-medium transition-colors disabled:cursor-default",
                active ? "text-brand" : done ? "text-foreground hover:bg-muted" : "text-muted-foreground",
              )}
            >
              {active && <motion.span layoutId="wizard-step" transition={SPRING_LAYOUT} className="absolute inset-0 rounded-full bg-brand-soft" />}
              <span
                className={cn(
                  "relative flex size-5 items-center justify-center rounded-full text-[10px] font-semibold",
                  active ? "bg-brand-gradient text-brand-foreground" : done ? "bg-success text-success-foreground" : "bg-muted text-muted-foreground",
                )}
              >
                {done ? <CheckIcon className="size-3" /> : i + 1}
              </span>
              <span className="relative">{label}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** 准备阶段卡片向导：① 选择模式 → ② 语言与引擎（含高级分区）→ 开始 */
export function SetupWizard({ initialRoom }: { initialRoom?: string }) {
  const reduce = useReducedMotion();
  const setup = useInterpretSetup();
  const phase = useInterpretStore((s) => s.phase);
  const micError = useInterpretStore((s) => s.micError);
  const patch = useInterpretStore((s) => s.patch);
  const enginesQ = useSpeechEngines();
  const engines = engineListFor(setup.mode, enginesQ.data);
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  const [joinOpen, setJoinOpen] = useState(!!initialRoom);
  const [lastAction, setLastAction] = useState<"start" | "join">("start");
  const [joinArgs, setJoinArgs] = useState<{ code: string; name: string; lang: string } | null>(null);
  const starting = phase === "starting";

  const go = (s: number) => {
    setDir(s > step ? 1 : -1);
    setStep(s);
  };

  const pick = (m: InterpretMode) => {
    setup.patchSetup({ mode: m });
    go(1);
  };

  const start = () => {
    setLastAction("start");
    void interpretRuntime.start(useInterpretSetup.getState(), engines.find((e) => e.id === setup.engine));
  };

  const join = (code: string, name: string, lang: string) => {
    setLastAction("join");
    setJoinArgs({ code, name, lang });
    setJoinOpen(false);
    void interpretRuntime.joinRoom(code, name, lang, useInterpretSetup.getState());
  };

  const retry = () => {
    if (lastAction === "join" && joinArgs) join(joinArgs.code, joinArgs.name, joinArgs.lang);
    else start();
  };

  const slide = reduce ? 0 : 24;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-6 md:px-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border bg-card text-brand shadow-card">
            <MicIcon className="size-5" />
          </span>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">同声传译</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">实时字幕、译文与语音播报，支持收听、面对面对话、多语会议室，也可以和 AI 数字人用外语聊天</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {MOCK_API && (
            <span className="hidden items-center gap-1 rounded-full bg-warning-soft px-2 py-1 text-[11px] text-warning md:inline-flex">
              <FlaskConicalIcon className="size-3" />
              脚本化演示
            </span>
          )}
          <Stepper step={step} onStep={go} />
        </div>
      </div>

      <AnimatePresence initial={false}>
        <ResumeCard key="resume" />
        {micError && <MicDeniedCard key="mic" kind={micError} onRetry={retry} onClose={() => patch({ micError: null })} />}
      </AnimatePresence>

      <div className="relative flex-1">
        <AnimatePresence mode="popLayout" initial={false} custom={dir}>
          <motion.div
            key={step}
            custom={dir}
            initial={{ opacity: 0, x: dir * slide }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -dir * slide }}
            transition={{ duration: DURATION.page + 0.04, ease: EASE_OUT }}
          >
            {step === 0 ? (
              <ModeStep value={setup.mode} onPick={pick} onJoin={() => setJoinOpen(true)} />
            ) : (
              <SettingsStep
                engines={engines}
                ttsEngines={enginesQ.data?.tts ?? []}
                loading={enginesQ.isLoading}
                error={enginesQ.error}
                onRetry={() => void enginesQ.refetch()}
                starting={starting}
                onBack={() => go(0)}
                onStart={start}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      <JoinRoomDialog
        open={joinOpen}
        onOpenChange={setJoinOpen}
        initialCode={initialRoom}
        defaultName={setup.displayName}
        defaultLang={setup.roomLang}
        pending={starting}
        onJoin={join}
      />
    </div>
  );
}
