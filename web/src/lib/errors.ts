import { toast } from "sonner";
import { ApiError } from "@/lib/http";
import type { FieldError } from "@/lib/api/types";

/** 统一错误文案：B/C 类错误附带 traceId；A0410 展示字段错误 */
export function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    let msg = e.message;
    if (e.code === "A0410" && Array.isArray(e.data) && e.data.length) {
      msg += "：" + (e.data as FieldError[]).map((f) => `${f.field} ${f.message}`).join("；");
    }
    if ((e.code.startsWith("B") || e.code.startsWith("C")) && e.traceId) {
      msg += `（traceId: ${e.traceId}）`;
    }
    return msg;
  }
  return e instanceof Error ? e.message : "未知错误";
}

export function toastError(e: unknown) {
  // 令牌失效已触发跳转登录，无需再提示
  if (e instanceof ApiError && ["A0230", "A0231", "A0232"].includes(e.code)) return;
  toast.error(describeError(e));
}
