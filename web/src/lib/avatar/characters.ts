/**
 * 数字人语言形象（rework-avatar-portrait-rig D4）：统一品牌名 Lumi，按语言换装换人。
 * 资源由 scripts/avatar/generate.py + build.py 生成到 public/avatars/<id>/。
 */

export type CharacterId = "zh" | "en" | "ja" | "ko";

export interface Character {
  id: CharacterId;
  /** 对应的对话语言 */
  lang: string;
  /** 芯片上的短标签 */
  short: string;
  /** 语言名（本族语） */
  label: string;
  /** 服饰说明 */
  outfit: string;
}

export const CHARACTERS: Record<CharacterId, Character> = {
  zh: { id: "zh", lang: "zh", short: "中", label: "中文", outfit: "青花瓷旗袍" },
  en: { id: "en", lang: "en", short: "EN", label: "English", outfit: "藏青西装" },
  ja: { id: "ja", lang: "ja", short: "日", label: "日本語", outfit: "樱花和服" },
  ko: { id: "ko", lang: "ko", short: "한", label: "한국어", outfit: "韩服" },
};

export const CHARACTER_IDS = Object.keys(CHARACTERS) as CharacterId[];

export const DEFAULT_CHARACTER: CharacterId = "zh";

/** 按语言选择形象；没有专属形象的语言使用中文形象 */
export function characterForLang(lang: string | null | undefined): CharacterId {
  const l = lang === "yue" ? "zh" : lang;
  return (CHARACTER_IDS as string[]).includes(l ?? "") ? (l as CharacterId) : DEFAULT_CHARACTER;
}

export const avatarAssetUrl = (id: CharacterId, file: "base.webp" | "depth.webp" | "atlas.webp" | "face.webp" | "manifest.json") =>
  `/avatars/${id}/${file}`;

/* ---------------- manifest（build.py 产物） ---------------- */

export type Rect = [x: number, y: number, w: number, h: number];

export type LayerName = "mouth-small" | "mouth-aa" | "mouth-oh" | "mouth-ee" | "eyes-closed" | "eyes-up" | "happy";

export interface RigManifest {
  id: CharacterId;
  size: [number, number];
  /** 脸部窗口（眼到嘴），归一化 */
  face: Rect;
  layers: { name: LayerName; dst: Rect; src: Rect }[];
}
