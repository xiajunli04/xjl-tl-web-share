"use client";

import { useMemo } from "react";
import type { AvatarSignals } from "@/components/avatar/types";
import { interpretRuntime } from "@/hooks/use-interpret-socket";
import { awaitingReply } from "@/lib/interpret/reducer";
import { deriveAvatarState, type AvatarState } from "@/lib/avatar/state";
import { useInterpretStore } from "@/stores/interpret-store";

/**
 * 同传中的数字人输入（add-ai-avatar-and-landing D2）：状态由 store 派生（只在状态变化时重渲染），
 * 电平与口型数据以函数形式逐帧读取。
 */
export function useInterpretAvatar(): { state: AvatarState; signals: AvatarSignals } {
  const state = useInterpretStore((s) =>
    deriveAvatarState({
      error: s.connection === "reconnecting" || s.connection === "failed" || !!s.live.error?.fatal,
      playing: s.playing,
      awaitingReply: awaitingReply(s.live, s.join?.mode),
      micLevel: s.level,
      muted: s.muted,
      gated: s.gated,
    }),
  );
  const signals = useMemo<AvatarSignals>(
    () => ({
      micLevel: interpretRuntime.micLevel,
      analyser: interpretRuntime.outputAnalyser,
      pseudoSpeaking: interpretRuntime.speakingWithBrowser,
    }),
    [],
  );
  return { state, signals };
}
