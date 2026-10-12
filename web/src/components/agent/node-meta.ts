import {
  BadgeCheckIcon,
  ClipboardCheckIcon,
  MessageCircleQuestionIcon,
  BrainCircuitIcon,
  LanguagesIcon,
  LibraryBigIcon,
  PenLineIcon,
  RouteIcon,
  ScanSearchIcon,
  type LucideIcon,
} from "lucide-react";
import type { AgentNode, ReviewCategory } from "@/lib/api/translate";

export const NODE_META: Record<AgentNode, { label: string; icon: LucideIcon; desc: string }> = {
  analyze: { label: "分析", icon: ScanSearchIcon, desc: "语种识别 · 术语匹配" },
  plan: { label: "规划", icon: RouteIcon, desc: "选择路径与领域" },
  retrieve: { label: "检索", icon: LibraryBigIcon, desc: "组装上下文包" },
  translate: { label: "翻译", icon: LanguagesIcon, desc: "生成译文" },
  review: { label: "评审", icon: ClipboardCheckIcon, desc: "MQM 四维度评分" },
  refine: { label: "修正", icon: PenLineIcon, desc: "根据评审意见改写" },
  finalize: { label: "定稿", icon: BadgeCheckIcon, desc: "术语遵循校验" },
  clarify: { label: "追问", icon: MessageCircleQuestionIcon, desc: "歧义澄清" },
  memorize: { label: "记忆", icon: BrainCircuitIcon, desc: "压缩会话记忆" },
};

export function nodeMeta(node: string) {
  return (
    NODE_META[node as AgentNode] ?? { label: node, icon: ScanSearchIcon, desc: "" }
  );
}

export const CATEGORY_LABEL: Record<ReviewCategory, string> = {
  accuracy: "准确性",
  fluency: "流畅性",
  terminology: "术语",
  style: "风格",
};

export const SEVERITY_LABEL: Record<string, string> = {
  critical: "严重",
  major: "主要",
  minor: "轻微",
};

export function formatMs(ms?: number | null) {
  if (ms === undefined || ms === null) return "-";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

export function formatTokens(n?: number | null) {
  if (!n) return "0";
  return n.toLocaleString("en-US");
}
