import type { ModelCapability, ModelConfigVO, Provider } from "@/lib/api/types";

/** 模型配置的能力类型与提供方组合（design D12），模型配置页与 mock 共用 */

export const CAPABILITIES: ModelCapability[] = ["CHAT", "ASR", "TTS", "REALTIME_TRANSLATE", "REALTIME_CHAT", "IMAGE_TRANSLATE"];

/** 使用 WebSocket 地址的实时能力 */
const REALTIME_CAPABILITIES: ModelCapability[] = ["REALTIME_TRANSLATE", "REALTIME_CHAT"];

export const CAPABILITY_LABEL: Record<ModelCapability, string> = {
  CHAT: "对话",
  ASR: "语音识别",
  TTS: "语音合成",
  REALTIME_TRANSLATE: "实时同传",
  REALTIME_CHAT: "实时语音对话",
  IMAGE_TRANSLATE: "图片翻译",
};

export const CAPABILITY_DESC: Record<ModelCapability, string> = {
  CHAT: "翻译 Agent、评审、解读与视觉 OCR 使用的大模型",
  ASR: "OpenAI 兼容 /audio/transcriptions，用于听写与级联同传",
  TTS: "OpenAI 兼容 /audio/speech，用于朗读与同传播报",
  REALTIME_TRANSLATE: "厂商语音到语音同传引擎（WebSocket）",
  REALTIME_CHAT: "AI 对话的端到端实时语音模型（直接听、直接说，WebSocket）",
  IMAGE_TRANSLATE: "一体化图片翻译，直接返回译图",
};

/** 每种能力允许的提供方（第一个为默认） */
export const ALLOWED_PROVIDERS: Record<ModelCapability, Provider[]> = {
  CHAT: ["OPENAI_COMPATIBLE", "ANTHROPIC"],
  ASR: ["OPENAI_COMPATIBLE"],
  TTS: ["OPENAI_COMPATIBLE"],
  REALTIME_TRANSLATE: ["DASHSCOPE", "VOLCENGINE", "GOOGLE", "OPENAI_COMPATIBLE"],
  REALTIME_CHAT: ["DASHSCOPE", "OPENAI_COMPATIBLE"],
  IMAGE_TRANSLATE: ["DASHSCOPE"],
};

export const PROVIDER_LABEL: Record<Provider, { label: string; short: string }> = {
  OPENAI_COMPATIBLE: { label: "OpenAI 兼容（DeepSeek / Qwen / 豆包 / OpenAI）", short: "OpenAI 兼容" },
  ANTHROPIC: { label: "Anthropic", short: "Anthropic" },
  DASHSCOPE: { label: "阿里云百炼 DashScope", short: "百炼" },
  VOLCENGINE: { label: "火山引擎（豆包）", short: "火山引擎" },
  GOOGLE: { label: "Google Gemini", short: "Google" },
};

export function isAllowedCombination(capability: ModelCapability, provider: Provider): boolean {
  return ALLOWED_PROVIDERS[capability].includes(provider);
}

/** 切换能力时：当前提供方仍合法则保留，否则取该能力的第一个提供方 */
export function coerceProvider(capability: ModelCapability, provider: Provider): Provider {
  return isAllowedCombination(capability, provider) ? provider : ALLOWED_PROVIDERS[capability][0];
}

export const capabilityOf = (m: Pick<ModelConfigVO, "capability">): ModelCapability => m.capability ?? "CHAT";

interface Preset {
  baseUrl: string;
  model: string;
  /** 建议的额外参数键（含默认值提示） */
  extraKeys?: { key: string; placeholder: string; hint: string }[];
}

const DEFAULT_PRESET: Preset = { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" };

const PRESETS: Partial<Record<`${ModelCapability}:${Provider}`, Preset>> = {
  "CHAT:OPENAI_COMPATIBLE": { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", extraKeys: [{ key: "reasoningEffort", placeholder: "low", hint: "推理强度" }] },
  "CHAT:ANTHROPIC": { baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-5" },
  "ASR:OPENAI_COMPATIBLE": { baseUrl: "https://api.openai.com/v1", model: "whisper-1", extraKeys: [{ key: "language", placeholder: "auto", hint: "识别语种提示" }] },
  "TTS:OPENAI_COMPATIBLE": { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-tts", extraKeys: [{ key: "voice", placeholder: "alloy", hint: "音色" }] },
  "REALTIME_TRANSLATE:DASHSCOPE": {
    baseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
    model: "qwen3.8-livetranslate-flash-realtime",
    extraKeys: [{ key: "voice", placeholder: "Tina", hint: "播报音色（默认 Tina）" }],
  },
  "REALTIME_TRANSLATE:VOLCENGINE": {
    baseUrl: "wss://openspeech.bytedance.com/api/v4/ast/v2/translate",
    model: "seed-liveinterpret-2.0",
    extraKeys: [
      { key: "appId", placeholder: "火山引擎控制台的 App ID", hint: "豆包同传必填" },
      { key: "resourceId", placeholder: "volc.service_type.10053", hint: "资源 ID" },
    ],
  },
  "REALTIME_TRANSLATE:GOOGLE": { baseUrl: "wss://generativelanguage.googleapis.com", model: "gemini-3.5-live-translate-preview" },
  "REALTIME_TRANSLATE:OPENAI_COMPATIBLE": {
    baseUrl: "wss://api.openai.com/v1/realtime/translations",
    model: "gpt-realtime-translate",
    extraKeys: [{ key: "voice", placeholder: "marin", hint: "播报音色" }],
  },
  "REALTIME_CHAT:DASHSCOPE": {
    baseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
    model: "qwen3-omni-flash-realtime",
    extraKeys: [{ key: "voice", placeholder: "Cherry", hint: "回复音色（默认女声 Cherry / 男声 Ethan）" }],
  },
  "REALTIME_CHAT:OPENAI_COMPATIBLE": {
    baseUrl: "wss://api.openai.com/v1",
    model: "gpt-realtime",
    extraKeys: [{ key: "voice", placeholder: "alloy", hint: "回复音色" }],
  },
  "IMAGE_TRANSLATE:DASHSCOPE": { baseUrl: "https://dashscope.aliyuncs.com/api/v1", model: "qwen-mt-image-2.0", extraKeys: [{ key: "domainHint", placeholder: "餐饮菜单", hint: "领域提示" }] },
};

export function presetOf(capability: ModelCapability, provider: Provider): Preset {
  return PRESETS[`${capability}:${provider}`] ?? DEFAULT_PRESET;
}

/** 该能力是否使用 temperature / maxTokens（只有对话模型使用） */
export const usesSampling = (c: ModelCapability) => c === "CHAT";

/* ---------------- 额外参数（键值对） ---------------- */

export interface ExtraRow {
  key: string;
  value: string;
}

export const EXTRA_MAX = 20;
const EXTRA_KEY_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

export function extraToRows(extra: Record<string, string> | null | undefined): ExtraRow[] {
  return Object.entries(extra ?? {}).map(([key, value]) => ({ key, value: String(value) }));
}

/** 校验键值对：返回每行的错误（无错误为 undefined） */
export function validateExtraRows(rows: readonly ExtraRow[]): (string | undefined)[] {
  const seen = new Map<string, number>();
  return rows.map((r, i) => {
    const key = r.key.trim();
    if (!key && !r.value.trim()) return undefined;
    if (!key) return "请填写参数名";
    if (!EXTRA_KEY_RE.test(key)) return "参数名以字母开头，只能包含字母、数字、_ . -";
    if (r.value.length > 255) return "参数值最多 255 个字符";
    if (/key|secret|token|password/i.test(key)) return "额外参数会明文保存，请勿填写密钥";
    if (seen.has(key)) return `与第 ${seen.get(key)! + 1} 行重复`;
    seen.set(key, i);
    return undefined;
  });
}

/** 键值对 → extra 对象（忽略空行，去除首尾空白；没有内容时返回 undefined） */
export function rowsToExtra(rows: readonly ExtraRow[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const key = r.key.trim();
    if (key) out[key] = r.value.trim();
  }
  return Object.keys(out).length ? out : undefined;
}

/** baseUrl：http(s) 或 ws(s)；实时同传与实时语音对话以外的能力不接受 ws(s) */
export function validateBaseUrl(url: string, capability: ModelCapability): string | null {
  const v = url.trim();
  if (!v) return "请输入接口地址";
  if (v.length > 255) return "接口地址最多 255 个字符";
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    return "请输入合法的 URL";
  }
  const proto = parsed.protocol;
  if (!["http:", "https:", "ws:", "wss:"].includes(proto)) return "接口地址须以 http(s):// 或 ws(s):// 开头";
  if ((proto === "ws:" || proto === "wss:") && !REALTIME_CAPABILITIES.includes(capability)) {
    return "只有实时同传与实时语音对话可以使用 ws(s):// 地址";
  }
  return null;
}

/** 列表分组：按能力顺序，组内默认在前、启用在前 */
export function groupByCapability<T extends Pick<ModelConfigVO, "capability" | "isDefault" | "enabled">>(
  rows: readonly T[],
): { capability: ModelCapability; items: T[] }[] {
  return CAPABILITIES.map((capability) => ({
    capability,
    items: rows
      .filter((r) => capabilityOf(r) === capability)
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || Number(b.enabled) - Number(a.enabled)),
  })).filter((g) => g.items.length > 0);
}

/** 连通性测试结果摘要的标签 */
export const TEST_REPLY_LABEL: Record<ModelCapability, string> = {
  CHAT: "回复",
  ASR: "识别",
  TTS: "结果",
  REALTIME_TRANSLATE: "会话",
  REALTIME_CHAT: "会话",
  IMAGE_TRANSLATE: "结果",
};
