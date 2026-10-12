"use client";

import { HeadphonesIcon, MicIcon, MicOffIcon, PhoneOffIcon, Volume2Icon, VolumeXIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { interpretRuntime } from "@/hooks/use-interpret-socket";
import { cn } from "@/lib/utils";
import { useInterpretStore } from "@/stores/interpret-store";
import { LatencyPill, LevelOrb, StatusPill } from "./live-bits";

export function ToggleButton({
  on,
  onIcon: OnIcon,
  offIcon: OffIcon,
  label,
  tip,
  onClick,
  disabled,
  danger,
}: {
  on: boolean;
  onIcon: typeof MicIcon;
  offIcon?: typeof MicIcon;
  label: string;
  tip: string;
  onClick: () => void;
  disabled?: boolean;
  /** 关闭态用危险色（如麦克风静音） */
  danger?: boolean;
}) {
  const Icon = on || !OffIcon ? OnIcon : OffIcon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={on ? "secondary" : "ghost"}
            size="icon-lg"
            aria-label={label}
            aria-pressed={on}
            disabled={disabled}
            onClick={onClick}
            className={cn("rounded-full", on && "text-brand", !on && danger && "bg-danger-soft text-danger hover:bg-danger-soft")}
          />
        }
      >
        <Icon />
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

/** 收听 / 会议室底部控制条：电平光球、状态胶囊、延迟、麦克风、播报、耳机、结束 */
export function ControlBar({ lang, room }: { lang: string | null; room?: boolean }) {
  const muted = useInterpretStore((s) => s.muted);
  const tts = useInterpretStore((s) => s.tts);
  const headphone = useInterpretStore((s) => s.headphone);
  const ended = useInterpretStore((s) => s.phase !== "live");
  const isHost = useInterpretStore((s) => !!s.join?.isHost);

  return (
    <div className="flex flex-wrap items-center gap-3 border-t bg-card/80 px-4 py-3 backdrop-blur supports-backdrop-filter:bg-card/70 md:px-6">
      <LevelOrb />
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill lang={lang} />
        <LatencyPill />
      </div>
      <div className="ml-auto flex items-center gap-1.5">
        <ToggleButton
          on={!muted}
          onIcon={MicIcon}
          offIcon={MicOffIcon}
          danger
          label={muted ? "打开麦克风" : "静音麦克风"}
          tip={muted ? "打开麦克风" : "静音麦克风"}
          onClick={() => interpretRuntime.setMuted(!muted)}
          disabled={ended}
        />
        <ToggleButton
          on={tts}
          onIcon={Volume2Icon}
          offIcon={VolumeXIcon}
          label="语音播报"
          tip={tts ? "关闭语音播报" : "开启语音播报"}
          onClick={() => interpretRuntime.setTts(!tts)}
          disabled={ended}
        />
        {!room && (
          <ToggleButton
            on={headphone}
            onIcon={HeadphonesIcon}
            label="耳机模式"
            tip={headphone ? "关闭耳机模式（播报时暂停收音）" : "耳机模式：播报时也继续收音"}
            onClick={() => interpretRuntime.setHeadphone(!headphone)}
            disabled={ended}
          />
        )}
        <Button variant="destructive" className="ml-1 h-9 gap-2 rounded-full px-4" onClick={() => void interpretRuntime.end()} disabled={ended}>
          <PhoneOffIcon className="size-4" />
          {room && !isHost ? "离开" : "结束"}
        </Button>
      </div>
    </div>
  );
}
