import { PageTransition } from "@/components/motion/page-transition";

/** 管理后台内部页面之间切换时同样播放路由动效 */
export default function AdminTemplate({ children }: { children: React.ReactNode }) {
  return <PageTransition>{children}</PageTransition>;
}
