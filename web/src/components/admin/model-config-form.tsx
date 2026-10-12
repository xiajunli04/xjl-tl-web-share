"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ImageIcon, PlusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Segmented } from "@/components/ui/segmented";
import { SheetBody, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Field } from "@/components/layout/common";
import { DURATION, EASE_OUT } from "@/components/motion/tokens";
import { modelConfigApi } from "@/lib/api/model-configs";
import type { ModelCapability, ModelConfigSaveRequest, ModelConfigVO, Provider } from "@/lib/api/types";
import { toastError } from "@/lib/errors";
import {
  ALLOWED_PROVIDERS,
  CAPABILITIES,
  CAPABILITY_DESC,
  CAPABILITY_LABEL,
  EXTRA_MAX,
  PROVIDER_LABEL,
  capabilityOf,
  coerceProvider,
  extraToRows,
  isAllowedCombination,
  presetOf,
  rowsToExtra,
  usesSampling,
  validateBaseUrl,
  validateExtraRows,
  type ExtraRow,
} from "@/lib/model-capability";
import { cn } from "@/lib/utils";
import { CapabilityIcon, ProviderIcon } from "./model-config-icons";

const optionalNumber = (min: number, max: number, int = false) =>
  z
    .string()
    .trim()
    .refine((s) => {
      if (!s) return true;
      const n = Number(s);
      return Number.isFinite(n) && n >= min && n <= max && (!int || Number.isInteger(n));
    }, `请输入 ${min}–${max} 之间的${int ? "整数" : "数值"}`);

const schema = z
  .object({
    name: z.string().trim().min(1, "请输入名称").max(64, "最多 64 个字符"),
    capability: z.enum(["CHAT", "ASR", "TTS", "REALTIME_TRANSLATE", "REALTIME_CHAT", "IMAGE_TRANSLATE"]),
    provider: z.enum(["OPENAI_COMPATIBLE", "ANTHROPIC", "DASHSCOPE", "VOLCENGINE", "GOOGLE"]),
    baseUrl: z.string(),
    modelName: z.string().trim().min(1, "请输入模型名").max(128),
    apiKey: z.string(),
    supportsVision: z.boolean(),
    temperature: optionalNumber(0, 2),
    maxTokens: optionalNumber(1, 200_000, true),
    timeoutSeconds: optionalNumber(1, 600, true),
    remark: z.string().max(255, "最多 255 个字符"),
    enabled: z.boolean(),
  })
  .superRefine((v, ctx) => {
    const urlError = validateBaseUrl(v.baseUrl, v.capability);
    if (urlError) ctx.addIssue({ code: "custom", path: ["baseUrl"], message: urlError });
    if (!isAllowedCombination(v.capability, v.provider)) {
      ctx.addIssue({ code: "custom", path: ["provider"], message: `「${CAPABILITY_LABEL[v.capability]}」不支持该提供方` });
    }
  });
type FormValues = z.infer<typeof schema>;

const toStr = (n?: number) => (n === undefined || n === null ? "" : String(n));
const toNum = (s: string) => (s.trim() ? Number(s) : undefined);

/** 额外参数（键值对）编辑器：建议键一键添加，行进出带动效 */
function ExtraEditor({
  rows,
  onChange,
  errors,
  suggestions,
}: {
  rows: ExtraRow[];
  onChange: (rows: ExtraRow[]) => void;
  errors: (string | undefined)[];
  suggestions: { key: string; placeholder: string; hint: string }[];
}) {
  const reduce = useReducedMotion();
  const keys = new Set(rows.map((r) => r.key.trim()));
  const unused = suggestions.filter((s) => !keys.has(s.key));
  const placeholderOf = (key: string) => suggestions.find((s) => s.key === key.trim())?.placeholder ?? "值";
  const set = (i: number, patch: Partial<ExtraRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      <AnimatePresence initial={false}>
        {rows.map((r, i) => (
          <motion.div
            key={i}
            layout={!reduce}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: DURATION.page, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            <div className="flex items-start gap-2">
              <div className="grid flex-1 grid-cols-[2fr_3fr] gap-2">
                <Input
                  aria-label={`第 ${i + 1} 个参数名`}
                  value={r.key}
                  placeholder="参数名"
                  className="h-8 font-mono text-xs"
                  aria-invalid={!!errors[i]}
                  onChange={(e) => set(i, { key: e.target.value })}
                />
                <Input
                  aria-label={`第 ${i + 1} 个参数值`}
                  value={r.value}
                  placeholder={placeholderOf(r.key)}
                  className="h-8 text-xs"
                  onChange={(e) => set(i, { value: e.target.value })}
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="删除该参数"
                className="text-muted-foreground"
                onClick={() => onChange(rows.filter((_, j) => j !== i))}
              >
                <XIcon />
              </Button>
            </div>
            {errors[i] && <p className="mt-1 text-xs text-destructive">{errors[i]}</p>}
          </motion.div>
        ))}
      </AnimatePresence>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={rows.length >= EXTRA_MAX}
          onClick={() => onChange([...rows, { key: "", value: "" }])}
        >
          <PlusIcon />
          添加参数
        </Button>
        {unused.map((s) => (
          <button
            key={s.key}
            type="button"
            title={s.hint}
            onClick={() => onChange([...rows.filter((r) => r.key.trim() || r.value.trim()), { key: s.key, value: "" }])}
            className="rounded-full border border-dashed px-2 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:border-brand/40 hover:text-brand"
          >
            + {s.key}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 新建 / 编辑表单（侧滑面板）：能力类型联动提供方与字段 */
export function ModelConfigForm({ editing, onClose }: { editing: ModelConfigVO | null; onClose: () => void }) {
  const qc = useQueryClient();
  const reduce = useReducedMotion();
  const form = useForm<FormValues>({
    resolver: zodResolver(
      editing
        ? schema
        : schema.refine((v) => v.apiKey.trim().length > 0, { path: ["apiKey"], message: "请输入 API Key" }),
    ),
    defaultValues: {
      name: editing?.name ?? "",
      capability: editing ? capabilityOf(editing) : "CHAT",
      provider: editing?.provider ?? "OPENAI_COMPATIBLE",
      baseUrl: editing?.baseUrl ?? "",
      modelName: editing?.modelName ?? "",
      apiKey: "",
      supportsVision: !!editing?.supportsVision,
      temperature: toStr(editing?.params?.temperature),
      maxTokens: toStr(editing?.params?.maxTokens),
      timeoutSeconds: toStr(editing?.params?.timeoutSeconds),
      remark: editing?.remark ?? "",
      enabled: editing?.enabled ?? true,
    },
  });
  const [extra, setExtra] = useState<ExtraRow[]>(() => extraToRows(editing?.params?.extra));
  const [extraTouched, setExtraTouched] = useState(false);
  const e = form.formState.errors;
  const capability = useWatch({ control: form.control, name: "capability" });
  const provider = useWatch({ control: form.control, name: "provider" });
  const enabled = useWatch({ control: form.control, name: "enabled" });
  const supportsVision = useWatch({ control: form.control, name: "supportsVision" });
  const preset = presetOf(capability, provider);
  const providers = ALLOWED_PROVIDERS[capability];
  const extraErrors = validateExtraRows(extra);
  const sampling = usesSampling(capability);

  const switchCapability = (c: ModelCapability) => {
    form.setValue("capability", c);
    form.setValue("provider", coerceProvider(c, form.getValues("provider")));
    if (c !== "CHAT") form.setValue("supportsVision", false);
    if (form.formState.isSubmitted) void form.trigger(["baseUrl", "provider"]);
  };

  const submit = async (v: FormValues) => {
    setExtraTouched(true);
    if (extraErrors.some(Boolean)) return;
    const body: ModelConfigSaveRequest = {
      name: v.name.trim(),
      capability: v.capability,
      provider: v.provider,
      supportsVision: v.capability === "CHAT" ? v.supportsVision : false,
      baseUrl: v.baseUrl.trim(),
      modelName: v.modelName.trim(),
      apiKey: v.apiKey.trim() || undefined,
      params: {
        temperature: sampling ? toNum(v.temperature) : undefined,
        maxTokens: sampling ? toNum(v.maxTokens) : undefined,
        timeoutSeconds: toNum(v.timeoutSeconds),
        extra: rowsToExtra(extra),
      },
      remark: v.remark.trim() || undefined,
      enabled: v.enabled,
    };
    try {
      if (editing) await modelConfigApi.update(editing.id, body);
      else await modelConfigApi.create(body);
      toast.success(editing ? "模型配置已更新" : "模型配置已创建");
      qc.invalidateQueries({ queryKey: ["model-configs"] });
      onClose();
    } catch (err) {
      toastError(err);
    }
  };

  const fade = { duration: reduce ? DURATION.fast : DURATION.page, ease: EASE_OUT };

  return (
    <form className="flex h-full min-h-0 flex-col" onSubmit={form.handleSubmit(submit)} noValidate>
      <SheetHeader>
        <SheetTitle>{editing ? "编辑模型配置" : "新建模型配置"}</SheetTitle>
        <SheetDescription>API Key 加密存储，界面只显示掩码。</SheetDescription>
      </SheetHeader>
      <SheetBody className="space-y-5">
        <Field label="能力类型">
          <Segmented<ModelCapability>
            ariaLabel="能力类型"
            className="w-full"
            size="sm"
            value={capability}
            onChange={switchCapability}
            options={CAPABILITIES.map((c) => ({ value: c, label: CAPABILITY_LABEL[c], title: CAPABILITY_DESC[c] }))}
          />
          <AnimatePresence mode="wait" initial={false}>
            <motion.p
              key={capability}
              initial={{ opacity: 0, y: reduce ? 0 : 3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={fade}
              className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              <CapabilityIcon capability={capability} className="size-3.5" />
              {CAPABILITY_DESC[capability]}
            </motion.p>
          </AnimatePresence>
        </Field>

        <Field label="提供方" error={e.provider?.message}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={capability} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}>
              {providers.length > 1 ? (
                <Segmented<Provider>
                  ariaLabel="提供方"
                  className="w-full"
                  size="sm"
                  value={provider}
                  onChange={(v) => form.setValue("provider", v, { shouldValidate: form.formState.isSubmitted })}
                  options={providers.map((p) => ({ value: p, title: PROVIDER_LABEL[p].label, label: PROVIDER_LABEL[p].short }))}
                />
              ) : (
                <div className="flex items-center gap-2.5 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
                  <ProviderIcon provider={providers[0]} className="size-7 rounded-lg [&_svg]:size-3.5" />
                  <span className="font-medium" title={PROVIDER_LABEL[providers[0]].label}>{PROVIDER_LABEL[providers[0]].short}</span>
                  <span className="ml-auto text-xs text-muted-foreground">该能力仅支持此提供方</span>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </Field>

        <Field label="名称" htmlFor="m-name" error={e.name?.message}>
          <Input id="m-name" placeholder={`例如：${CAPABILITY_LABEL[capability]} · ${PROVIDER_LABEL[provider].short}`} {...form.register("name")} />
        </Field>
        <Field
          label="接口地址"
          htmlFor="m-baseUrl"
          error={e.baseUrl?.message}
          hint={
            capability === "REALTIME_TRANSLATE" || capability === "REALTIME_CHAT"
              ? `${capability === "REALTIME_CHAT" ? "实时语音对话" : "实时同传"}可以填写 wss:// 地址`
              : undefined
          }
        >
          <Input id="m-baseUrl" placeholder={preset.baseUrl} {...form.register("baseUrl")} />
        </Field>
        <Field label="模型名" htmlFor="m-modelName" error={e.modelName?.message}>
          <Input id="m-modelName" placeholder={preset.model} {...form.register("modelName")} />
        </Field>
        <Field
          label="API Key"
          htmlFor="m-apiKey"
          error={e.apiKey?.message}
          hint={editing ? `当前：${editing.apiKeyMask}，留空表示不修改` : "密钥将加密存储，仅显示掩码"}
        >
          <Input
            id="m-apiKey"
            type="password"
            autoComplete="off"
            placeholder={editing ? editing.apiKeyMask : "sk-..."}
            {...form.register("apiKey")}
          />
        </Field>

        <AnimatePresence initial={false}>
          {capability === "CHAT" && (
            <motion.label
              key="vision"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={fade}
              className="block overflow-hidden"
            >
              <span className="flex items-center justify-between rounded-lg border p-3 text-sm">
                <span className="flex items-start gap-2.5">
                  <ImageIcon className={cn("mt-0.5 size-4", supportsVision ? "text-brand" : "text-muted-foreground")} />
                  <span>
                    <span className="block font-medium">支持图片输入</span>
                    <span className="block text-xs text-muted-foreground">开启后可在图片翻译中作为视觉 OCR 模型</span>
                  </span>
                </span>
                <Switch checked={supportsVision} onCheckedChange={(c) => form.setValue("supportsVision", c)} />
              </span>
            </motion.label>
          )}
        </AnimatePresence>

        <motion.div layout={!reduce} className={cn("grid gap-3", sampling ? "grid-cols-3" : "grid-cols-1")}>
          <AnimatePresence initial={false}>
            {sampling && (
              <motion.div key="temp" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}>
                <Field label="temperature" htmlFor="m-temperature" error={e.temperature?.message}>
                  <Input id="m-temperature" inputMode="decimal" placeholder="0.3" {...form.register("temperature")} />
                </Field>
              </motion.div>
            )}
            {sampling && (
              <motion.div key="max" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}>
                <Field label="maxTokens" htmlFor="m-maxTokens" error={e.maxTokens?.message}>
                  <Input id="m-maxTokens" inputMode="numeric" placeholder="1024" {...form.register("maxTokens")} />
                </Field>
              </motion.div>
            )}
          </AnimatePresence>
          <Field label="超时（秒）" htmlFor="m-timeout" error={e.timeoutSeconds?.message}>
            <Input id="m-timeout" inputMode="numeric" placeholder="30" {...form.register("timeoutSeconds")} />
          </Field>
        </motion.div>

        <Field
          label="额外参数"
          hint="引擎相关的非敏感参数（如音色 voice、豆包 appId），明文保存"
        >
          <ExtraEditor
            rows={extra}
            onChange={setExtra}
            errors={extraTouched ? extraErrors : extraErrors.map((x, i) => (extra[i]?.key ? x : undefined))}
            suggestions={preset.extraKeys ?? []}
          />
        </Field>

        <Field label="备注" htmlFor="m-remark" error={e.remark?.message}>
          <Textarea id="m-remark" rows={2} {...form.register("remark")} />
        </Field>
        <label className="flex items-center justify-between rounded-lg border p-3 text-sm">
          <span>
            <span className="block font-medium">启用</span>
            <span className="block text-xs text-muted-foreground">停用后不会出现在模型选项与引擎列表中</span>
          </span>
          <Switch checked={enabled} onCheckedChange={(c) => form.setValue("enabled", c)} />
        </label>
      </SheetBody>
      <SheetFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          取消
        </Button>
        <Button type="submit" disabled={form.formState.isSubmitting}>
          保存
        </Button>
      </SheetFooter>
    </form>
  );
}
