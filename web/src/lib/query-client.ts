import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/http";

let client: QueryClient | null = null;

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        refetchOnWindowFocus: false,
        // 业务错误（A 类）不重试
        retry: (count, e) => !(e instanceof ApiError && e.code.startsWith("A")) && count < 1,
      },
    },
  });
}

/** 浏览器端单例 QueryClient（供 Providers 与非 React 代码共享，例如翻译完成后让历史失效） */
export function getQueryClient(): QueryClient {
  // 服务端渲染时每次新建，避免跨请求共享缓存
  if (typeof window === "undefined") return makeClient();
  if (!client) client = makeClient();
  return client;
}
