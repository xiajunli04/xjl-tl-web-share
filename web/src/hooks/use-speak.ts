"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getSpeakAnalyser, getSpeakState, speak, subscribeSpeak, type SpeakState } from "@/lib/audio/speak";
import { useSpeechPrefs } from "@/stores/speech-prefs";

const IDLE: SpeakState = { id: null, phase: "idle" };

/** 全局朗读状态（improve-speech-playback-latency 6.3）；id 用来判断是不是"我"在朗读 */
export function useSpeakState(): SpeakState {
  return useSyncExternalStore(subscribeSpeak, getSpeakState, () => IDLE);
}

/** 某个条目的朗读阶段：别的条目在朗读时为 idle */
export function useSpeakPhase(id: string) {
  const s = useSpeakState();
  return s.id === id ? s.phase : "idle";
}

interface AutoReadMark {
  scope: string | null;
  doneKey: string | null;
}

/** 是否触发自动朗读：同一作用域（或从 null 变为具体值）内，完成标识变为新的非空值 */
export function shouldAutoRead(before: AutoReadMark | null, next: AutoReadMark): boolean {
  if (!before || !next.doneKey || next.doneKey === before.doneKey) return false;
  return before.scope === next.scope || before.scope === null;
}

/**
 * 完成后自动朗读（improve-speech-playback-latency 7.3）：开启偏好后，同一作用域（scope，如会话 id）内
 * 完成标识 doneKey 变为新的非空值时朗读 text。首次渲染与切换作用域不触发，避免打开历史记录时自动出声；
 * 作用域从 null（新会话尚未创建）变为具体值视为同一作用域（新会话的第一轮）。
 */
export function useAutoRead({
  scope,
  doneKey,
  id,
  text,
  lang,
}: {
  scope: string | null;
  doneKey: string | null;
  id: string;
  text: string;
  lang: string | null | undefined;
}) {
  const prev = useRef<AutoReadMark | null>(null);
  useEffect(() => {
    const before = prev.current;
    prev.current = { scope, doneKey };
    if (!shouldAutoRead(before, { scope, doneKey })) return;
    const { autoRead, gender, rate } = useSpeechPrefs.getState();
    if (!autoRead || !text.trim() || !lang || lang === "auto") return;
    void speak({ id, text, lang, gender, rate });
  }, [scope, doneKey, id, text, lang]);
}

/**
 * 朗读输出电平（0–1，约 30 fps）：active 时从输出总线的 Analyser 读取 RMS，供声波条随声音跳动；
 * 拿不到 Analyser（浏览器朗读）时返回 null，调用方改用循环动画。
 */
export function useSpeakLevel(active: boolean): number | null {
  const [level, setLevel] = useState<number | null>(null);
  const buf = useRef<Float32Array<ArrayBuffer> | null>(null);
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (t - last < 33) return;
      last = t;
      const analyser = getSpeakAnalyser();
      if (!analyser) return setLevel(null);
      if (!buf.current || buf.current.length !== analyser.fftSize) buf.current = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(buf.current);
      let sum = 0;
      for (const v of buf.current) sum += v * v;
      const rms = Math.sqrt(sum / buf.current.length);
      setLevel(Math.min(1, rms * 4));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);
  return active ? level : null;
}
