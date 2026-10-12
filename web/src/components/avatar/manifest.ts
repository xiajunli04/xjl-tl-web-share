import { avatarAssetUrl, type CharacterId, type RigManifest } from "@/lib/avatar/characters";

const cache = new Map<CharacterId, Promise<RigManifest>>();

/** 形象 manifest（几 KB，按形象缓存；失败时清除缓存以便重试） */
export function loadManifest(id: CharacterId): Promise<RigManifest> {
  let p = cache.get(id);
  if (!p) {
    p = fetch(avatarAssetUrl(id, "manifest.json")).then((r) => {
      if (!r.ok) throw new Error(`manifest ${r.status}`);
      return r.json() as Promise<RigManifest>;
    });
    p.catch(() => cache.delete(id));
    cache.set(id, p);
  }
  return p;
}
