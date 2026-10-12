"use client";

import { useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { BookMarkedIcon, CheckIcon, ChevronDownIcon, GaugeIcon, HeadphonesIcon, SlidersHorizontalIcon, Volume2Icon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { DURATION, EASE_OUT } from "@/components/motion";
import { useGlossaryOptions, useModelOptions } from "@/hooks/use-options";
import type { LatencyMode } from "@/lib/api/interpret";
import type { EngineInfo } from "@/lib/api/speech";
import { REALTIME_CHAT_ENGINE, isCascade } from "@/lib/interpret/setup";
import { DOMAIN_PRESETS, langName } from "@/lib/languages";
import { cn } from "@/lib/utils";
import { useInterpretSetup } from "@/stores/interpret-store";

function Row({ icon: Icon, title, hint, children }: { icon: typeof Volume2Icon; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        {hint && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}

function Label({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <span className="text-xs font-medium text-muted-foreground">{children}</span>
      {aside}
    </div>
  );
}

/** 实时语音模型不支持的设置：置灰并说明（improve-speech-playback-latency 8.3） */
function Unsupported({ off, children }: { off: boolean; children: React.ReactNode }) {
  return (
    <div className="relative">
      <div className={cn("transition-opacity", off && "pointer-events-none opacity-45 select-none")} aria-disabled={off || undefined}>
        {children}
      </div>
      {off && <p className="mt-1.5 text-[11px] text-warning">实时语音模型不支持，此项仅对平台级联生效</p>}
    </div>
  );
}

/** 可折叠的「高级」分区：术语库、领域提示、回复 / 翻译模型、响应速度、音色、播报引擎、语音播报、耳机模式 */
export function AdvancedSection({ ttsEngines }: { ttsEngines: EngineInfo[] }) {
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(false);
  const s = useInterpretSetup();
  const glossaries = useGlossaryOptions();
  const models = useModelOptions();
  const cascade = isCascade(s.engine);
  const realtime = s.engine === REALTIME_CHAT_ENGINE;
  const chat = s.mode === "CHAT";
  const changed =
    (s.glossaryIds.length ? 1 : 0) + (s.domainHint ? 1 : 0) + (s.gender !== "female" ? 1 : 0) + (!s.tts ? 1 : 0) + (s.headphone ? 1 : 0) +
    (s.ttsEngine ? 1 : 0) + (cascade && s.mtModelConfigId ? 1 : 0) + (cascade && s.latencyMode === "fast" ? 1 : 0);

  const toggleGlossary = (id: number) =>
    s.patchSetup({ glossaryIds: s.glossaryIds.includes(id) ? s.glossaryIds.filter((x) => x !== id) : [...s.glossaryIds, id] });

  return (
    <div className="overflow-hidden rounded-2xl border bg-card shadow-card">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <span className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <SlidersHorizontalIcon className="size-4" />
        </span>
        <span className="flex-1">
          <span className="flex items-center gap-2 text-sm font-medium">
            高级
            {changed > 0 && (
              <span className="flex size-4.5 items-center justify-center rounded-full bg-brand-gradient text-[10px] font-semibold text-brand-foreground">{changed}</span>
            )}
          </span>
          <span className="block text-xs text-muted-foreground">术语库、领域、响应速度、音色、播报与耳机模式</span>
        </span>
        <ChevronDownIcon className={cn("size-4 text-muted-foreground transition-transform duration-200", open && "rotate-180")} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: reduce ? DURATION.fast : DURATION.page + 0.04, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            <div className="space-y-5 border-t px-4 py-4">
              <Unsupported off={realtime}>
                <Label aside={<Link href="/glossaries" className="text-[11px] text-brand hover:underline">管理术语库</Link>}>
                  术语库（级联引擎注入翻译，千问引擎写入热词）
                </Label>
                <div className="scrollbar-thin max-h-36 space-y-1 overflow-y-auto rounded-lg border p-1">
                  {glossaries.isLoading ? (
                    <Skeleton className="h-8" />
                  ) : !glossaries.data?.length ? (
                    <p className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
                      <BookMarkedIcon className="size-3.5" />
                      还没有术语库
                    </p>
                  ) : (
                    glossaries.data.map((g) => {
                      const checked = s.glossaryIds.includes(g.id);
                      return (
                        <button
                          key={g.id}
                          type="button"
                          role="checkbox"
                          aria-checked={checked}
                          onClick={() => toggleGlossary(g.id)}
                          className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted", checked && "bg-brand-soft hover:bg-brand-soft")}
                        >
                          <span className={cn("flex size-4 shrink-0 items-center justify-center rounded border", checked ? "border-transparent bg-brand-gradient text-brand-foreground" : "border-input")}>
                            {checked && <CheckIcon className="size-3" />}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{g.name}</span>
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {langName(g.sourceLang)}→{langName(g.targetLang)}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </Unsupported>

              <div>
                <Label>领域提示</Label>
                <Input
                  value={s.domainHint}
                  onChange={(e) => s.patchSetup({ domainHint: e.target.value })}
                  placeholder="如：技术发布会、医学讲座"
                  maxLength={40}
                />
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {DOMAIN_PRESETS.slice(1).map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => s.patchSetup({ domainHint: s.domainHint === d ? "" : d })}
                      className={cn(
                        "h-6 rounded-full border px-2.5 text-[11px] transition-colors",
                        s.domainHint === d ? "border-brand/40 bg-brand-soft text-brand" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              </div>

              {(cascade || realtime) && (
                <Unsupported off={realtime}>
                  <Label>{chat ? "回复模型（平台级联）" : "翻译模型（级联）"}</Label>
                  <select
                    value={s.mtModelConfigId ?? ""}
                    onChange={(e) => s.patchSetup({ mtModelConfigId: e.target.value ? Number(e.target.value) : null })}
                    className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
                    aria-label={chat ? "回复模型" : "翻译模型"}
                  >
                    <option value="">平台默认模型</option>
                    {(models.data ?? []).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                        {m.isDefault ? "（默认）" : ""}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    同传对延迟敏感，建议选择非推理的快速模型（首字约 1.5 s）
                  </p>
                </Unsupported>
              )}

              {(cascade || realtime) && (
                <Unsupported off={realtime}>
                  <Label>
                    <span className="inline-flex items-center gap-1.5">
                      <GaugeIcon className="size-3.5" />
                      响应速度
                    </span>
                  </Label>
                  <Segmented<LatencyMode>
                    ariaLabel="响应速度"
                    size="sm"
                    className="w-full"
                    value={s.latencyMode}
                    onChange={(v) => s.patchSetup({ latencyMode: v })}
                    options={[
                      { value: "balanced", label: "均衡", title: "说完停顿 0.5 s 判定句末" },
                      { value: "fast", label: "极速", title: "说完停顿 0.3 s 判定句末，更早开口" },
                    ]}
                  />
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    {s.latencyMode === "fast"
                      ? "极速：更早断句、更早开口；说话停顿较多时可能把一句话切成两句"
                      : "均衡：断句更稳，适合大多数场景"}
                  </p>
                </Unsupported>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>音色</Label>
                  <Segmented
                    ariaLabel="音色"
                    size="sm"
                    className="w-full"
                    value={s.gender}
                    onChange={(v) => s.patchSetup({ gender: v })}
                    options={[
                      { value: "female", label: "女声" },
                      { value: "male", label: "男声" },
                    ]}
                  />
                </div>
                <div>
                  <Label>播报引擎</Label>
                  <select
                    value={s.ttsEngine ?? ""}
                    onChange={(e) => s.patchSetup({ ttsEngine: e.target.value || null })}
                    className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
                    aria-label="播报引擎"
                  >
                    <option value="">默认</option>
                    {ttsEngines.map((e) => (
                      <option key={e.id} value={e.id} disabled={!e.available}>
                        {e.name}
                        {!e.available ? "（需配置）" : ""}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="space-y-4 border-t pt-4">
                <Row icon={Volume2Icon} title="语音播报" hint="译文定稿后自动朗读；合成失败时改用浏览器朗读">
                  <Switch checked={s.tts} onCheckedChange={(v) => s.patchSetup({ tts: v })} aria-label="语音播报" />
                </Row>
                {s.mode !== "ROOM" ? (
                  <Row icon={HeadphonesIcon} title="耳机模式" hint="关闭半双工：播报时也继续收音，适合佩戴耳机或收听讲座">
                    <Switch checked={s.headphone} onCheckedChange={(v) => s.patchSetup({ headphone: v })} aria-label="耳机模式" />
                  </Row>
                ) : (
                  <p className="flex items-center gap-2 rounded-lg bg-info-soft px-3 py-2 text-xs text-info">
                    <HeadphonesIcon className="size-3.5 shrink-0" />
                    会议室各自使用自己的设备，默认全双工，建议佩戴耳机
                  </p>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
