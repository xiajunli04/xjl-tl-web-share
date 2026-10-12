"use client";

import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { GlobeIcon, LockIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Segmented } from "@/components/ui/segmented";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Field, NativeSelect } from "@/components/layout/common";
import { useLanguages } from "@/hooks/use-options";
import { glossaryApi, type GlossaryScope, type GlossaryVO } from "@/lib/api/glossaries";
import { toastError } from "@/lib/errors";
import { DOMAIN_PRESETS } from "@/lib/languages";
import { isAdmin, useAuthStore } from "@/stores/auth";

const schema = z
  .object({
    name: z.string().trim().min(1, "请输入名称").max(64, "最多 64 个字符"),
    description: z.string().max(255, "最多 255 个字符"),
    sourceLang: z.string().min(1),
    targetLang: z.string().min(1),
    domain: z.string().max(32, "最多 32 个字符"),
    scope: z.enum(["PRIVATE", "PUBLIC"]),
  })
  .refine((v) => v.sourceLang !== v.targetLang, {
    path: ["targetLang"],
    message: "源语言与目标语言不能相同",
  });
type Values = z.infer<typeof schema>;

/** 新建 / 编辑术语库（侧滑面板） */
export function GlossaryFormSheet({
  open,
  onOpenChange,
  editing,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  editing: GlossaryVO | null;
  onSaved?: (g: GlossaryVO) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-md">
        {/* key 保证每次打开都用最新的初始值 */}
        <GlossaryForm
          key={editing?.id ?? "new"}
          editing={editing}
          onDone={(g) => {
            onOpenChange(false);
            if (g) onSaved?.(g);
          }}
        />
      </SheetContent>
    </Sheet>
  );
}

function GlossaryForm({ editing, onDone }: { editing: GlossaryVO | null; onDone: (g?: GlossaryVO) => void }) {
  const qc = useQueryClient();
  const languages = useLanguages();
  const admin = isAdmin(useAuthStore((s) => s.user));
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: editing?.name ?? "",
      description: editing?.description ?? "",
      sourceLang: editing?.sourceLang ?? "en",
      targetLang: editing?.targetLang ?? "zh",
      domain: editing?.domain ?? "",
      scope: editing?.scope ?? "PRIVATE",
    },
  });
  const e = form.formState.errors;
  const scope = useWatch({ control: form.control, name: "scope" });

  const submit = async (v: Values) => {
    const body = {
      name: v.name.trim(),
      description: v.description.trim() || undefined,
      sourceLang: v.sourceLang,
      targetLang: v.targetLang,
      domain: v.domain.trim() || undefined,
      scope: admin ? v.scope : undefined,
    };
    try {
      const g = editing ? await glossaryApi.update(editing.id, body) : await glossaryApi.create(body);
      toast.success(editing ? "术语库已更新" : "术语库已创建");
      void qc.invalidateQueries({ queryKey: ["glossaries"] });
      onDone(g);
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <form className="flex h-full min-h-0 flex-col" onSubmit={form.handleSubmit(submit)} noValidate>
      <SheetHeader>
        <SheetTitle>{editing ? "编辑术语库" : "新建术语库"}</SheetTitle>
        <SheetDescription>术语库只会匹配语言对一致的翻译请求。</SheetDescription>
      </SheetHeader>
      <SheetBody className="space-y-5">
        <Field label="名称" htmlFor="g-name" error={e.name?.message}>
          <Input id="g-name" placeholder="例如：AI 与计算机术语" {...form.register("name")} />
        </Field>
        <Field label="描述" htmlFor="g-desc" error={e.description?.message}>
          <Textarea id="g-desc" rows={3} placeholder="可选" {...form.register("description")} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="源语言" htmlFor="g-src">
            <NativeSelect id="g-src" className="h-9 w-full" {...form.register("sourceLang")}>
              {languages.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="目标语言" htmlFor="g-tgt" error={e.targetLang?.message}>
            <NativeSelect id="g-tgt" className="h-9 w-full" {...form.register("targetLang")}>
              {languages.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
        <Field label="领域" htmlFor="g-domain" error={e.domain?.message} hint="可选，例如：计算机、医学">
          <Input id="g-domain" list="g-domain-presets" {...form.register("domain")} />
          <datalist id="g-domain-presets">
            {DOMAIN_PRESETS.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
        </Field>
        {admin && (
          <Field label="可见范围" hint={scope === "PUBLIC" ? "所有用户可见，仅管理员可修改" : "仅自己可见"}>
            <Segmented<GlossaryScope>
              ariaLabel="可见范围"
              className="w-full"
              value={scope}
              onChange={(v) => form.setValue("scope", v)}
              options={[
                {
                  value: "PRIVATE",
                  label: (
                    <>
                      <LockIcon className="size-3.5" />
                      个人
                    </>
                  ),
                },
                {
                  value: "PUBLIC",
                  label: (
                    <>
                      <GlobeIcon className="size-3.5" />
                      公共
                    </>
                  ),
                },
              ]}
            />
          </Field>
        )}
      </SheetBody>
      <SheetFooter>
        <Button type="button" variant="outline" onClick={() => onDone()}>
          取消
        </Button>
        <Button type="submit" disabled={form.formState.isSubmitting}>
          {editing ? "保存" : "创建"}
        </Button>
      </SheetFooter>
    </form>
  );
}
