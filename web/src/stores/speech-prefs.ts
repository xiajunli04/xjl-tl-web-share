"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type SpeechGender = "female" | "male";

/** 朗读语速档位（improve-speech-playback-latency 7.1） */
export const SPEECH_RATES = [0.8, 1, 1.2] as const;
export type SpeechRate = (typeof SPEECH_RATES)[number];

interface SpeechPrefsState {
  gender: SpeechGender;
  rate: SpeechRate;
  /** 翻译完成后自动朗读译文（缺省关闭） */
  autoRead: boolean;
  setGender: (g: SpeechGender) => void;
  setRate: (r: SpeechRate) => void;
  setAutoRead: (on: boolean) => void;
}

/** 校正本地恢复的偏好（非法值回到缺省） */
export function sanitizeSpeechPrefs(persisted: unknown): Pick<SpeechPrefsState, "gender" | "rate" | "autoRead"> {
  const p = (persisted ?? {}) as Partial<SpeechPrefsState>;
  return {
    gender: p.gender === "male" ? "male" : "female",
    rate: SPEECH_RATES.includes(p.rate as SpeechRate) ? (p.rate as SpeechRate) : 1,
    autoRead: p.autoRead === true,
  };
}

export const persistSpeechPrefs = (s: SpeechPrefsState) => ({ gender: s.gender, rate: s.rate, autoRead: s.autoRead });

/** 朗读偏好（本地持久化）：音色性别、语速、完成后自动朗读 */
export const useSpeechPrefs = create<SpeechPrefsState>()(
  persist(
    (set) => ({
      gender: "female",
      rate: 1,
      autoRead: false,
      setGender: (gender) => set({ gender }),
      setRate: (rate) => set({ rate }),
      setAutoRead: (autoRead) => set({ autoRead }),
    }),
    {
      name: "tl-speech",
      partialize: persistSpeechPrefs,
      version: 1,
      merge: (persisted, current) => ({ ...current, ...sanitizeSpeechPrefs(persisted) }),
    },
  ),
);
