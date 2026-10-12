import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "译桥 · LinguaBridge",
  applicationName: "译桥 · LinguaBridge",
  description: "译桥 · LinguaBridge — 基于 Agent 的智能翻译平台",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // next-themes 在首屏前注入脚本设置 class，避免闪烁；需要抑制 html 上的 hydration 警告
    <html lang="zh-CN" className="h-full antialiased" suppressHydrationWarning>
      <body className="flex min-h-full flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
