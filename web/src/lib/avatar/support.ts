/**
 * 数字人降级判定（rework-avatar-portrait-rig D5）：
 * 用户偏好"静态" / reduced-motion / 不支持 WebGL / 资源加载失败 / 帧率过低 → 静态立绘，不加载 WebGL 渲染器。
 */

export type AvatarStyle = "live" | "static";
export type AvatarRender = "live" | "static";

/** 旧版偏好值（VRM 时代的 "3d" / "simple"）兼容映射 */
export function normalizeStyle(v: unknown): AvatarStyle {
  return v === "static" || v === "simple" ? "static" : "live";
}

export interface AvatarEnv {
  style: AvatarStyle;
  reducedMotion: boolean;
  webgl: boolean;
  loadFailed?: boolean;
  lowFps?: boolean;
}

export function avatarRender(env: AvatarEnv): AvatarRender {
  if (env.style === "static" || env.reducedMotion || !env.webgl || env.loadFailed || env.lowFps) return "static";
  return "live";
}

/** 降级原因（用于一次性提示与读屏说明）；不降级时为 null */
export function fallbackReason(env: AvatarEnv): string | null {
  if (env.style === "static") return null; // 用户主动选择，不提示
  if (env.reducedMotion) return "系统开启了减少动效，数字人改为静态形象";
  if (!env.webgl) return "当前浏览器不支持 WebGL，数字人改为静态形象";
  if (env.loadFailed) return "数字人资源加载失败，已改为静态形象";
  if (env.lowFps) return "设备性能不足，数字人已切换为静态形象";
  return null;
}

let webglCache: boolean | null = null;

/** 探测 WebGL2 / WebGL（结果缓存；服务端恒为 false） */
export function supportsWebGL(): boolean {
  if (typeof document === "undefined") return false;
  if (webglCache !== null) return webglCache;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    webglCache = !!gl;
    (gl as WebGLRenderingContext | null)?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    webglCache = false;
  }
  return webglCache;
}

/**
 * 帧率监测：连续 windowSec 秒平均帧率低于 minFps 时返回 true（每帧调用 tick(dt)）。
 * 前 warmupSec 秒不计（模型解析、着色器编译会让首几帧很慢，不代表设备性能）。
 */
export function createFpsMonitor(minFps = 24, windowSec = 2, warmupSec = 3) {
  let warm = 0;
  let elapsed = 0;
  let frames = 0;
  let tripped = false;
  return {
    tick(dt: number): boolean {
      if (tripped) return true;
      if (warm < warmupSec) {
        warm += dt;
        return false;
      }
      elapsed += dt;
      frames += 1;
      if (elapsed >= windowSec) {
        tripped = frames / elapsed < minFps;
        elapsed = 0;
        frames = 0;
      }
      return tripped;
    },
  };
}
