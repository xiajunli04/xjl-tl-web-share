import { DocWorkspace } from "@/components/documents/workspace/doc-workspace";

export const metadata = { title: "文档工作区 · 译桥 · LinguaBridge" };

/** ?seq=段落序号：加载后选中并定位到该段（翻译记忆来源跳转） */
export default async function DocumentWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const seq = Number((await searchParams).seq);
  return <DocWorkspace key={id} id={Number(id)} initialSeq={Number.isInteger(seq) && seq >= 0 ? seq : null} />;
}
