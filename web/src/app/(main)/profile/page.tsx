"use client";

import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { ClockIcon, KeyRoundIcon, ShieldIcon, UserCogIcon, UserIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Field, PageContainer, PageHeader } from "@/components/layout/common";
import { FadeIn } from "@/components/motion/fade-in";
import { userApi } from "@/lib/api/users";
import { toastError } from "@/lib/errors";
import { formatTime, optionalEmail, passwordSchema } from "@/lib/validators";
import { isAdmin, useAuthStore } from "@/stores/auth";

const profileSchema = z.object({
  nickname: z.string().max(32, "昵称最多 32 个字符"),
  email: optionalEmail,
});
type ProfileValues = z.infer<typeof profileSchema>;

const pwdSchema = z
  .object({
    oldPassword: z.string().min(1, "请输入原密码"),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    path: ["confirmPassword"],
    message: "两次输入的密码不一致",
  });
type PwdValues = z.infer<typeof pwdSchema>;

function ProfileForm() {
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const form = useForm<ProfileValues>({
    resolver: zodResolver(profileSchema),
    values: { nickname: user?.nickname ?? "", email: user?.email ?? "" },
  });
  const e = form.formState.errors;

  const save = async (v: ProfileValues) => {
    try {
      const u = await userApi.updateMe({ nickname: v.nickname, email: v.email });
      setUser(u);
      qc.setQueryData(["auth", "me"], u);
      toast.success("资料已更新");
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <form className="grid gap-5" onSubmit={form.handleSubmit(save)} noValidate>
      <Field label="用户名" hint="用户名创建后不可修改">
        <Input value={user?.username ?? ""} disabled />
      </Field>
      <Field label="昵称" htmlFor="nickname" error={e.nickname?.message}>
        <Input id="nickname" {...form.register("nickname")} />
      </Field>
      <Field label="邮箱" htmlFor="email" error={e.email?.message}>
        <Input id="email" type="email" {...form.register("email")} />
      </Field>
      <div className="flex justify-end border-t pt-4">
        <Button type="submit" disabled={form.formState.isSubmitting || !form.formState.isDirty}>
          保存修改
        </Button>
      </div>
    </form>
  );
}

function PasswordForm() {
  const router = useRouter();
  const qc = useQueryClient();
  const clear = useAuthStore((s) => s.clear);
  const form = useForm<PwdValues>({
    resolver: zodResolver(pwdSchema),
    defaultValues: { oldPassword: "", newPassword: "", confirmPassword: "" },
  });
  const e = form.formState.errors;

  const change = async (v: PwdValues) => {
    try {
      await userApi.changePassword({ oldPassword: v.oldPassword, newPassword: v.newPassword });
      toast.success("密码已修改，请重新登录");
      clear();
      qc.clear();
      router.replace("/login");
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <form className="grid gap-5" onSubmit={form.handleSubmit(change)} noValidate>
      <div className="flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning">
        <ShieldIcon className="mt-px size-3.5 shrink-0" />
        修改成功后所有会话将失效，需要重新登录。
      </div>
      <Field label="原密码" htmlFor="oldPassword" error={e.oldPassword?.message}>
        <Input id="oldPassword" type="password" autoComplete="current-password" {...form.register("oldPassword")} />
      </Field>
      <Field label="新密码" htmlFor="newPassword" error={e.newPassword?.message} hint="8–64 位，需同时包含字母和数字">
        <Input id="newPassword" type="password" autoComplete="new-password" {...form.register("newPassword")} />
      </Field>
      <Field label="确认新密码" htmlFor="confirmPassword" error={e.confirmPassword?.message}>
        <Input id="confirmPassword" type="password" autoComplete="new-password" {...form.register("confirmPassword")} />
      </Field>
      <div className="flex justify-end border-t pt-4">
        <Button type="submit" disabled={form.formState.isSubmitting}>
          修改密码
        </Button>
      </div>
    </form>
  );
}

/** 个人中心：「基本资料 / 安全设置」两个标签页，同一时刻只显示一个表单 */
export default function ProfilePage() {
  const user = useAuthStore((s) => s.user);
  const name = user?.nickname || user?.username || "用户";

  return (
    <PageContainer className="max-w-3xl">
      <PageHeader title="个人中心" description="管理你的资料与账号安全" icon={UserCogIcon} />
      <FadeIn className="mb-6 flex items-center gap-4 rounded-xl border bg-card p-5 shadow-card">
        <span className="flex size-14 items-center justify-center rounded-2xl bg-brand-gradient text-xl font-semibold text-brand-foreground shadow-brand">
          {name.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold">{name}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>@{user?.username}</span>
            <span className="rounded-md bg-brand-soft px-1.5 py-0.5 text-brand">{isAdmin(user) ? "管理员" : "普通用户"}</span>
            <span className="inline-flex items-center gap-1">
              <ClockIcon className="size-3" />
              上次登录 {formatTime(user?.lastLoginAt)}
            </span>
          </div>
        </div>
      </FadeIn>
      <Tabs defaultValue="profile" className="gap-4">
        <TabsList>
          <TabsTrigger value="profile">
            <UserIcon />
            基本资料
          </TabsTrigger>
          <TabsTrigger value="security">
            <KeyRoundIcon />
            安全设置
          </TabsTrigger>
        </TabsList>
        <TabsContent value="profile">
          <FadeIn className="rounded-xl border bg-card p-6 shadow-card">
            <ProfileForm />
          </FadeIn>
        </TabsContent>
        <TabsContent value="security">
          <FadeIn className="rounded-xl border bg-card p-6 shadow-card">
            <PasswordForm />
          </FadeIn>
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}
