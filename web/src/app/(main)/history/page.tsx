import { Suspense } from "react";
import { HistoryView } from "@/components/history/history-tabs";

export const metadata = { title: "翻译历史 · 译桥 · LinguaBridge" };

/**
 * ?tab=image|interpret：打开对应分类（缺省为文本）；
 * ?open=记录id：打开该文本记录的详情（翻译记忆来源跳转）
 */
export default async function HistoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const open = Number(sp.open);
  const tab = sp.tab === "image" || sp.tab === "interpret" ? sp.tab : "text";
  return (
    <Suspense>
      <HistoryView initialTab={tab} initialOpenId={Number.isInteger(open) && open > 0 ? open : null} />
    </Suspense>
  );
}
