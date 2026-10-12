"use client";

import {
  AudioLinesIcon,
  AudioWaveformIcon,
  BotIcon,
  CloudIcon,
  FlameIcon,
  ImageIcon,
  MessageSquareTextIcon,
  MicIcon,
  RadioTowerIcon,
  SparklesIcon,
  Volume2Icon,
  type LucideIcon,
} from "lucide-react";
import type { ModelCapability, Provider } from "@/lib/api/types";
import { cn } from "@/lib/utils";

const PROVIDER_STYLE: Record<Provider, { icon: LucideIcon; cls: string }> = {
  OPENAI_COMPATIBLE: { icon: BotIcon, cls: "bg-info-soft text-info ring-info/20" },
  ANTHROPIC: { icon: SparklesIcon, cls: "bg-warning-soft text-warning ring-warning/20" },
  DASHSCOPE: { icon: CloudIcon, cls: "bg-brand-soft text-brand ring-brand/20" },
  VOLCENGINE: { icon: FlameIcon, cls: "bg-danger-soft text-danger ring-danger/20" },
  GOOGLE: { icon: RadioTowerIcon, cls: "bg-success-soft text-success ring-success/20" },
};

export function ProviderIcon({ provider, className }: { provider: Provider; className?: string }) {
  const s = PROVIDER_STYLE[provider] ?? PROVIDER_STYLE.OPENAI_COMPATIBLE;
  const Icon = s.icon;
  return (
    <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl ring-1", s.cls, className)}>
      <Icon className="size-5" />
    </span>
  );
}

export const CAPABILITY_ICON: Record<ModelCapability, LucideIcon> = {
  CHAT: MessageSquareTextIcon,
  ASR: MicIcon,
  TTS: Volume2Icon,
  REALTIME_TRANSLATE: AudioLinesIcon,
  REALTIME_CHAT: AudioWaveformIcon,
  IMAGE_TRANSLATE: ImageIcon,
};

export function CapabilityIcon({ capability, className }: { capability: ModelCapability; className?: string }) {
  const Icon = CAPABILITY_ICON[capability];
  return <Icon className={className} />;
}
