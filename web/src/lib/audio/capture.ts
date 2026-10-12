/**
 * 麦克风采集封装（design D8 / D15）：
 * getUserMedia（回声消除 / 降噪 / 自动增益）→ AudioWorklet（pcm-capture.js）→ 16 kHz PCM16 每 40 ms 一帧 + RMS。
 */
import { FRAME_MS, FRAME_SAMPLES } from "./pcm";

export type MicErrorKind = "denied" | "nodevice" | "busy" | "unsupported";

export class MicrophoneError extends Error {
  constructor(
    public kind: MicErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "MicrophoneError";
  }
}

export interface CaptureFrame {
  /** PCM16 / 16 kHz / 单声道，640 样本 */
  pcm: Int16Array;
  /** 帧 RMS（0–1） */
  rms: number;
}

export interface CaptureHandle {
  stop: () => Promise<void>;
  /** 是否为模拟采集（mock 模式） */
  simulated: boolean;
}

export interface CaptureOptions {
  onFrame: (frame: CaptureFrame) => void;
}

export const MIC_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

export const CAPTURE_WORKLET_URL = "/worklets/pcm-capture.js";

/** 把 getUserMedia 的异常归类为 MicrophoneError */
export function toMicrophoneError(e: unknown): MicrophoneError {
  if (e instanceof MicrophoneError) return e;
  const name = (e as { name?: string } | null)?.name ?? "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
    case "PermissionDeniedError":
      return new MicrophoneError("denied", "麦克风权限被拒绝");
    case "NotFoundError":
    case "OverconstrainedError":
    case "DevicesNotFoundError":
      return new MicrophoneError("nodevice", "没有找到可用的麦克风");
    case "NotReadableError":
    case "AbortError":
    case "TrackStartError":
      return new MicrophoneError("busy", "麦克风被其他程序占用");
    default:
      return new MicrophoneError("unsupported", "当前浏览器不支持录音（需要 HTTPS 或 localhost）");
  }
}

/** 开始采集真实麦克风 */
export async function startCapture({ onFrame }: CaptureOptions): Promise<CaptureHandle> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined") {
    throw new MicrophoneError("unsupported", "当前浏览器不支持录音（需要 HTTPS 或 localhost）");
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
  } catch (e) {
    throw toMicrophoneError(e);
  }
  const ctx = new AudioContext();
  try {
    await ctx.audioWorklet.addModule(CAPTURE_WORKLET_URL);
    if (ctx.state === "suspended") await ctx.resume();
  } catch {
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
    throw new MicrophoneError("unsupported", "音频处理模块加载失败");
  }
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "pcm-capture", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
  // 输出静音接到 destination，保证处理图被持续拉取
  const sink = ctx.createGain();
  sink.gain.value = 0;
  node.port.onmessage = (e: MessageEvent<{ type: string; pcm: ArrayBuffer; rms: number }>) => {
    if (e.data?.type === "frame") onFrame({ pcm: new Int16Array(e.data.pcm), rms: e.data.rms });
  };
  source.connect(node);
  node.connect(sink).connect(ctx.destination);

  let stopped = false;
  return {
    simulated: false,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      node.port.postMessage({ type: "stop" });
      node.port.onmessage = null;
      try {
        source.disconnect();
        node.disconnect();
      } catch {
        // 已断开
      }
      stream.getTracks().forEach((t) => t.stop());
      await ctx.close().catch(() => undefined);
    },
  };
}

/**
 * 模拟采集（mock 模式 / 无麦克风环境演示）：每 40 ms 产出一帧静音 PCM，RMS 由 level() 给出。
 */
export function startSimulatedCapture({
  onFrame,
  level,
}: CaptureOptions & { level: () => number }): CaptureHandle {
  const timer = setInterval(() => {
    onFrame({ pcm: new Int16Array(FRAME_SAMPLES), rms: Math.max(0, Math.min(1, level())) });
  }, FRAME_MS);
  return {
    simulated: true,
    stop: async () => clearInterval(timer),
  };
}
