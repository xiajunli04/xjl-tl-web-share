"use client";

import { Suspense } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { LogInIcon, ScrollTextIcon } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageContainer, PageHeader } from "@/components/layout/common";
import { TableSkeleton } from "@/components/feedback/skeletons";
import { LoginLogsTab } from "@/components/admin/login-logs-tab";
import { OperationLogsTab } from "@/components/admin/operation-logs-tab";

function LogsTabs() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const tab = params.get("tab") === "operation" ? "operation" : "login";
  return (
    <Tabs
      value={tab}
      onValueChange={(v) => router.replace(`${pathname}?tab=${String(v)}`, { scroll: false })}
      className="gap-4"
    >
      <TabsList>
        <TabsTrigger value="login">
          <LogInIcon />
          登录日志
        </TabsTrigger>
        <TabsTrigger value="operation">
          <ScrollTextIcon />
          操作日志
        </TabsTrigger>
      </TabsList>
      <TabsContent value="login">
        <LoginLogsTab />
      </TabsContent>
      <TabsContent value="operation">
        <OperationLogsTab />
      </TabsContent>
    </Tabs>
  );
}

/** 日志：一个页面两个标签页（登录 / 操作） */
export default function LogsPage() {
  return (
    <PageContainer>
      <PageHeader title="日志" description="登录尝试与管理员写操作的审计记录" icon={ScrollTextIcon} />
      <Suspense fallback={<TableSkeleton rows={8} cols={5} />}>
        <LogsTabs />
      </Suspense>
    </PageContainer>
  );
}
