"use client";

import { useEffect, useState } from "react";

/** 加载图片 URL（blob URL 等）为 HTMLImageElement；src 变化前返回 null */
export function useImageElement(src: string | null | undefined): HTMLImageElement | null {
  const [state, setState] = useState<{ src: string; img: HTMLImageElement } | null>(null);
  useEffect(() => {
    if (!src) return;
    let alive = true;
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      if (alive) setState({ src, img });
    };
    img.src = src;
    return () => {
      alive = false;
    };
  }, [src]);
  return state && state.src === src ? state.img : null;
}
