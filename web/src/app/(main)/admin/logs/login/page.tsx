import { redirect } from "next/navigation";

/** 旧路由兼容：日志已合并为一个页面的两个标签页 */
export default function LoginLogsRedirect() {
  redirect("/admin/logs?tab=login");
}
