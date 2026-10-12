/**
 * 仅开发环境可用的 mock 开关（默认关闭；生产构建中恒为 false，相关代码会被摇树移除）。
 * - NEXT_PUBLIC_MOCK_STREAM=1：翻译流使用 docs/contracts/translate-stream-sample.txt 的事件序列离线驱动
 * - NEXT_PUBLIC_MOCK_API=1：REST 接口使用内置样例数据（便于在后端未就绪时自查页面）
 * 注意：动态 import mock 模块的地方（http.ts / api/translate.ts）必须就地写出完整条件，
 * 打包器才能在生产构建中把 if (false) 分支连同 mock chunk 一起移除；这里的常量只用于界面提示。
 */
const isDev = process.env.NODE_ENV !== "production";

export const MOCK_STREAM = isDev && process.env.NEXT_PUBLIC_MOCK_STREAM === "1";
export const MOCK_API = isDev && process.env.NEXT_PUBLIC_MOCK_API === "1";
