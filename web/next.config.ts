import type { NextConfig } from "next";
import { networkInterfaces } from "node:os";

// Permit this machine's LAN addresses without opening development endpoints to arbitrary origins.
const lanOrigins = Object.values(networkInterfaces()).flatMap((entries) =>
  (entries ?? []).filter((entry) => !entry.internal && entry.family === "IPv4").map((entry) => entry.address),
);

const nextConfig: NextConfig = {
  allowedDevOrigins: lanOrigins,
  // 开发角标会遮挡侧边栏底部按钮
  devIndicators: false,
  // 可选的独立输出目录：同一工作区并行跑第二个开发实例（如 mock 模式截图）时设置 NEXT_DIST_DIR=.next-mock，避免争用 .next
  distDir: process.env.NEXT_DIST_DIR || ".next",
  /**
   * 可选的同源代理（默认关闭）：设置 API_PROXY_TARGET=http://localhost:18080，
   * NEXT_PUBLIC_API_BASE_URL 留空时浏览器使用当前页面源，支持 localhost 与局域网联调。
   */
  async rewrites() {
    const target = process.env.API_PROXY_TARGET?.replace(/\/+$/, "");
    return target ? [
      { source: "/api/:path*", destination: `${target}/api/:path*` },
      { source: "/ws/:path*", destination: `${target}/ws/:path*` },
    ] : [];
  },
};

export default nextConfig;
