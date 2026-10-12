/**
 * 半双工门控（design D8）：单设备模式（LISTEN / CONVERSE）未开启耳机模式时，
 * 播报期间暂停上行音频，播报结束 RESUME_DELAY_MS 后恢复。
 */
export const RESUME_DELAY_MS = 300;

export class HalfDuplexGate {
  private enabled: boolean;
  private playing = false;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    enabled: boolean,
    private onChange?: (closed: boolean) => void,
    private delayMs = RESUME_DELAY_MS,
  ) {
    this.enabled = enabled;
  }

  /** 门是否关闭（关闭时不上行） */
  get isClosed() {
    return this.closed;
  }

  /** 启用 / 关闭门控（耳机模式、会议室为关闭） */
  setEnabled(on: boolean) {
    this.enabled = on;
    if (!on) {
      this.clearTimer();
      this.set(false);
    } else if (this.playing) {
      this.set(true);
    }
  }

  /** 播放状态变化 */
  setPlaying(playing: boolean) {
    this.playing = playing;
    if (!this.enabled) return;
    if (playing) {
      this.clearTimer();
      this.set(true);
    } else if (this.closed && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        if (!this.playing) this.set(false);
      }, this.delayMs);
    }
  }

  dispose() {
    this.clearTimer();
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private set(closed: boolean) {
    if (this.closed === closed) return;
    this.closed = closed;
    this.onChange?.(closed);
  }
}
