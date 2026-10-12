import Link from "next/link";
import { ArrowLeftIcon } from "lucide-react";
import { BrandMark } from "@/components/brand/brand-mark";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { FadeIn } from "@/components/motion/fade-in";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen flex-1 items-center justify-center bg-background bg-auth-glow p-4">
      <Link
        href="/"
        className="absolute top-4 left-4 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" />
        返回首页
      </Link>
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <FadeIn initial={false} className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <Link
            href="/"
            aria-label="返回首页"
            className="mb-4 flex size-14 items-center justify-center rounded-2xl transition-transform outline-none hover:scale-105 focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:hover:scale-100"
          >
            <BrandMark className="size-14" decorative />
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">译桥 · LinguaBridge</h1>
          <p className="mt-1 text-sm text-muted-foreground">基于 Agent 的智能翻译 · 分析 → 规划 → 翻译 → 评审</p>
        </div>
        {children}
      </FadeIn>
    </div>
  );
}
