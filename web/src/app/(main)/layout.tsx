"use client";

import { useEffect, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { BrandMark } from "@/components/brand/brand-mark";
import { AppShell } from "@/components/layout/app-shell";
import { authApi } from "@/lib/api/auth";
import { useAuthStore } from "@/stores/auth";

const noop = () => () => {};

export default function MainLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const storeHydrated = useAuthStore((s) => s.hydrated);
  // 服务端与首次客户端渲染保持一致，避免 hydration 不匹配
  const mounted = useSyncExternalStore(noop, () => true, () => false);
  const hydrated = mounted && storeHydrated;
  const token = useAuthStore((s) => s.accessToken);
  const setUser = useAuthStore((s) => s.setUser);

  // 等待持久化会话恢复后再判断，避免误跳转
  useEffect(() => {
    if (hydrated && !token) {
      const search = typeof window !== "undefined" ? window.location.search : "";
      router.replace(`/login?redirect=${encodeURIComponent(pathname + search)}`);
    }
  }, [hydrated, token, pathname, router]);

  // 同步最新的用户信息与角色
  const me = useQuery({
    queryKey: ["auth", "me"],
    queryFn: authApi.me,
    enabled: hydrated && !!token,
  });
  useEffect(() => {
    if (me.data) setUser(me.data);
  }, [me.data, setUser]);

  if (!hydrated || !token) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <span className="relative flex size-10 items-center justify-center">
          <span className="absolute inset-0 animate-pulse-ring rounded-xl bg-brand/30 motion-reduce:hidden" />
          <BrandMark className="relative size-10" decorative />
        </span>
        正在恢复会话…
      </div>
    );
  }
  return <AppShell>{children}</AppShell>;
}
