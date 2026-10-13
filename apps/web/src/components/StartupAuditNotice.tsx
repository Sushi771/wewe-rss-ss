import { useEffect, useState } from 'react';

export default function StartupAuditNotice() {
  const [message, setMessage] = useState('');
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      let done = false;
      try {
        const response = await fetch('/startup-status', {
          cache: 'no-store',
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
          const state = await response.json();
          if (!cancelled) setMessage(state.message || '');
          done = state.status === 'ready';
        }
      } catch {
        /* A disconnected service must never be described as ready. */
      }
      if (!cancelled && !done) timer = setTimeout(check, 1500);
    };
    void check();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);
  return message ? (
    <div role="status" className="border-divider border-b px-4 py-2 text-sm">
      {message}
    </div>
  ) : null;
}
