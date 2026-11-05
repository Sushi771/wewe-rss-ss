import { useState } from 'react';
/** Render only saved image metadata. A failed or missing URL has a local fallback. */
export default function XhsCreatorAvatar({
  url,
  name,
}: {
  url?: string | null;
  name: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string>();
  let valid = false;
  try {
    const parsed = new URL(url || '');
    valid =
      parsed.protocol === 'https:' && !parsed.username && !parsed.password;
  } catch {
    /* Missing metadata. */
  }
  return valid && failedUrl !== url ? (
    <img
      className="xhs-creator-avatar"
      src={url!}
      alt=""
      referrerPolicy="no-referrer"
      loading="lazy"
      onError={() => setFailedUrl(url!)}
    />
  ) : (
    <span className="xhs-creator-avatar" aria-hidden="true">
      {Array.from(name.trim())[0] || '博'}
    </span>
  );
}
