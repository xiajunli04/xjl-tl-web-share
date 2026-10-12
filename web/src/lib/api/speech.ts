import { http, postBlob, postStream } from "@/lib/http";

// 与 docs/contracts/speech-image-api.md §0.2 / §2.1 一一对应

export type EngineType = "asr" | "tts" | "interpret" | "image" | "chat";

export interface EngineInfo {
  id: string;
  type: EngineType;
  name: string;
  vendor: string;
  kind: "builtin" | "config";
  available: boolean;
  /** 不可用原因（中文）；available=true 时为 null */
  reason: string | null;
  languages: string[];
  modelConfigId: number | null;
  /** interpret：是否厂商语音到语音 */
  s2s?: boolean;
  /** interpret：单条发言流最多目标语言数 */
  maxTargets?: number;
  /** interpret：双向对话是否支持自动方向 */
  autoConverse?: boolean;
  /** 额外语种约束说明 */
  constraint?: string | null;
  /** chat（实时语音模型）：提供方 */
  provider?: string | null;
  /** chat（实时语音模型）：是否经过真实联调，否则标注"实验" */
  tested?: boolean | null;
}

export interface SpeechEngines {
  asr: EngineInfo[];
  tts: EngineInfo[];
  interpret: EngineInfo[];
  image: EngineInfo[];
  /** AI 对话可用引擎：cascade 平台级联 / realtime-chat 实时语音模型 */
  chat?: EngineInfo[];
}

export interface TranscribeResult {
  text: string;
  lang: string;
  durationMs: number;
  engine: string;
}

export interface TtsRequest {
  text: string;
  lang: string;
  voice?: string | null;
  gender?: "female" | "male";
  engine?: string | null;
  /** 语速倍率 0.5–2.0，缺省 1.0 */
  rate?: number;
}

const BASE = "/api/speech";

export const speechApi = {
  engines: (refresh = false) => http.get<SpeechEngines>(`${BASE}/engines`, { refresh: refresh || undefined }),
  /** 上传 16 kHz 单声道 WAV（≤60 s）识别 */
  transcribe: (wav: Blob, lang = "auto", engine?: string) => {
    const form = new FormData();
    form.append("file", wav, "speech.wav");
    form.append("lang", lang);
    if (engine) form.append("engine", engine);
    return http.upload<TranscribeResult>(`${BASE}/transcribe`, form);
  },
  /** 服务端合成；失败（C0172/C0173）时调用方应改用浏览器 speechSynthesis */
  tts: (req: TtsRequest) => postBlob(`${BASE}/tts`, req),
  /** 流式合成：响应头到达即返回，音频边合成边到达（X-Tts-Engine / X-Tts-Cache 头） */
  ttsStream: (req: TtsRequest, signal?: AbortSignal) => postStream(`${BASE}/tts`, req, signal),
};

export const SPEECH_ENGINES_QUERY_KEY = ["speech-engines"] as const;
