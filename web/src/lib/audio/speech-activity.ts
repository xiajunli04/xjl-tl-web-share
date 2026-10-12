/**
 * 本机是否正在说话（improve-speech-endpointing-and-live-ux D7，择机开播用）：电平持续超过阈值 ≥ onsetMs 视为开口，
 * 停止后保留 hangoverMs（短暂换气不算说完）。只用现有电平，不在浏览器加载神经网络 VAD。
 */
/** 约 −40 dBFS（levelFromRms），与服务端"识别让路"的静音阈值、麦克风光球的说话态一致 */
export const SPEECH_LEVEL = 0.42;
export const ONSET_MS = 120;
export const HANGOVER_MS = 600;

export class SpeechActivity {
  private aboveSince: number | null = null;
  private lastSpeechAt = Number.NEGATIVE_INFINITY;

  constructor(
    private threshold = SPEECH_LEVEL,
    private onsetMs = ONSET_MS,
    private hangoverMs = HANGOVER_MS,
  ) {}

  /** 每帧调用：level 为 0–1 视觉电平 */
  update(level: number, now: number) {
    if (level >= this.threshold) {
      this.aboveSince ??= now;
      if (now - this.aboveSince >= this.onsetMs) this.lastSpeechAt = now;
    } else {
      this.aboveSince = null;
    }
  }

  speaking(now: number) {
    return now - this.lastSpeechAt <= this.hangoverMs;
  }

  reset() {
    this.aboveSince = null;
    this.lastSpeechAt = Number.NEGATIVE_INFINITY;
  }
}
