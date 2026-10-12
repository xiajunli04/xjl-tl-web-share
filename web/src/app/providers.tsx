"use client";

import { useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider, useTheme } from "next-themes";
import { Toaster } from "sonner";
import { MotionProvider } from "@/components/motion/motion-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getQueryClient } from "@/lib/query-client";

function ThemedToaster() {
  const { resolvedTheme } = useTheme();
  return (
    <Toaster
      richColors
      closeButton
      position="top-center"
      theme={resolvedTheme === "dark" ? "dark" : "light"}
      toastOptions={{ className: "rounded-xl! shadow-popover!" }}
    />
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(getQueryClient);
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem storageKey="tl-theme">
      <QueryClientProvider client={client}>
        <MotionProvider>
          <TooltipProvider delay={300}>
            {children}
            <ThemedToaster />
          </TooltipProvider>
        </MotionProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
