import { z } from "zod";

// 与后端校验规则保持一致
export const usernameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_]{4,32}$/, "用户名为 4–32 位字母、数字或下划线");

export const passwordSchema = z
  .string()
  .min(8, "密码长度为 8–64 位")
  .max(64, "密码长度为 8–64 位")
  .regex(/^(?=.*[A-Za-z])(?=.*\d).+$/, "密码需同时包含字母和数字");

export const optionalEmail = z.union([z.literal(""), z.email("邮箱格式不正确")]);

export function formatTime(s?: string | null) {
  if (!s) return "-";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString("zh-CN", { hour12: false });
}

/** datetime-local 输入值 -> ISO-8601 带偏移 */
export function toIso(local: string): string | undefined {
  if (!local) return undefined;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
