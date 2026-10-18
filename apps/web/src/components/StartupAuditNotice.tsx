import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  readStartupStatus,
  startupBlockingMessage,
  STORAGE_DETAILS_PATH,
} from '@web/utils/startup-status';

export default function StartupAuditNotice() {
  const [message, setMessage] = useState('');
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      let delay = 1500;
      try {
        const state = await readStartupStatus(AbortSignal.timeout(5000));
        if (!cancelled) setMessage(startupBlockingMessage(state));
        delay = state.status === 'ready' ? 30000 : 1500;
      } catch {
        /* A disconnected service must never be described as ready. */
      }
      if (!cancelled) timer = setTimeout(check, delay);
    };
    void check();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);
  return message ? (
    <div role="status" className="border-divider border-b px-4 py-2 text-sm">
      {message}{' '}
      <Link to={STORAGE_DETAILS_PATH} className="text-primary underline">
        查看详情
      </Link>
    </div>
  ) : null;
}
