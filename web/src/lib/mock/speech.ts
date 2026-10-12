/**
 * 语音接口 mock（NEXT_PUBLIC_MOCK_API=1）：引擎列表、听写；朗读固定返回 C0172，演示浏览器朗读兜底。
 */
import { ApiError, type RequestOptions } from "@/lib/http";
import type { EngineInfo, SpeechEngines, TranscribeResult } from "@/lib/api/speech";

const ALL = ["zh", "en", "ja", "ko", "fr", "de", "es", "ru", "pt", "it", "ar", "th", "vi", "id", "tr"];

function engine(e: Partial<EngineInfo> & Pick<EngineInfo, "id" | "type" | "name" | "vendor">): EngineInfo {
  return { kind: "builtin", available: true, reason: null, languages: ALL, modelConfigId: null, ...e };
}

export const MOCK_ENGINES: SpeechEngines = {
  asr: [
    engine({ id: "local-sensevoice", type: "asr", name: "本地 SenseVoice", vendor: "FunAudioLLM", languages: ["zh", "en", "ja", "ko", "yue"] }),
    engine({ id: "openai-transcribe", type: "asr", name: "Whisper 转写", vendor: "OpenAI 兼容", kind: "config", modelConfigId: 21 }),
  ],
  tts: [
    engine({ id: "edge-tts", type: "tts", name: "Edge 神经语音", vendor: "Microsoft" }),
    engine({ id: "openai-speech", type: "tts", name: "OpenAI 语音合成", vendor: "OpenAI 兼容", kind: "config", available: false, reason: "未配置语音合成模型" }),
    engine({ id: "browser", type: "tts", name: "浏览器朗读", vendor: "Web Speech" }),
  ],
  interpret: [
    engine({ id: "cascade", type: "interpret", name: "平台级联", vendor: "本平台", s2s: false, maxTargets: 5, autoConverse: true, languages: ["zh", "en", "ja", "ko"] }),
    engine({ id: "qwen-livetranslate", type: "interpret", name: "千问同传", vendor: "阿里百炼", kind: "config", modelConfigId: 12, s2s: true, maxTargets: 3, autoConverse: false }),
    engine({ id: "gemini-live-translate", type: "interpret", name: "Gemini 同传", vendor: "Google", kind: "config", available: false, reason: "未配置 Gemini 密钥", s2s: true, maxTargets: 3, autoConverse: false }),
    engine({ id: "openai-realtime", type: "interpret", name: "OpenAI 同传", vendor: "OpenAI", kind: "config", available: false, reason: "未配置 OpenAI 实时同传", s2s: true, maxTargets: 3, autoConverse: false, languages: ["zh", "en", "ja", "ko", "fr", "de", "es", "ru", "pt", "it", "vi", "id"] }),
  ],
  image: [
    engine({ id: "vision", type: "image", name: "视觉识别 + 平台翻译", vendor: "本平台", kind: "config", modelConfigId: 2 }),
    engine({ id: "qwen-mt-image", type: "image", name: "千问图片翻译", vendor: "阿里百炼", kind: "config", available: false, reason: "未配置图片翻译模型" }),
  ],
};

const SAMPLES: TranscribeResult[] = [
  { text: "今天下午三点在会议室讨论新版本的发布计划。", lang: "zh", durationMs: 3200, engine: "local-sensevoice" },
  { text: "Could you send me the latest design draft?", lang: "en", durationMs: 2600, engine: "local-sensevoice" },
];
let sampleIndex = 0;

export async function mockSpeech<T>(path: string, opts: RequestOptions): Promise<T> {
  await new Promise((r) => setTimeout(r, 450));
  if (path === "/api/speech/engines") return MOCK_ENGINES as T;
  if (path === "/api/speech/transcribe") return SAMPLES[sampleIndex++ % SAMPLES.length] as T;
  if (path === "/api/speech/tts") throw new ApiError("C0172", "语音合成失败（mock：改用浏览器朗读）");
  throw new ApiError("A0404", `mock 未实现：${opts.method ?? "GET"} ${path}`);
}
