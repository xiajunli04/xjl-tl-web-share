/**
 * 数字人状态机（add-ai-avatar-and-landing D2）：纯函数，按优先级判定五种状态。
 * error > speaking > thinking > listening > idle
 */

export type AvatarState = "idle" | "listening" | "thinking" | "speaking" | "error";

export interface AvatarInput {
  /** 致命错误或连接断开 */
  error?: boolean;
  /** 正在播放 AI 语音（播报队列非空） */
  playing?: boolean;
  /** 用户语句已定稿、回复或译文首包未到 */
  awaitingReply?: boolean;
  /** 麦克风电平 0–1 */
  micLevel?: number;
  muted?: boolean;
  /** 半双工门控关闭（播报中暂停收音） */
  gated?: boolean;
}

/** 麦克风电平高于该值视为用户在说话（与 LevelOrb 的说话判定一致） */
export const LISTEN_THRESHOLD = 0.42;

export function deriveAvatarState(input: AvatarInput): AvatarState {
  if (input.error) return "error";
  if (input.playing) return "speaking";
  if (input.awaitingReply) return "thinking";
  if (!input.muted && !input.gated && (input.micLevel ?? 0) > LISTEN_THRESHOLD) return "listening";
  return "idle";
}

/** 读屏与状态说明文案 */
export const AVATAR_STATE_LABEL: Record<AvatarState, string> = {
  idle: "在这里",
  listening: "正在倾听",
  thinking: "正在思考",
  speaking: "正在说话",
  error: "连接出了点问题",
};

/** 状态切换的权重插值时长（秒） */
export const STATE_BLEND_SECONDS = 0.25;

/**
 * 每帧向目标权重靠近（指数平滑），dt 秒内约完成 1 - e^(-dt/τ) 的过渡；
 * τ 取 STATE_BLEND_SECONDS / 3，使 250 ms 内完成约 95%。
 */
export function approach(current: number, target: number, dt: number, seconds = STATE_BLEND_SECONDS): number {
  const tau = seconds / 3;
  const k = 1 - Math.exp(-Math.max(0, dt) / tau);
  return current + (target - current) * k;
}
