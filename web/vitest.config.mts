import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // 只统计逻辑层（数据、SSE、状态归约、hooks）；UI 组件以截图与走查验证
      include: ["src/lib/**/*.ts", "src/hooks/**/*.ts"],
      exclude: ["src/lib/mock/**", "src/**/*.test.ts", "src/lib/__tests__/**"],
      reporter: ["text-summary", "json-summary", "html"],
      reportsDirectory: "coverage",
    },
  },
});
