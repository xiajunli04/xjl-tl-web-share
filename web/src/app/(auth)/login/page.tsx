"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/layout/common";
import { authApi } from "@/lib/api/auth";
import { describeError } from "@/lib/errors";
import { safeRedirect } from "@/lib/redirect";
import { useAuthStore } from "@/stores/auth";

const schema = z.object({
  username: z.string().min(1, "请输入用户名"),
  password: z.string().min(1, "请输入密码"),
});
type FormValues = z.infer<typeof schema>;

/** 仅允许站内相对路径，防止开放重定向 */

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const setSession = useAuthStore((s) => s.setSession);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const onSubmit = async (v: FormValues) => {
    try {
      const r = await authApi.login(v);
      setSession(r);
      toast.success("登录成功");
      router.replace(safeRedirect(params.get("redirect")));
    } catch (e) {
      toast.error(describeError(e));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>登录</CardTitle>
      </CardHeader>
      <form onSubmit={handleSubmit(onSubmit)} noValidate>
        <CardContent className="grid gap-4">
          <Field label="用户名" htmlFor="username" error={errors.username?.message}>
            <Input id="username" autoComplete="username" {...register("username")} />
          </Field>
          <Field label="密码" htmlFor="password" error={errors.password?.message}>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              {...register("password")}
            />
          </Field>
        </CardContent>
        <CardFooter className="mt-4 flex flex-col gap-3">
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? "登录中…" : "登录"}
          </Button>
          <p className="text-sm text-muted-foreground">
            还没有账号？
            <Link href="/register" className="text-primary hover:underline">
              立即注册
            </Link>
          </p>
        </CardFooter>
      </form>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
