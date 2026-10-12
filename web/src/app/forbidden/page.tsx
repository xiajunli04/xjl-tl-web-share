import Link from "next/link";
import { ShieldAlertIcon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";

export default function ForbiddenPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 bg-auth-glow p-6 text-center">
      <span className="flex size-14 items-center justify-center rounded-2xl bg-danger-soft text-danger ring-1 ring-danger/20">
        <ShieldAlertIcon className="size-7" />
      </span>
      <div className="text-5xl font-semibold tracking-tight text-muted-foreground">403</div>
      <h1 className="text-lg font-medium">无访问权限</h1>
      <p className="text-sm text-muted-foreground">您没有权限访问该页面，请联系管理员。</p>
      <Link href="/translate" className={buttonVariants({ variant: "outline" })}>
        返回工作台
      </Link>
    </div>
  );
}
