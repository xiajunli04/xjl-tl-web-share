import { cn } from "cn";

/** 微光扫过的骨架块；减少动效时退化为静态色块 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "relative isolate overflow-hidden rounded-md bg-muted",
        "before:absolute before:inset-0 before:-translate-x-full before:animate-shimmer before:bg-linear-to-r before:from-transparent before:via-foreground/6 before:to-transparent motion-reduce:before:hidden",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
