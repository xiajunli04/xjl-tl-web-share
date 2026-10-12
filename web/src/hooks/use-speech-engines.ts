"use client";

import { useQuery } from "@tanstack/react-query";
import { SPEECH_ENGINES_QUERY_KEY, speechApi } from "@/lib/api/speech";

/** 语音引擎列表（asr / tts / interpret / image），1 分钟内复用 */
export function useSpeechEngines() {
  return useQuery({
    queryKey: SPEECH_ENGINES_QUERY_KEY,
    queryFn: () => speechApi.engines(),
    staleTime: 60_000,
    retry: false,
  });
}
