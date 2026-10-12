import { ImageWorkspace } from "@/components/image/image-workspace";

export const metadata = { title: "图片翻译 · 译桥 · LinguaBridge" };

/** ?id=记录id：打开一条图片翻译记录（历史页「在图片翻译中打开」） */
export default async function ImagePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const id = Number((await searchParams).id);
  return <ImageWorkspace initialId={Number.isInteger(id) && id > 0 ? id : null} />;
}
