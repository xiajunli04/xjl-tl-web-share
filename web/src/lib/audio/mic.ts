/**
 * 打开麦克风：生产环境始终走真实采集；mock 模式（NEXT_PUBLIC_MOCK_API=1）默认使用模拟采集，
 * 便于无麦克风 / 无头浏览器演示与截图：
 * - `?mic=denied` 模拟权限被拒
 * - `?mic=real` 使用真实麦克风
 */
import { MicrophoneError, startCapture, startSimulatedCapture, type CaptureFrame, type CaptureHandle } from "./capture";

/** 类语音的模拟 RMS：音节式起伏 + 短暂停顿 */
export function createSpeechLikeLevel(): () => number {
  let t = 0;
  return () => {
    t += 1;
    const syllable = Math.abs(Math.sin(t * 0.45)) * 0.12;
    const pause = t % 60 > 50 ? 0.1 : 1;
    return 0.002 + (syllable + Math.random() * 0.04) * pause;
  };
}

export async function openMicrophone(
  onFrame: (f: CaptureFrame) => void,
  simulatedLevel?: () => number,
): Promise<CaptureHandle> {
  if (process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_MOCK_API === "1") {
    const mic = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("mic") : null;
    if (mic === "denied") {
      await new Promise((r) => setTimeout(r, 300));
      throw new MicrophoneError("denied", "麦克风权限被拒绝");
    }
    if (mic !== "real") return startSimulatedCapture({ onFrame, level: simulatedLevel ?? createSpeechLikeLevel() });
  }
  return startCapture({ onFrame });
}
