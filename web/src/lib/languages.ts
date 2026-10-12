import type { Language } from "@/lib/api/translate";

/**
 * 15 种支持语种（design.md D3）。权威清单由 GET /api/translate/languages 下发；
 * 这里的副本仅作为接口未返回前的占位与失败兜底，保证工作台可用。
 */
export const FALLBACK_LANGUAGES: Language[] = [
  { code: "zh", name: "中文", nativeName: "中文" },
  { code: "en", name: "英语", nativeName: "English" },
  { code: "ja", name: "日语", nativeName: "日本語" },
  { code: "ko", name: "韩语", nativeName: "한국어" },
  { code: "fr", name: "法语", nativeName: "Français" },
  { code: "de", name: "德语", nativeName: "Deutsch" },
  { code: "es", name: "西班牙语", nativeName: "Español" },
  { code: "ru", name: "俄语", nativeName: "Русский" },
  { code: "pt", name: "葡萄牙语", nativeName: "Português" },
  { code: "it", name: "意大利语", nativeName: "Italiano" },
  { code: "ar", name: "阿拉伯语", nativeName: "العربية" },
  { code: "th", name: "泰语", nativeName: "ไทย" },
  { code: "vi", name: "越南语", nativeName: "Tiếng Việt" },
  { code: "id", name: "印尼语", nativeName: "Bahasa Indonesia" },
  { code: "tr", name: "土耳其语", nativeName: "Türkçe" },
];

const NAME_MAP = new Map(FALLBACK_LANGUAGES.map((l) => [l.code, l.name]));

/** 语种代码 → 中文名（未知代码原样返回） */
export function langName(code: string | null | undefined, list?: Language[]) {
  if (!code) return "-";
  if (code === "auto") return "自动识别";
  return list?.find((l) => l.code === code)?.name ?? NAME_MAP.get(code) ?? code;
}

export const DOMAIN_PRESETS = ["通用", "计算机", "医学", "法律", "金融", "文学", "游戏", "电商"];

export const STYLE_OPTIONS = [
  { value: "faithful", label: "忠实", hint: "贴近原文结构与措辞" },
  { value: "fluent", label: "流畅", hint: "符合目标语表达习惯" },
  { value: "creative", label: "创意", hint: "允许意译与润色" },
] as const;

export const MODE_OPTIONS = [
  { value: "auto", label: "自动", hint: "由 Agent 根据文本与术语选择路径" },
  { value: "fast", label: "快速", hint: "单次翻译，不评审" },
  { value: "standard", label: "标准", hint: "检索 → 翻译 → 评审 → 修正" },
] as const;

export const styleLabel = (s: string | null | undefined) =>
  STYLE_OPTIONS.find((o) => o.value === s)?.label ?? s ?? "-";
export const modeLabel = (s: string | null | undefined) =>
  s === "revise" ? "修订" : (MODE_OPTIONS.find((o) => o.value === s)?.label ?? s ?? "-");
export const pathLabel = (p: string | null | undefined) =>
  p === "fast" ? "快速路径" : p === "standard" ? "标准路径" : p === "revise" ? "修订路径" : "-";
