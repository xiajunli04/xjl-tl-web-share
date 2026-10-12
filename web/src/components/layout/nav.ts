import {
  BookMarkedIcon,
  BrainCircuitIcon,
  CpuIcon,
  FileTextIcon,
  HistoryIcon,
  LanguagesIcon,
  MicIcon,
  ScanTextIcon,
  ScrollTextIcon,
  ServerCogIcon,
  UserCogIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export interface NavGroup {
  key: string;
  label: string;
  adminOnly?: boolean;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    key: "translate",
    label: "翻译",
    items: [
      { href: "/translate", label: "翻译工作台", icon: LanguagesIcon },
      { href: "/interpret", label: "同声传译", icon: MicIcon },
      { href: "/image", label: "图片翻译", icon: ScanTextIcon },
      { href: "/documents", label: "文档翻译", icon: FileTextIcon },
      { href: "/history", label: "翻译历史", icon: HistoryIcon },
      { href: "/glossaries", label: "术语库", icon: BookMarkedIcon },
      { href: "/memory", label: "翻译记忆", icon: BrainCircuitIcon },
    ],
  },
  {
    key: "admin",
    label: "管理",
    adminOnly: true,
    items: [
      { href: "/admin/users", label: "用户管理", icon: UsersIcon },
      { href: "/admin/model-configs", label: "模型配置", icon: CpuIcon },
      { href: "/admin/logs", label: "日志", icon: ScrollTextIcon },
      { href: "/admin/system", label: "系统状态", icon: ServerCogIcon },
    ],
  },
];

const EXTRA: { href: string; group: string; label: string; icon: LucideIcon }[] = [
  { href: "/profile", group: "账户", label: "个人中心", icon: UserCogIcon },
];

export function isActive(href: string, pathname: string) {
  return pathname === href || pathname.startsWith(href + "/");
}

/** 当前路由对应的面包屑：[分组, 页面] */
export function breadcrumbOf(pathname: string): { group: string; label: string } | null {
  for (const g of NAV_GROUPS) {
    const item = g.items.find((i) => isActive(i.href, pathname));
    if (item) return { group: g.label, label: item.label };
  }
  const extra = EXTRA.find((e) => isActive(e.href, pathname));
  return extra ? { group: extra.group, label: extra.label } : null;
}
