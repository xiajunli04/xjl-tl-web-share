/** 登录后的缺省去向：工作台（根路径 / 是公开的产品首页） */
export const DEFAULT_AFTER_LOGIN = "/translate";

/** 只接受站内相对路径（防开放重定向）；缺省或不安全时进入工作台 */
export function safeRedirect(r: string | null | undefined): string {
  return r && r.startsWith("/") && !r.startsWith("//") && !r.startsWith("/\\") ? r : DEFAULT_AFTER_LOGIN;
}
