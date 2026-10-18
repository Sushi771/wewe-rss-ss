import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { readStartupStatus, StartupStatus } from '@web/utils/startup-status';

/** Read on demand in the existing tools page, not a permanent reading banner. */
export default function StorageBackupStatus() {
  const { hash } = useLocation();
  const [open, setOpen] = useState(hash === '#storage-backup');
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<StartupStatus>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (hash === '#storage-backup') setOpen(true);
  }, [hash]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let cancelled = false;
    const timeout = setTimeout(() => controller.abort(), 5000);
    setLoading(true);
    setError('');
    void readStartupStatus(controller.signal)
      .then((result) => {
        if (!cancelled) setState(result);
      })
      .catch(() => {
        if (!cancelled) setError('状态读取失败，请重试。');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [open, attempt]);
  return (
    <details
      id="storage-backup"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="border-divider mt-6 rounded-lg border p-3"
    >
      <summary className="cursor-pointer text-sm">存储与备份</summary>
      {open && (
        <div className="mt-3 space-y-2 text-sm">
          {loading ? (
            <p role="status">正在读取状态…</p>
          ) : error ? (
            <p role="alert">{error}</p>
          ) : state ? (
            <>
              <p>
                {state.writesAllowed
                  ? '数据检查已通过。'
                  : state.status === 'verifying'
                    ? '正在检查数据，更新暂不可用。'
                    : '更新和修改已暂停。'}
              </p>
              {state.message && (
                <p className="text-default-500">{state.message}</p>
              )}
            </>
          ) : null}
          <button
            type="button"
            disabled={loading}
            onClick={() => setAttempt((value) => value + 1)}
            className="text-primary underline disabled:opacity-50"
          >
            重新读取
          </button>
        </div>
      )}
    </details>
  );
}
