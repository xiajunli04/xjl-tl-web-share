"use client";

import { useState } from "react";
import { DoorOpenIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { LanguagePicker } from "@/components/translate/language-picker";
import { useLanguages } from "@/hooks/use-options";
import { isRoomCode } from "@/lib/api/interpret";
import { cn } from "@/lib/utils";

/** 输入房间码加入会议室：房间码、显示名与我的语言 */
export function JoinRoomDialog({
  open,
  onOpenChange,
  initialCode,
  defaultName,
  defaultLang,
  pending,
  onJoin,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initialCode?: string;
  defaultName: string;
  defaultLang: string;
  pending: boolean;
  onJoin: (code: string, name: string, lang: string) => void;
}) {
  const languages = useLanguages();
  const [code, setCode] = useState(initialCode ?? "");
  const [name, setName] = useState(defaultName);
  const [lang, setLang] = useState(defaultLang);
  const [touched, setTouched] = useState(false);
  // 打开时同步外部带入的房间码（链接邀请）
  const [lastInitial, setLastInitial] = useState(initialCode);
  if (initialCode !== lastInitial) {
    setLastInitial(initialCode);
    if (initialCode) setCode(initialCode);
  }
  const valid = isRoomCode(code);
  const chars = code.toUpperCase().padEnd(6, " ").slice(0, 6).split("");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <DoorOpenIcon className="size-4 text-brand" />
            加入会议室
          </DialogTitle>
          <DialogDescription>输入主持人分享的 6 位房间码，选择你的语言后加入。</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (valid && !pending) onJoin(code.trim().toUpperCase(), name, lang);
          }}
        >
          <label className="block">
            <span className="mb-2 block text-xs font-medium text-muted-foreground">房间码</span>
            <span className="group/code relative block">
              <input
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/[^a-z0-9]/gi, "").slice(0, 6).toUpperCase())}
                aria-label="房间码"
                aria-invalid={touched && !valid}
                inputMode="text"
                autoComplete="off"
                className="absolute inset-0 z-10 w-full cursor-text opacity-0"
              />
              <span className="grid grid-cols-6 gap-2" aria-hidden>
                {chars.map((c, i) => (
                  <span
                    key={i}
                    className={cn(
                      "flex h-12 items-center justify-center rounded-xl border bg-muted/40 font-mono text-xl font-semibold transition-colors",
                      i === Math.min(code.length, 5) && "group-focus-within/code:border-brand group-focus-within/code:ring-3 group-focus-within/code:ring-brand/20",
                      c.trim() && "bg-card",
                      touched && !valid && "border-danger/50",
                    )}
                  >
                    {c.trim()}
                  </span>
                ))}
              </span>
            </span>
            {touched && !valid && <span className="mt-1.5 block text-xs text-danger">房间码为 6 位字母或数字</span>}
          </label>
          <div className="grid grid-cols-[1fr_auto] items-end gap-3">
            <label className="block">
              <span className="mb-2 block text-xs font-medium text-muted-foreground">显示名</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={20} placeholder="其他成员看到的名字" />
            </label>
            <div>
              <span className="mb-1 block text-xs font-medium text-muted-foreground">我的语言</span>
              <div className="rounded-lg border">
                <LanguagePicker label="我的语言" value={lang} onChange={setLang} languages={languages} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2Icon className="animate-spin" /> : <DoorOpenIcon />}
              加入
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
