/**
 * 朗读控制器（improve-speech-playback-latency 6.3）：工作台朗读与同传字幕重播共用。
 * - 全局单例：同一时刻只播一段，开始新的朗读会停止当前朗读
 * - 流式：POST /api/speech/tts 的响应边到达边交给 AudioPlayer（mp3 走 MediaSource 渐进播放，pcm16 走 worklet），首包即出声
 * - 三态：loading（首包未到）→ playing → idle；失败（首包前）改用浏览器朗读并提示，首包后中断则播完已收到的部分并提示
 * - 状态以 subscribe / getSnapshot 暴露给 React（useSpeak）
 */
import { toast } from "sonner";
import { speechApi } from "@/lib/api/speech";
import { AudioPlayer, browserSpeechSupported } from "./player";
import type { AudioFormat } from "./queue";

export type SpeakPhase = "idle" | "loading" | "playing";

export interface SpeakState {
  /** 正在朗读的条目 id（调用方自定，如 "target" / "turn:12" / "utt:p1:3"） */
  id: string | null;
  phase: SpeakPhase;
}

export interface SpeakRequest {
  id: string;
  text: string;
  lang: string;
  gender?: "female" | "male";
  rate?: number;
}

/** 朗读接口上限 2000 字符（契约 §2.1） */
export const MAX_TTS_CHARS = 2000;

const IDLE: SpeakState = { id: null, phase: "idle" };

let state: SpeakState = IDLE;
const listeners = new Set<() => void>();
let player: AudioPlayer | null = null;
let token = 0;
let abort: AbortController | null = null;
let endHooks: (() => void)[] = [];

function setState(next: SpeakState) {
  state = next;
  listeners.forEach((fn) => fn());
}

export function subscribeSpeak(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getSpeakState(): SpeakState {
  return state;
}

/** 朗读输出的频谱分析节点（声波电平）；未开始过朗读时为 null */
export function getSpeakAnalyser(): AnalyserNode | null {
  return player?.getOutputAnalyser() ?? null;
}

function ensurePlayer(): AudioPlayer {
  if (!player) {
    player = new AudioPlayer();
    player.queue.onPlayingChange((playing) => {
      if (!playing && state.phase !== "idle" && !abort) finishSpeak();
    });
  }
  return player;
}

function finishSpeak() {
  const hooks = endHooks;
  endHooks = [];
  setState(IDLE);
  hooks.forEach((fn) => fn());
}

/** 停止当前朗读 */
export function stopSpeaking() {
  token++;
  abort?.abort();
  abort = null;
  player?.stop();
  if (state.phase !== "idle") finishSpeak();
}

/** 截断到接口上限（按字符），返回是否截断 */
export function clampTtsText(text: string): { text: string; truncated: boolean } {
  const chars = Array.from(text.trim());
  return chars.length > MAX_TTS_CHARS
    ? { text: chars.slice(0, MAX_TTS_CHARS).join(""), truncated: true }
    : { text: chars.join(""), truncated: false };
}

function formatOf(contentType: string): { format: AudioFormat; sampleRate: number } {
  const type = contentType.toLowerCase();
  if (type.startsWith("audio/l16") || type.includes("pcm")) {
    return { format: "pcm16", sampleRate: Number(/rate=(\d+)/.exec(type)?.[1] ?? 24000) };
  }
  return { format: "mp3", sampleRate: 24000 };
}

/**
 * 开始朗读（须在用户手势中调用，以便解锁音频输出）。返回的 Promise 在朗读结束（播完、被停止或失败）时 resolve。
 * onEnd 在本次朗读结束时调用一次（用于重播结束后恢复实时播报）。
 */
export function speak(req: SpeakRequest, onEnd?: () => void): Promise<void> {
  stopSpeaking();
  const my = ++token;
  const p = ensurePlayer();
  void p.unlock(); // 用户手势内同步解锁
  const { text, truncated } = clampTtsText(req.text);
  if (truncated) toast.info(`仅朗读前 ${MAX_TTS_CHARS} 个字符`);
  const ended = new Promise<void>((resolve) => {
    endHooks.push(resolve);
    if (onEnd) endHooks.push(onEnd);
  });
  setState({ id: req.id, phase: "loading" });
  const ctrl = new AbortController();
  abort = ctrl;
  void run(my, ctrl, p, { ...req, text });
  return ended;
}

async function run(my: number, ctrl: AbortController, p: AudioPlayer, req: SpeakRequest) {
  const utteranceId = `speak-${my}`;
  let got = false;
  try {
    const { stream, headers } = await speechApi.ttsStream(
      { text: req.text, lang: req.lang, gender: req.gender, rate: req.rate },
      ctrl.signal,
    );
    if (my !== token) return;
    const { format, sampleRate } = formatOf(headers.get("Content-Type") ?? "audio/mpeg");
    const meta = { utteranceId, lang: req.lang, format, sampleRate };
    const reader = stream.getReader();
    let carry: Uint8Array | null = null; // pcm16：跨分块的半个采样
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (my !== token) return;
        if (done) break;
        if (!value?.length) continue;
        let bytes = value;
        if (format === "pcm16") {
          if (carry) {
            const merged = new Uint8Array(carry.length + value.length);
            merged.set(carry);
            merged.set(value, carry.length);
            bytes = merged;
            carry = null;
          }
          if (bytes.length % 2) {
            carry = bytes.slice(bytes.length - 1);
            bytes = bytes.subarray(0, bytes.length - 1);
          }
        }
        if (!got) {
          got = true;
          setState({ id: req.id, phase: "playing" });
        }
        p.enqueueBytes(meta, bytes, { last: false });
      }
    } catch (e) {
      if (my !== token || (e as Error)?.name === "AbortError") return;
      if (!got) throw e;
      toast.warning("朗读中断", { description: "语音合成连接中断，已播放收到的部分" });
    }
    abort = null;
    if (!got) throw new Error("语音合成未返回音频");
    p.enqueueBytes(meta, new Uint8Array(0), { last: true });
    if (!p.queue.isPlaying) finishSpeak();
  } catch (e) {
    if (my !== token || (e as Error)?.name === "AbortError") return;
    abort = null;
    fallback(my, p, req, utteranceId);
  }
}

function fallback(my: number, p: AudioPlayer, req: SpeakRequest, utteranceId: string) {
  if (!browserSpeechSupported()) {
    toast.error("朗读失败", { description: "语音合成服务不可用，且当前浏览器不支持朗读" });
    finishSpeak();
    return;
  }
  toast.info("已改用浏览器朗读");
  if (my !== token) return;
  p.setGender(req.gender ?? "female");
  setState({ id: req.id, phase: "playing" });
  p.speakFallback(utteranceId, req.text, req.lang);
}
