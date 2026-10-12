import Image from "next/image";
import { cn } from "@/lib/utils";

/** Shared SVG brand mark; empty alt when adjacent text already names the platform. */
export function BrandMark({ className, decorative = false }: { className?: string; decorative?: boolean }) {
  return (
    <Image
      src="/brand/logo.svg"
      width={64}
      height={64}
      alt={decorative ? "" : "译桥 · LinguaBridge"}
      unoptimized
      className={cn("size-8 shrink-0", className)}
    />
  );
}
