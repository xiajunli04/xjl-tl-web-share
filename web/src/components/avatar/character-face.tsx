import { avatarAssetUrl, CHARACTERS, type CharacterId } from "@/lib/avatar/characters";
import { cn } from "@/lib/utils";

/** 形象圆形头像：build.py 产出的脸部特写（256px，约 20 KB），用于气泡、卡片、选择器 */
export function CharacterFace({ id, className, ring }: { id: CharacterId; className?: string; ring?: boolean }) {
  return (
    <span
      role="img"
      aria-label={`Lumi · ${CHARACTERS[id].label}`}
      className={cn(
        "inline-block shrink-0 overflow-hidden rounded-full bg-cover bg-center",
        ring && "ring-2 ring-brand/60 ring-offset-2 ring-offset-background",
        className,
      )}
      style={{
        backgroundImage: `url(${avatarAssetUrl(id, "face.webp")}), radial-gradient(circle at 50% 35%, var(--color-brand-soft), var(--color-card))`,
      }}
    />
  );
}
