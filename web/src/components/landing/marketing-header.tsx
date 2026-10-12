"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { motion, useMotionValueEvent, useReducedMotion, useScroll } from "motion/react";
import { ArrowRightIcon, LayoutDashboardIcon } from "lucide-react";
import { BrandMark } from "@/components/brand/brand-mark";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth";

export const ANCHORS = [
  { id: "demo", label: "演示" },
  { id: "compare", label: "对比" },
  { id: "lumi", label: "Lumi" },
  { id: "features", label: "能力" },
  { id: "data", label: "数据" },
] as const;

const noop = () => () => {};

/**
 * 登录态 CTA：服务端渲染与首次 hydration 统一输出未登录版本，持久化会话恢复后再切换（避免 hydration 不匹配）。
 */
export function useSignedIn() {
  const mounted = useSyncExternalStore(noop, () => true, () => false);
  const hydrated = useAuthStore((s) => s.hydrated);
  const token = useAuthStore((s) => s.accessToken);
  return mounted && hydrated && !!token;
}

export function AuthCta({ size = "default", className }: { size?: "default" | "lg"; className?: string }) {
  const signedIn = useSignedIn();
  const lg = size === "lg";
  if (signedIn) {
    return (
      <Button size={lg ? "lg" : "default"} className={cn("rounded-full", lg && "h-11 px-6 text-base", className)} nativeButton={false} render={<Link href="/translate" />}>
        <LayoutDashboardIcon />
        进入工作台
      </Button>
    );
  }
  return (
    <Button size={lg ? "lg" : "default"} className={cn("group rounded-full", lg && "h-11 px-6 text-base", className)} nativeButton={false} render={<Link href="/register" />}>
      免费开始
      <ArrowRightIcon className="transition-transform group-hover:translate-x-0.5" />
    </Button>
  );
}

/** 平滑滚动到分区（reduced-motion 直接跳转） */
export function scrollToId(id: string, reduce: boolean | null) {
  document.getElementById(id)?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
}

/** 营销页顶栏：滚动超过 8px 后出现毛玻璃与描边 */
export function MarketingHeader() {
  const reduce = useReducedMotion();
  const { scrollY } = useScroll();
  const [scrolled, setScrolled] = useState(false);
  useMotionValueEvent(scrollY, "change", (y) => setScrolled(y > 8));
  const signedIn = useSignedIn();

  return (
    <header
      className={cn(
        "sticky top-0 z-40 border-b border-transparent transition-[background-color,border-color,backdrop-filter] duration-150",
        scrolled && "border-border bg-background/75 backdrop-blur-md supports-backdrop-filter:bg-background/60",
      )}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 md:px-6">
        <Link href="/" className="flex items-center gap-2.5 outline-none">
          <BrandMark decorative />
          <span className="text-sm font-semibold tracking-tight">译桥 · LinguaBridge</span>
        </Link>
        <nav className="ml-4 hidden items-center gap-1 md:flex" aria-label="首页分区">
          {ANCHORS.map((a) => (
            <a
              key={a.id}
              href={`#${a.id}`}
              onClick={(e) => {
                e.preventDefault();
                scrollToId(a.id, reduce);
              }}
              className="rounded-full px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {a.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          {!signedIn && (
            <Button variant="ghost" className="hidden rounded-full sm:inline-flex" nativeButton={false} render={<Link href="/login" />}>
              登录
            </Button>
          )}
          <motion.div layout={!reduce}>
            <AuthCta />
          </motion.div>
        </div>
      </div>
    </header>
  );
}

export function MarketingFooter() {
  return (
    <footer className="border-t">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 text-sm text-muted-foreground md:flex-row md:items-center md:px-6">
        <div className="flex items-center gap-2">
          <BrandMark className="size-6" decorative />
          <span className="font-medium text-foreground">译桥 · LinguaBridge</span>
          <span>· 基于 Agent 的智能翻译</span>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 md:ml-auto">
          <span>本科毕业设计作品</span>
          <span>数字人模型：pixiv VRM 示例（VRM Public License 1.0）</span>
        </div>
      </div>
    </footer>
  );
}
