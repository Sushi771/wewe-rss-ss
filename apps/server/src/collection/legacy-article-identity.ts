import { canonicalArticleUrl } from './collection-format';

/** An opaque same-title/time row cannot be safely merged with a proved URL. */
export function legacyArticleIdentityAmbiguous(
  saved: {
    id: string;
    sourceUrl: string | null;
    verifiedSourceUrl: string | null;
  },
  identity: { id: string; mpId: string },
) {
  const known = new Set<string>();
  if (/^WX_\d{5,15}_\d+_[1-9]\d*$/.test(saved.id)) known.add(saved.id);
  for (const url of [saved.sourceUrl, saved.verifiedSourceUrl]) {
    if (!url) continue;
    try {
      const proved = canonicalArticleUrl(url);
      if (proved.mpId !== identity.mpId) return true;
      known.add(proved.id);
    } catch {
      if (!/^https:\/\/mp\.weixin\.qq\.com\/s\/[A-Za-z0-9_-]{22}$/.test(url))
        return true;
    }
  }
  return known.size !== 1 || known.has(identity.id);
}
