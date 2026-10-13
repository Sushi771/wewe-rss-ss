import { useState } from 'react';

/** A name badge is a fallback, never a replacement claimed as the real avatar. */
export default function FeedAvatar({
  src,
  name,
  className = '',
}: {
  src?: string | null;
  name?: string | null;
  className?: string;
}) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const source = src?.trim() || '';
  const label = name?.trim() || '公众号';
  const showImage = !!source && failedSource !== source;
  return (
    <span
      role="img"
      aria-label={`${label}${showImage ? '头像' : '名称标识'}`}
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-neutral-200/60 text-[11px] text-neutral-600 dark:bg-neutral-700 dark:text-neutral-200 ${className}`}
    >
      {showImage ? (
        <img
          src={source}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailedSource(source)}
        />
      ) : (
        <span aria-hidden="true">{Array.from(label)[0]}</span>
      )}
    </span>
  );
}
