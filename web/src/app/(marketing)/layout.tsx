import { MarketingFooter, MarketingHeader } from "@/components/landing/marketing-header";

/** 营销页外壳（add-ai-avatar-and-landing D8）：粘性顶栏 + 页脚，无侧边栏、不触发登录守卫 */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-1 flex-col bg-background">
      <MarketingHeader />
      <main className="flex-1">{children}</main>
      <MarketingFooter />
    </div>
  );
}
