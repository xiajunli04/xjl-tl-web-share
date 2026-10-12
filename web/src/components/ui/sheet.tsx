"use client";

import * as React from "react";
import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { XIcon } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { FADE_ONLY, SPRING_SHEET } from "@/components/motion/tokens";

/**
 * 侧滑面板：基于 base-ui Dialog，受控开合 + motion spring（stiffness 380 / damping 34）。
 * 必须以受控方式使用（open / onOpenChange），以便 AnimatePresence 播放退出动画。
 */
const SheetOpenContext = React.createContext(false);

function Sheet({
  open,
  onOpenChange,
  children,
  ...props
}: Omit<SheetPrimitive.Root.Props, "open" | "onOpenChange" | "children"> & {
  children?: React.ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <SheetPrimitive.Root
      data-slot="sheet"
      open={open}
      onOpenChange={(o) => onOpenChange(o)}
      {...props}
    >
      <SheetOpenContext.Provider value={open}>{children}</SheetOpenContext.Provider>
    </SheetPrimitive.Root>
  );
}

function SheetTrigger({ ...props }: SheetPrimitive.Trigger.Props) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose({ ...props }: SheetPrimitive.Close.Props) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

type Side = "right" | "left";

function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
}: {
  className?: string;
  children?: React.ReactNode;
  side?: Side;
  showCloseButton?: boolean;
}) {
  const open = React.useContext(SheetOpenContext);
  const reduce = useReducedMotion();
  const offscreen = side === "right" ? "100%" : "-100%";

  return (
    <AnimatePresence>
      {open && (
        <SheetPrimitive.Portal keepMounted>
          <SheetPrimitive.Backdrop
            data-slot="sheet-overlay"
            className="fixed inset-0 z-50 bg-overlay supports-backdrop-filter:backdrop-blur-[2px]"
            render={
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
              />
            }
          />
          <SheetPrimitive.Popup
            data-slot="sheet-content"
            data-side={side}
            className={cn(
              "fixed inset-y-0 z-50 flex h-full w-full flex-col bg-popover text-sm text-popover-foreground shadow-modal outline-none sm:max-w-lg",
              side === "right" ? "right-0 border-l" : "left-0 border-r",
              className,
            )}
            render={
              <motion.div
                initial={reduce ? { opacity: 0 } : { x: offscreen }}
                animate={reduce ? { opacity: 1 } : { x: 0 }}
                exit={reduce ? { opacity: 0 } : { x: offscreen }}
                transition={reduce ? FADE_ONLY : SPRING_SHEET}
              />
            }
          >
            {children}
            {showCloseButton && (
              <SheetPrimitive.Close
                data-slot="sheet-close"
                render={
                  <Button variant="ghost" className="absolute top-3.5 right-3.5" size="icon-sm" />
                }
              >
                <XIcon />
                <span className="sr-only">关闭</span>
              </SheetPrimitive.Close>
            )}
          </SheetPrimitive.Popup>
        </SheetPrimitive.Portal>
      )}
    </AnimatePresence>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-1 border-b px-6 pt-5 pb-4 pr-14", className)}
      {...props}
    />
  );
}

function SheetBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-body"
      className={cn("scrollbar-thin min-h-0 flex-1 overflow-y-auto px-6 py-5", className)}
      {...props}
    />
  );
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("flex items-center justify-end gap-2 border-t bg-muted/30 px-6 py-3", className)}
      {...props}
    />
  );
}

function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("font-heading text-base font-semibold text-foreground", className)}
      {...props}
    />
  );
}

function SheetDescription({ className, ...props }: SheetPrimitive.Description.Props) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetBody,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
