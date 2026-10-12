"use client";

import { useState } from "react";
import { FilterIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** 工具条中的筛选弹层：内容由调用方提供，点击「应用」后才生效 */
export function FilterPopover({
  count,
  onOpen,
  onApply,
  onClear,
  children,
  width = "w-80",
}: {
  count: number;
  /** 打开时用当前生效的条件重置草稿 */
  onOpen?: () => void;
  onApply: () => void;
  onClear: () => void;
  children: React.ReactNode;
  width?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) onOpen?.();
      }}
    >
      <PopoverTrigger render={<Button variant="outline" className="h-9" />}>
        <FilterIcon />
        筛选
        {count > 0 && (
          <span className="flex size-4.5 items-center justify-center rounded-full bg-brand-gradient text-[10px] font-semibold text-brand-foreground">
            {count}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className={`${width} gap-4 p-4`}>
        {children}
        <div className="flex justify-end gap-2 border-t pt-3">
          <Button variant="ghost" size="sm" onClick={onClear}>
            清空
          </Button>
          <Button
            size="sm"
            onClick={() => {
              onApply();
              setOpen(false);
            }}
          >
            应用
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
