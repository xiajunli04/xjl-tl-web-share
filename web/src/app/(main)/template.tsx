import { PageTransition } from "@/components/motion/page-transition";

/** 路由切换动效：template 在一级路由变化时重新挂载 */
export default function MainTemplate({ children }: { children: React.ReactNode }) {
  return <PageTransition>{children}</PageTransition>;
}
