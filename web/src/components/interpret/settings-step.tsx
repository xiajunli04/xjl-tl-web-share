"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowLeftIcon,
  ArrowLeftRightIcon,
  ArrowRightIcon,
  CpuIcon,
  LanguagesIcon,
  Loader2Icon,
  SparklesIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LanguagePicker } from "@/components/translate/language-picker";
import { CharacterFace } from "@/components/avatar/character-face";
import { MascotIcon } from "@/components/avatar/mascot-icon";
import { HUMAN_AVATAR_ENABLED } from "@/lib/avatar/feature";
import { CHARACTERS, characterForLang } from "@/lib/avatar/characters";
import { DURATION, EASE_OUT } from "@/components/motion";
import { useLanguages } from "@/hooks/use-options";
import type { EngineInfo } from "@/lib/api/speech";
import { CHAT_ENGINE, CHAT_ENGINES, supportsAutoConverse, validateSetup } from "@/lib/interpret/setup";
import { langName } from "@/lib/languages";
import { cn } from "@/lib/utils";
import { useInterpretSetup } from "@/stores/interpret-store";
import { AdvancedSection } from "./advanced-section";
import { ChatEngineCards } from "./chat-engine-cards";
import { EngineBadges, EngineList } from "./engine-list";
import { AI_NAME, CHAT_SCENARIOS, MODE_META, SCENARIOS } from "./meta";

function Section({ icon: Icon, title, aside, children }: { icon: typeof CpuIcon; title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border bg-card p-4 shadow-card">
      <div className="mb-3 flex items-center gap-2">
        <Icon className="size-4 text-brand" />
        <h3 className="text-sm font-semibold">{title}</h3>
        {aside && <div className="ml-auto text-xs text-muted-foreground">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

function LangField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</div>
      <div className="rounded-xl border bg-background/60">{children}</div>
      {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** 对话形象预览：默认是吉祥物 Lumi；真人形象开关打开时按对话语言显示语言形象（切换时交叉淡入） */
function CharacterPreview({ lang }: { lang: string }) {
  const reduce = useReducedMotion();
  const id = characterForLang(lang);
  const c = CHARACTERS[id];
  const own = c.lang === lang;
  return (
    <div className="mb-6 flex w-full items-center gap-3 rounded-xl border bg-brand-soft/40 px-3 py-2 sm:w-auto">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={HUMAN_AVATAR_ENABLED ? id : "mascot"}
          initial={{ opacity: 0, scale: reduce ? 1 : 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: DURATION.page, ease: EASE_OUT }}
          className="inline-flex"
        >
          {HUMAN_AVATAR_ENABLED ? (
            <CharacterFace id={id} className="size-11" ring />
          ) : (
            <span className="flex size-11 items-center justify-center overflow-hidden rounded-full bg-card ring-2 ring-brand/40 ring-offset-2 ring-offset-background">
              <MascotIcon crop="face" mood="happy" className="size-11" />
            </span>
          )}
        </motion.span>
      </AnimatePresence>
      <div className="min-w-0 text-xs">
        {HUMAN_AVATAR_ENABLED ? (
          <>
            <div className="font-medium text-foreground">对话形象 · {c.outfit}</div>
            <div className="text-muted-foreground">{own ? `${AI_NAME} 的 ${c.label} 形象` : `该语言暂无专属形象，使用 ${c.label} 形象`}</div>
          </>
        ) : (
          <>
            <div className="font-medium text-foreground">和 {AI_NAME} 聊天</div>
            <div className="text-muted-foreground">她会用{langName(lang)}回复你</div>
          </>
        )}
      </div>
    </div>
  );
}

/** AI 对话场景：5 张单选卡，选中项的高亮底色在卡片间滑动 */
function ScenarioPicker({ value, onChange }: { value: keyof typeof CHAT_SCENARIOS; onChange: (v: keyof typeof CHAT_SCENARIOS) => void }) {
  const reduce = useReducedMotion();
  return (
    <div role="radiogroup" aria-label="对话场景" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {SCENARIOS.map((key) => {
        const sc = CHAT_SCENARIOS[key];
        const Icon = sc.icon;
        const active = key === value;
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(key)}
            className={cn(
              "relative flex flex-col items-start gap-1.5 rounded-xl border p-3 text-left outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
              active ? "border-brand/40" : "hover:bg-muted/50",
            )}
          >
            {active && (
              <motion.span
                layoutId="chat-scenario-active"
                className="absolute inset-0 rounded-xl bg-brand-soft"
                transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 34 }}
              />
            )}
            <span
              className={cn(
                "relative flex size-8 items-center justify-center rounded-lg transition-colors",
                active ? "bg-brand-gradient text-brand-foreground shadow-brand" : "bg-muted text-muted-foreground",
              )}
            >
              <Icon className="size-4" />
            </span>
            <span className="relative text-sm font-medium">{sc.title}</span>
            <span className="relative text-[11px] leading-snug text-muted-foreground">{sc.desc}</span>
          </button>
        );
      })}
    </div>
  );
}

/** 第二步：语言与引擎设置 + 高级分区 + 开始 */
export function SettingsStep({
  engines,
  ttsEngines,
  loading,
  error,
  onRetry,
  starting,
  onBack,
  onStart,
}: {
  engines: EngineInfo[];
  ttsEngines: EngineInfo[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  starting: boolean;
  onBack: () => void;
  onStart: () => void;
}) {
  const reduce = useReducedMotion();
  const all = useLanguages();
  const s = useInterpretSetup();
  const [swapTurn, setSwapTurn] = useState(0);
  const engine = engines.find((e) => e.id === s.engine);
  const meta = MODE_META[s.mode];
  const Icon = meta.icon;
  const langs = useMemo(() => (engine ? all.filter((l) => engine.languages.includes(l.code)) : all), [all, engine]);
  const autoOk = supportsAutoConverse(engine);
  const problem = loading ? null : validateSetup(s, engine);
  const chat = s.mode === "CHAT";
  const available = engines.filter((e) => e.available).length;
  // AI 对话只有平台级联与实时语音模型两种引擎；从其他模式切换过来时回到平台级联
  useEffect(() => {
    if (chat && !(CHAT_ENGINES as readonly string[]).includes(s.engine)) s.patchSetup({ engine: CHAT_ENGINE });
  }, [chat, s]);

  /** 切换引擎：所选语言不受支持时改为该引擎支持的第一种 */
  const pickEngine = (id: string) => {
    const e = engines.find((x) => x.id === id);
    if (!e) return;
    const fix = (l: string, avoid?: string) => (e.languages.includes(l) ? l : (e.languages.find((x) => x !== avoid) ?? l));
    const a = fix(s.converseA);
    s.patchSetup({
      engine: id,
      listenTarget: fix(s.listenTarget),
      converseA: a,
      converseB: fix(s.converseB, a),
      roomLang: fix(s.roomLang),
      chatMyLang: fix(s.chatMyLang),
      chatAiLang: fix(s.chatAiLang),
    });
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0 space-y-5">
        <Section icon={LanguagesIcon} title="语言" aside={engine ? `${engine.name}支持 ${engine.languages.length} 种` : undefined}>
          {s.mode === "LISTEN" && (
            <div className="flex flex-wrap items-end gap-3">
              <LangField label="说话语种" hint="自动识别，可混合多种语言">
                <div className="flex h-9 items-center px-3 text-sm text-muted-foreground">自动识别</div>
              </LangField>
              <ArrowRightIcon className="mb-6 size-4 text-muted-foreground" />
              <LangField label="翻译成" hint="字幕与播报使用该语言">
                <LanguagePicker label="目标语言" value={s.listenTarget} onChange={(v) => s.patchSetup({ listenTarget: v })} languages={langs} />
              </LangField>
            </div>
          )}
          {s.mode === "CONVERSE" && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-end gap-2">
                <LangField label="我（下半区）">
                  <LanguagePicker label="语言 A" value={s.converseA} onChange={(v) => s.patchSetup({ converseA: v })} languages={langs} />
                </LangField>
                <Button
                  variant="ghost"
                  size="icon"
                  className="mb-0.5 text-muted-foreground"
                  aria-label="互换语言"
                  onClick={() => {
                    s.patchSetup({ converseA: s.converseB, converseB: s.converseA });
                    setSwapTurn((t) => t + 1);
                  }}
                >
                  <motion.span animate={{ rotate: swapTurn * 180 }} transition={{ type: "spring", stiffness: 300, damping: 22 }} className="inline-flex">
                    <ArrowLeftRightIcon />
                  </motion.span>
                </Button>
                <LangField label="对方（上半区）">
                  <LanguagePicker label="语言 B" value={s.converseB} onChange={(v) => s.patchSetup({ converseB: v })} languages={langs} />
                </LangField>
              </div>
              <div className={cn("flex items-center gap-3 rounded-xl border px-3 py-2.5", !autoOk && "bg-muted/40")}>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">自动切换方向</div>
                  <p className="text-xs text-muted-foreground">
                    {autoOk ? "按识别出的语种自动译向另一侧；关闭后两侧各自按住按钮说话" : "该引擎仅支持按键说话"}
                  </p>
                </div>
                <Tooltip>
                  <TooltipTrigger render={<span />}>
                    <Switch
                      checked={autoOk && s.converseAuto}
                      disabled={!autoOk}
                      onCheckedChange={(v) => s.patchSetup({ converseAuto: v })}
                      aria-label="自动切换方向"
                    />
                  </TooltipTrigger>
                  {!autoOk && <TooltipContent>该引擎仅支持按键说话</TooltipContent>}
                </Tooltip>
              </div>
            </div>
          )}
          {s.mode === "ROOM" && (
            <div className="flex flex-wrap items-end gap-3">
              <LangField label="我的语言" hint="你会看到并听到这种语言">
                <LanguagePicker label="我的语言" value={s.roomLang} onChange={(v) => s.patchSetup({ roomLang: v })} languages={langs} />
              </LangField>
              <div className="min-w-0 flex-1">
                <div className="mb-1.5 text-xs font-medium text-muted-foreground">显示名</div>
                <Input className="h-9.5 rounded-xl" value={s.displayName} onChange={(e) => s.patchSetup({ displayName: e.target.value })} maxLength={20} placeholder="主持人" />
                <p className="mt-1 text-[11px] text-muted-foreground">成员条与消息中显示</p>
              </div>
            </div>
          )}
          {chat && (
            <div className="flex flex-wrap items-end gap-2">
              <LangField label="我的语言" hint="字幕用这种语言">
                <LanguagePicker label="我的语言" value={s.chatMyLang} onChange={(v) => s.patchSetup({ chatMyLang: v })} languages={langs} />
              </LangField>
              <Button
                variant="ghost"
                size="icon"
                className="mb-6 text-muted-foreground"
                aria-label="互换语言"
                onClick={() => {
                  s.patchSetup({ chatMyLang: s.chatAiLang, chatAiLang: s.chatMyLang });
                  setSwapTurn((t) => t + 1);
                }}
              >
                <motion.span animate={{ rotate: swapTurn * 180 }} transition={{ type: "spring", stiffness: 300, damping: 22 }} className="inline-flex">
                  <ArrowLeftRightIcon />
                </motion.span>
              </Button>
              <LangField label={`和 ${AI_NAME} 说的语言`} hint={`${AI_NAME} 用这种语言回复并朗读`}>
                <LanguagePicker label="对话语言" value={s.chatAiLang} onChange={(v) => s.patchSetup({ chatAiLang: v })} languages={langs} />
              </LangField>
              <CharacterPreview lang={s.chatAiLang} />
            </div>
          )}
        </Section>

        {chat && (
          <Section icon={SparklesIcon} title="场景" aside={`${AI_NAME} 会扮演对应的角色`}>
            <ScenarioPicker value={s.chatScenario} onChange={(v) => s.patchSetup({ chatScenario: v })} />
          </Section>
        )}

        <Section
          icon={CpuIcon}
          title={chat ? "对话引擎" : "同传引擎"}
          aside={loading ? undefined : chat ? "平台级联或实时语音模型" : `${available} / ${engines.length} 可用`}
        >
          {chat ? (
            <ChatEngineCards engines={engines} value={s.engine} onChange={pickEngine} loading={loading} error={error} onRetry={onRetry} />
          ) : (
            <EngineList engines={engines} value={s.engine} onChange={pickEngine} loading={loading} error={error} onRetry={onRetry} />
          )}
        </Section>
      </div>

      <div className="space-y-4 lg:sticky lg:top-0 lg:self-start">
        <div className="overflow-hidden rounded-2xl border bg-card shadow-card">
          <div className="relative flex items-center gap-3 border-b bg-brand-soft/60 px-4 py-4">
            <motion.span
              layoutId={`mode-tile-${s.mode}`}
              className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-brand-gradient text-brand-foreground shadow-brand"
            >
              <Icon className="size-5" />
            </motion.span>
            <div className="min-w-0">
              <div className="text-base font-semibold">{meta.title}</div>
              <p className="truncate text-xs text-muted-foreground">{meta.desc}</p>
            </div>
          </div>
          <dl className="space-y-2.5 px-4 py-4 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">语言</dt>
              <dd className="text-right font-medium">
                {s.mode === "LISTEN" && <>自动识别 → {langName(s.listenTarget)}</>}
                {s.mode === "CONVERSE" && <>{langName(s.converseA)} ⇄ {langName(s.converseB)}</>}
                {s.mode === "ROOM" && langName(s.roomLang)}
                {chat && (
                  <>
                    {langName(s.chatAiLang)} 对话 · {langName(s.chatMyLang)}字幕
                  </>
                )}
              </dd>
            </div>
            {chat && (
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">场景</dt>
                <dd className="font-medium">{CHAT_SCENARIOS[s.chatScenario].title}</dd>
              </div>
            )}
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">引擎</dt>
              <dd className="flex flex-col items-end gap-1 text-right font-medium">
                {engine?.name ?? "--"}
                {engine && <EngineBadges engine={engine} />}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">播报</dt>
              <dd className="font-medium">{s.tts ? `${s.gender === "male" ? "男声" : "女声"}${s.mode !== "ROOM" && !s.headphone ? " · 半双工" : ""}` : "关闭"}</dd>
            </div>
          </dl>
          <div className="space-y-2 border-t bg-muted/30 px-4 py-3">
            {problem && (
              <motion.p
                initial={{ opacity: 0, y: reduce ? 0 : -4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: DURATION.fast, ease: EASE_OUT }}
                className="flex items-center gap-1.5 text-xs text-warning"
              >
                <TriangleAlertIcon className="size-3.5 shrink-0" />
                {problem}
              </motion.p>
            )}
            <Button className="h-10 w-full text-sm" disabled={!!problem || starting || loading} onClick={onStart}>
              {starting ? <Loader2Icon className="animate-spin" /> : <Icon />}
              {starting ? "正在准备麦克风…" : meta.start}
            </Button>
            <Button variant="ghost" className="w-full text-muted-foreground" onClick={onBack} disabled={starting}>
              <ArrowLeftIcon />
              返回选择模式
            </Button>
          </div>
        </div>
        <AdvancedSection ttsEngines={ttsEngines} />
      </div>
    </div>
  );
}
