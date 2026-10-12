import {
  BotIcon,
  BriefcaseBusinessIcon,
  EarIcon,
  MapPinnedIcon,
  MessageCircleHeartIcon,
  MessagesSquareIcon,
  UserRoundCheckIcon,
  UsersRoundIcon,
  UtensilsIcon,
  type LucideIcon,
} from "lucide-react";
import type { ChatScenario, InterpretMode } from "@/lib/api/interpret";
import type { StageStatus } from "@/lib/interpret/reducer";

export interface ModeMeta {
  title: string;
  desc: string;
  icon: LucideIcon;
  points: string[];
  start: string;
}

export const MODE_META: Record<InterpretMode, ModeMeta> = {
  LISTEN: {
    title: "同传收听",
    desc: "讲座、发布会、视频：多语种语音持续翻译成你的语言并播报",
    icon: EarIcon,
    points: ["自动识别说话语种", "舞台大字幕 + 语音播报"],
    start: "开始收听",
  },
  CONVERSE: {
    title: "双向对话",
    desc: "面对面交流：一台设备，两种语言实时互译",
    icon: MessagesSquareIcon,
    points: ["上下半区面对面阅读", "自动切换方向或按键说话"],
    start: "开始对话",
  },
  ROOM: {
    title: "多语会议室",
    desc: "3–8 人各用自己的设备和语言加入同一房间",
    icon: UsersRoundIcon,
    points: ["每人看到自己语言的字幕", "房间码一键邀请"],
    start: "创建会议室",
  },
  CHAT: {
    title: "AI 对话",
    desc: "和数字人 Lumi 用外语实时聊天：她听、她想、她回应，随时可以打断",
    icon: BotIcon,
    points: ["AI 用对话语言回复 + 母语字幕", "五种场景陪练，地道说法示范"],
    start: "开始对话",
  },
};

export const MODES: InterpretMode[] = ["LISTEN", "CONVERSE", "ROOM", "CHAT"];

/** AI 对话的 AI 伙伴名 */
export const AI_NAME = "Lumi";

export interface ScenarioMeta {
  title: string;
  desc: string;
  icon: LucideIcon;
}

/** AI 对话场景（与 Python chat_prompts.SCENARIOS 一致） */
export const CHAT_SCENARIOS: Record<ChatScenario, ScenarioMeta> = {
  free: { title: "自由聊天", desc: "轻松聊兴趣与日常", icon: MessageCircleHeartIcon },
  travel: { title: "旅行问路", desc: "向当地人问路、问美食", icon: MapPinnedIcon },
  restaurant: { title: "餐厅点餐", desc: "服务员带你点菜、问忌口", icon: UtensilsIcon },
  business: { title: "商务会面", desc: "与合作方寒暄、谈合作", icon: BriefcaseBusinessIcon },
  interview: { title: "求职面试", desc: "面试官逐个提问", icon: UserRoundCheckIcon },
};

export const SCENARIOS = Object.keys(CHAT_SCENARIOS) as ChatScenario[];

export const STATUS_META: Record<StageStatus, { label: string; tone: string; dot: string }> = {
  listening: { label: "聆听", tone: "bg-success-soft text-success", dot: "bg-success" },
  recognizing: { label: "识别", tone: "bg-info-soft text-info", dot: "bg-info" },
  translating: { label: "翻译", tone: "bg-brand-soft text-brand", dot: "bg-brand" },
  speaking: { label: "播报", tone: "bg-warning-soft text-warning", dot: "bg-warning" },
  paused: { label: "已暂停", tone: "bg-muted text-muted-foreground", dot: "bg-muted-foreground" },
};

/** 实测过的引擎（design：引擎徽章「已实测」） */
export const TESTED_ENGINES = new Set(["cascade", "qwen-livetranslate"]);

/** 头像配色：按 id 稳定取一种令牌色 */
const AVATAR_TONES = [
  "bg-brand-soft text-brand",
  "bg-success-soft text-success",
  "bg-info-soft text-info",
  "bg-warning-soft text-warning",
  "bg-danger-soft text-danger",
];

export function avatarTone(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length];
}

export function initials(name: string) {
  const s = name.trim();
  if (!s) return "?";
  const first = Array.from(s)[0];
  return /[a-z]/i.test(first) ? first.toUpperCase() : first;
}

/** 语种短标签（徽章用） */
export function langShort(code: string) {
  const map: Record<string, string> = { zh: "中", en: "EN", ja: "日", ko: "한", fr: "FR", de: "DE", es: "ES", ru: "RU", pt: "PT", it: "IT", ar: "AR", th: "TH", vi: "VI", id: "ID", tr: "TR", yue: "粤" };
  return map[code] ?? code.toUpperCase();
}

export const END_REASON: Record<string, string> = {
  user_end: "同传已结束",
  host_left: "主持人已结束会议",
  idle: "会话因长时间无连接自动结束",
  error: "同传因连接问题中断",
};
