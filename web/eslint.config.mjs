import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    // 并行开发实例 / 独立构建的输出目录（NEXT_DIST_DIR，见 next.config.ts）
    ".next-*/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 本地自查截图与脚本（已加入 .gitignore）
    ".screenshots/**",
  ]),
]);

export default eslintConfig;
