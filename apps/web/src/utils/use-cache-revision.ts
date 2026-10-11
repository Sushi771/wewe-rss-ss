import { useEffect, useRef, useState } from 'react';
import { createCacheRevisionWatch } from './cache-revision-watch';

/** Uses the existing authenticated tRPC client, without a second transport. */
export function useCacheRevision(options: {
  read: (signal: AbortSignal) => Promise<{ revision: string }>;
  refresh: () => Promise<unknown>;
}) {
  const current = useRef(options);
  current.current = options;
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    const watch = createCacheRevisionWatch({
      read: (signal) => current.current.read(signal),
      refresh: () => current.current.refresh(),
      onError: (phase, error) => {
        setUnavailable(true);
        console.warn(`Local cache ${phase} read failed`, error);
      },
      onHealthy: () => setUnavailable(false),
    });
    const update = () =>
      watch.setActive(
        document.visibilityState === 'visible' &&
          document.hasFocus() &&
          navigator.onLine,
      );
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    update();
    return () => {
      watch.dispose();
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return unavailable;
}
