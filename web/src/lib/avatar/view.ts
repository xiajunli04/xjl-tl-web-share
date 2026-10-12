/**
 * 构图（rework-avatar-portrait-rig D6）：根据容器比例算出立绘中可见的子矩形（归一化 uv），
 * 着色器与静态立绘（CSS background）共用。
 */
import type { Rect } from "./characters";

/** bust 半身舞台；portrait 头肩（圆形徽章）；face 脸部特写（小头像） */
export type Framing = "bust" | "portrait" | "face";

/**
 * @param imageAspect 立绘宽 / 高
 * @param containerAspect 容器宽 / 高
 * @param face 脸部窗口（归一化）
 */
export function viewRect(framing: Framing, imageAspect: number, containerAspect: number, face: Rect): Rect {
  const fcx = face[0] + face[2] / 2;
  const fcy = face[1] + face[3] / 2;
  // 可见区域的高度（以立绘高度为 1）
  let h: number;
  let cy: number;
  if (framing === "portrait") {
    // 头肩：约 2.2 倍脸窗口（眉到下巴附近）高度，中心略低于脸中心，露出一点肩部
    h = Math.min(1, face[3] * 2.2);
    cy = fcy + face[3] * 0.22;
  } else if (framing === "face") {
    // 脸部特写：1.45 倍脸窗口，中心略高于脸中心（带上一点发型）
    h = Math.min(1, face[3] * 1.45);
    cy = fcy - face[3] * 0.08;
  } else {
    // 半身：整幅高度，容器更"扁"时裁掉下方
    h = 1;
    cy = 0.5;
  }
  // 宽度（立绘宽为 1）：容器比例 × 可见高度 / 立绘比例
  let w = (containerAspect * h) / imageAspect;
  if (w > 1) {
    // 容器更宽：以宽为准，缩小可见高度
    h = h / w;
    w = 1;
    // 半身需要裁高度时从下方裁：头顶（发髻、发饰）完整保留
    if (framing === "bust") cy = h / 2;
  }
  const x = clamp(fcx - w / 2, 0, 1 - w);
  const y = clamp(cy - h / 2, 0, 1 - h);
  return [x, y, w, h];
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(Math.max(v, lo), Math.max(lo, hi));
}

/** 把可见矩形换算成 CSS background-size / background-position（静态立绘与占位用） */
export function backgroundFor(view: Rect): { size: string; position: string } {
  const [x, y, w, h] = view;
  const pos = (start: number, span: number) => (span >= 1 ? 0 : (start / (1 - span)) * 100);
  return {
    size: `${(100 / w).toFixed(3)}% ${(100 / h).toFixed(3)}%`,
    position: `${pos(x, w).toFixed(3)}% ${pos(y, h).toFixed(3)}%`,
  };
}
