"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { AudioLinesIcon, HistoryIcon, ImageIcon, TextIcon } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageContainer, PageHeader } from "@/components/layout/common";
import { DURATION, EASE_OUT } from "@/components/motion/tokens";
import { ImageHistory } from "./image-history";
import { InterpretHistory } from "./interpret-history";
import { TextHistory } from "./history-view";

export type HistoryTab = "text" | "image" | "interpret";

const TABS: { value: HistoryTab; label: string; icon: React.ComponentType<{ className?: string }>; desc: string }[] = [
  { value: "text", label: "文本", icon: TextIcon, desc: "每次成功的翻译都会保存原文、译文与完整的 Agent 轨迹" },
  { value: "image", label: "图片", icon: ImageIcon, desc: "图片翻译的原图、逐块译文与步骤轨迹" },
  { value: "interpret", label: "同传", icon: AudioLinesIcon, desc: "同声传译会话的双语转写与延迟统计" },
];

export function parseHistoryTab(v: string | null | undefined): HistoryTab {
  return v === "image" || v === "interpret" ? v : "text";
}

/** 翻译历史：「文本 / 图片 / 同传」分段标签（指示条位移 + 列表交叉淡入），支持 ?tab= 深链 */
export function HistoryView({
  initialOpenId = null,
  initialTab = "text",
}: {
  initialOpenId?: number | null;
  initialTab?: HistoryTab;
}) {
  const reduce = useReducedMotion();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [tab, setTab] = useState<HistoryTab>(initialTab);

  const change = (v: HistoryTab) => {
    setTab(v);
    const next = new URLSearchParams(params.toString());
    next.delete("open");
    if (v === "text") next.delete("tab");
    else next.set("tab", v);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const current = TABS.find((t) => t.value === tab)!;

  return (
    <PageContainer>
      <PageHeader title="翻译历史" description={current.desc} icon={HistoryIcon} />
      <Tabs value={tab} onValueChange={(v) => change(parseHistoryTab(String(v)))} className="mb-4 gap-0">
        <TabsList className="h-10 w-full sm:w-auto" aria-label="历史分类">
          {TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value} className="gap-1.5 px-4">
              <t.icon className="size-4" />
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: reduce ? 0 : 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reduce ? 0 : -4 }}
          transition={{ duration: reduce ? DURATION.fast : DURATION.page, ease: EASE_OUT }}
          className="flex flex-col"
        >
          {tab === "text" ? (
            <TextHistory initialOpenId={initialOpenId} />
          ) : tab === "image" ? (
            <ImageHistory />
          ) : (
            <InterpretHistory />
          )}
        </motion.div>
      </AnimatePresence>
    </PageContainer>
  );
}
