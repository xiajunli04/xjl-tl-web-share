"use client";

import { useState } from "react";
import { ChevronDownIcon, Columns2Icon, DownloadIcon, FileCode2Icon, FileTextIcon, Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { docApi, type DocExportFormat } from "@/lib/api/documents";
import { saveBlob } from "@/lib/download";
import { toastError } from "@/lib/errors";

const FORMATS: { value: DocExportFormat; label: string; desc: string; icon: typeof FileTextIcon; ext: string }[] = [
  { value: "md", label: "译文 Markdown", desc: "保留原文结构，只替换正文", icon: FileCode2Icon, ext: "md" },
  { value: "bilingual", label: "双语对照", desc: "原文与译文逐段交替", icon: Columns2Icon, ext: "md" },
  { value: "txt", label: "纯文本", desc: "去除 Markdown 标记", icon: FileTextIcon, ext: "txt" },
];

/** 导出菜单：译文 Markdown / 双语对照 / 纯文本（http.ts 的 download，文件名取服务端 UTF-8 文件名） */
export function ExportMenu({
  id,
  title,
  targetLang,
  disabled,
  partial,
}: {
  id: number;
  title: string;
  targetLang: string;
  disabled?: boolean;
  partial?: boolean;
}) {
  const [busy, setBusy] = useState<DocExportFormat | null>(null);
  const run = async (f: (typeof FORMATS)[number]) => {
    setBusy(f.value);
    try {
      const { blob, filename } = await docApi.export(id, f.value);
      // 与 Spring 一致：{title}.{targetLang}.md / {title}.bilingual.md / {title}.{targetLang}.txt
      saveBlob(blob, filename ?? `${title}.${f.value === "bilingual" ? "bilingual" : targetLang}.${f.ext}`);
      toast.success(`已导出${f.label}`);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={disabled || !!busy} />}>
        {busy ? <Loader2Icon className="animate-spin" /> : <DownloadIcon />}
        导出
        <ChevronDownIcon className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{partial ? "尚未完成：未翻译的段落将保留原文" : "选择导出格式"}</DropdownMenuLabel>
          {FORMATS.map((f) => {
            const Icon = f.icon;
            return (
              <DropdownMenuItem key={f.value} onClick={() => run(f)} className="items-start gap-2.5 py-2">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <Icon className="size-3.5" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm">{f.label}</span>
                  <span className="block text-[11px] text-muted-foreground">{f.desc}</span>
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
