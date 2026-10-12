"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { isAdmin, useAuthStore } from "@/stores/auth";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const allowed = isAdmin(user);

  useEffect(() => {
    if (user && !allowed) router.replace("/forbidden");
  }, [user, allowed, router]);

  if (!allowed) return null;
  return <>{children}</>;
}
