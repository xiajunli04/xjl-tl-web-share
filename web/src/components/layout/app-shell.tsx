"use client";

import { useState } from "react";
import { useMediaQuery } from "@/hooks/use-media-query";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ChevronRightIcon,
  HouseIcon,
  LogOutIcon,
  MenuIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  UserIcon,
} from "lucide-react";
import { BrandMark } from "@/components/brand/brand-mark";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DURATION, EASE_OUT, SPRING_LAYOUT } from "@/components/motion/tokens";
import { cn } from "@/lib/utils";
import { authApi } from "@/lib/api/auth";
import { isAdmin, useAuthStore } from "@/stores/auth";
import { useUiStore } from "@/stores/ui";
import { NAV_GROUPS, breadcrumbOf, isActive, type NavItem } from "./nav";
import { ThemeToggle } from "./theme-toggle";

const EXPANDED = 248;
const COLLAPSED = 68;

function Logo({ collapsed }: { collapsed: boolean }) {
  return (
    <Link href="/translate" aria-label="译桥 · LinguaBridge · 工作台" className="flex h-14 items-center gap-2.5 px-4 outline-none">
      <BrandMark decorative />
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.span
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: DURATION.fast }}
            className="truncate text-sm font-semibold tracking-tight"
          >
            译桥 · LinguaBridge
          </motion.span>
        )}
      </AnimatePresence>
    </Link>
  );
}

function NavLink({
  item,
  collapsed,
  layoutGroup,
  onNavigate,
}: {
  item: NavItem;
  collapsed: boolean;
  layoutGroup: string;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const active = isActive(item.href, pathname);
  const Icon = item.icon;
  const link = (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex h-9 items-center gap-3 rounded-lg px-3 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
        active
          ? "text-sidebar-accent-foreground"
          : "text-sidebar-foreground/65 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
      )}
    >
      {active && (
        <>
          <motion.span
            layoutId={`${layoutGroup}-bg`}
            className="absolute inset-0 rounded-lg bg-sidebar-accent"
            transition={SPRING_LAYOUT}
          />
          <motion.span
            layoutId={`${layoutGroup}-bar`}
            className="absolute top-1.5 bottom-1.5 -left-3 w-[3px] rounded-r-full bg-brand-gradient"
            transition={SPRING_LAYOUT}
          />
        </>
      )}
      <Icon className={cn("relative size-4 shrink-0", active && "text-brand")} />
      {!collapsed && <span className="relative truncate">{item.label}</span>}
    </Link>
  );
  if (!collapsed) return link;
  return (
    <Tooltip>
      <TooltipTrigger render={link} />
      <TooltipContent side="right" sideOffset={10}>
        {item.label}
      </TooltipContent>
    </Tooltip>
  );
}

function NavGroups({
  collapsed,
  layoutGroup,
  onNavigate,
}: {
  collapsed: boolean;
  layoutGroup: string;
  onNavigate?: () => void;
}) {
  const user = useAuthStore((s) => s.user);
  const admin = isAdmin(user);
  return (
    <nav className="flex flex-col gap-5 px-3">
      {NAV_GROUPS.filter((g) => !g.adminOnly || admin).map((g) => (
        <div key={g.key} className="flex flex-col gap-0.5">
          <div className="flex h-6 items-center px-3 text-[11px] font-medium tracking-wider text-muted-foreground/80 uppercase">
            {collapsed ? <span className="mx-auto h-px w-4 bg-border" /> : g.label}
          </div>
          {g.items.map((item) => (
            <NavLink
              key={item.href}
              item={item}
              collapsed={collapsed}
              layoutGroup={layoutGroup}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      ))}
    </nav>
  );
}

function Breadcrumb() {
  const pathname = usePathname();
  const crumb = breadcrumbOf(pathname);
  if (!crumb) return null;
  return (
    <nav aria-label="面包屑" className="flex min-w-0 items-center gap-1.5 text-sm">
      <span className="text-muted-foreground">{crumb.group}</span>
      <ChevronRightIcon className="size-3.5 text-muted-foreground/60" />
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={crumb.label}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: DURATION.fast, ease: EASE_OUT }}
          className="truncate font-medium text-foreground"
        >
          {crumb.label}
        </motion.span>
      </AnimatePresence>
    </nav>
  );
}

function initials(name: string) {
  return name.trim().slice(0, 1).toUpperCase() || "U";
}

function UserMenu() {
  const router = useRouter();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const refreshToken = useAuthStore((s) => s.refreshToken);
  const clear = useAuthStore((s) => s.clear);
  const name = user?.nickname || user?.username || "用户";

  const logout = async () => {
    try {
      await authApi.logout({ refreshToken: refreshToken ?? undefined });
    } catch {
      // 忽略：本地会话无论如何都会被清空
    }
    clear();
    qc.clear();
    router.replace("/login");
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="flex items-center gap-2 rounded-full py-1 pr-2.5 pl-1 text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        }
      >
        <span className="flex size-7 items-center justify-center rounded-full bg-brand-gradient text-xs font-semibold text-brand-foreground">
          {initials(name)}
        </span>
        <span className="hidden max-w-32 truncate font-medium sm:inline">{name}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-0.5 py-2">
            <span className="text-sm font-medium text-foreground">{name}</span>
            <span className="text-xs font-normal">
              @{user?.username} · {isAdmin(user) ? "管理员" : "普通用户"}
            </span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => router.push("/profile")}>
          <UserIcon />
          个人中心
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => router.push("/")}>
          <HouseIcon />
          访问首页
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={logout}>
          <LogOutIcon />
          退出登录
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pinnedCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const togglePinned = useUiStore((s) => s.toggleSidebar);
  const reduce = useReducedMotion();
  const [mobileOpen, setMobileOpen] = useState(false);
  // 768–1279px（平板 / 小屏笔记本）默认收成图标栏，给内容让出空间；可临时展开，导航后自动收起
  const roomy = useMediaQuery("(min-width: 1280px)");
  const [railOpen, setRailOpen] = useState(false);
  const collapsed = roomy ? pinnedCollapsed : !railOpen;
  const toggle = () => (roomy ? togglePinned() : setRailOpen((o) => !o));

  // 高度：100vh 兜底，支持动态视口单位时用 dvh（避免不支持 dvh 的浏览器里整页被内容撑出屏幕）
  return (
    <div className="flex h-screen w-full shrink-0 overflow-hidden bg-background supports-[height:100dvh]:h-dvh">
      <motion.aside
        initial={false}
        animate={{ width: collapsed ? COLLAPSED : EXPANDED }}
        transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
        className="relative hidden shrink-0 flex-col border-r bg-sidebar md:flex"
      >
        <Logo collapsed={collapsed} />
        <div className="scrollbar-thin flex-1 overflow-x-hidden overflow-y-auto py-3">
          <NavGroups collapsed={collapsed} layoutGroup="nav" onNavigate={roomy ? undefined : () => setRailOpen(false)} />
        </div>
        <div className="border-t p-3">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size={collapsed ? "icon" : "default"}
                  onClick={toggle}
                  aria-label={collapsed ? "展开侧边栏" : "折叠侧边栏"}
                  className={cn("text-muted-foreground", collapsed ? "mx-auto flex" : "w-full justify-start gap-3 px-3")}
                />
              }
            >
              {collapsed ? <PanelLeftOpenIcon /> : <PanelLeftCloseIcon />}
              {!collapsed && <span>折叠侧边栏</span>}
            </TooltipTrigger>
            {collapsed && (
              <TooltipContent side="right" sideOffset={10}>
                展开侧边栏
              </TooltipContent>
            )}
          </Tooltip>
        </div>
      </motion.aside>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-72 bg-sidebar sm:max-w-72">
          <SheetTitle className="sr-only">导航</SheetTitle>
          <Logo collapsed={false} />
          <div className="py-3">
            <NavGroups collapsed={false} layoutGroup="mnav" onNavigate={() => setMobileOpen(false)} />
          </div>
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur supports-backdrop-filter:bg-background/60 md:px-6">
          <Button
            variant="ghost"
            size="icon-sm"
            className="md:hidden"
            aria-label="打开导航"
            onClick={() => setMobileOpen(true)}
          >
            <MenuIcon />
          </Button>
          <Breadcrumb />
          <div className="ml-auto flex items-center gap-3">
            <ThemeToggle />
            <UserMenu />
          </div>
        </header>
        <main className="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
