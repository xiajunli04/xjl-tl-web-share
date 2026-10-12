"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
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
import { optionalEmail, passwordSchema, usernameSchema } from "@/lib/validators";

const schema = z
  .object({
    username: usernameSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
    nickname: z.string().max(32, "昵称最多 32 个字符"),
    email: optionalEmail,
  })
  .refine((v) => v.password === v.confirmPassword, {
    path: ["confirmPassword"],
    message: "两次输入的密码不一致",
  });
type FormValues = z.infer<typeof schema>;

export default function RegisterPage() {
  const router = useRouter();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { username: "", password: "", confirmPassword: "", nickname: "", email: "" },
  });

  const onSubmit = async (v: FormValues) => {
    try {
      await authApi.register({
        username: v.username,
        password: v.password,
        nickname: v.nickname || undefined,
        email: v.email || undefined,
      });
      toast.success("注册成功，请登录");
      router.replace("/login");
    } catch (e) {
      toast.error(describeError(e));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>注册</CardTitle>
      </CardHeader>
      <form onSubmit={handleSubmit(onSubmit)} noValidate>
        <CardContent className="grid gap-4">
          <Field
            label="用户名"
            htmlFor="username"
            error={errors.username?.message}
            hint="4–32 位字母、数字或下划线"
          >
            <Input id="username" autoComplete="username" {...register("username")} />
          </Field>
          <Field
            label="密码"
            htmlFor="password"
            error={errors.password?.message}
            hint="8–64 位，需同时包含字母和数字"
          >
            <Input id="password" type="password" autoComplete="new-password" {...register("password")} />
          </Field>
          <Field label="确认密码" htmlFor="confirmPassword" error={errors.confirmPassword?.message}>
            <Input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              {...register("confirmPassword")}
            />
          </Field>
          <Field label="昵称（可选）" htmlFor="nickname" error={errors.nickname?.message}>
            <Input id="nickname" {...register("nickname")} />
          </Field>
          <Field label="邮箱（可选）" htmlFor="email" error={errors.email?.message}>
            <Input id="email" type="email" {...register("email")} />
          </Field>
        </CardContent>
        <CardFooter className="mt-4 flex flex-col gap-3">
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? "提交中…" : "注册"}
          </Button>
          <p className="text-sm text-muted-foreground">
            已有账号？
            <Link href="/login" className="text-primary hover:underline">
              去登录
            </Link>
          </p>
        </CardFooter>
      </form>
    </Card>
  );
}
