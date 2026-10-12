"use client";

import { useEffect, useRef, useState } from "react";
import { LoaderCircleIcon, SquareIcon, Volume2Icon } from "lucide-react";

/** Static literary narration; only one homepage audio clip plays at a time. */
export function NarrationButton({ src, label }: { src: string; label: string }) {
  const audio = useRef<HTMLAudioElement>(null);
  const request = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const player = audio.current;
    return () => {
      request.current += 1;
      player?.pause();
    };
  }, []);

  const toggle = async () => {
    const player = audio.current;
    if (!player) return;
    const id = ++request.current;
    setFailed(false);
    if (playing || loading) {
      player.pause();
      player.currentTime = 0;
      setLoading(false);
      setPlaying(false);
      return;
    }
    document.querySelectorAll<HTMLAudioElement>("audio[data-landing-audio]").forEach((other) => {
      if (other !== player) other.pause();
    });
    player.currentTime = 0;
    setLoading(true);
    try {
      await player.play();
    } catch (error) {
      if (id !== request.current || (error instanceof DOMException && error.name === "AbortError")) return;
      setLoading(false);
      setFailed(true);
    }
  };

  return (
    <span className="inline-flex items-center gap-2">
      <audio
        ref={audio}
        src={src}
        data-landing-audio
        preload="none"
        onPlaying={() => { setLoading(false); setPlaying(true); }}
        onPause={() => { setLoading(false); setPlaying(false); }}
        onEnded={() => setPlaying(false)}
        onError={() => { setLoading(false); setPlaying(false); setFailed(true); }}
      />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing || loading ? `停止${label}` : label}
        aria-pressed={playing}
        aria-busy={loading}
        className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium text-brand transition-colors outline-none hover:bg-brand-soft focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {loading ? <LoaderCircleIcon className="size-3 animate-spin motion-reduce:animate-none" /> : playing ? <SquareIcon className="size-3" /> : <Volume2Icon className="size-3" />}
        {playing || loading ? "停止" : label}
      </button>
      {failed && <span role="alert" className="text-[11px] text-destructive">播放失败，请重试</span>}
    </span>
  );
}
