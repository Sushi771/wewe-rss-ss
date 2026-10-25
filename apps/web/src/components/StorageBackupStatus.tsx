import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  readStartupStatus,
  StartupStatus,
  periodicBackupLines,
} from '@web/utils/startup-status';

/** Read on demand in the existing tools page, not a permanent reading banner. */
export default function StorageBackupStatus() {
  const { hash, key } = useLocation();
  const details = useRef<HTMLDetailsElement>(null);
  const lastNavigation = useRef(key);
  const [open, setOpen] = useState(hash === '#storage-backup');
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<StartupStatus>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const changed = lastNavigation.current !== key;
    lastNavigation.current = key;
    if (hash !== '#storage-backup') return;
    setOpen(true);
    if (changed) setAttempt((value) => value + 1);
    const frame = requestAnimationFrame(() =>
      details.current?.scrollIntoView({ block: 'start' }),
    );
    return () => cancelAnimationFrame(frame);
  }, [hash, key]);
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
  useEffect(() => {
    if (hash !== '#storage-backup' || !open || loading || (!state && !error))
      return;
    // Async details can grow after the initial hash navigation scroll.
    const frame = requestAnimationFrame(() =>
      details.current?.scrollIntoView({ block: 'nearest' }),
    );
    return () => cancelAnimationFrame(frame);
  }, [hash, key, open, loading, state, error]);
  return (
    <details
      ref={details}
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
                <details>
                  <summary>诊断信息</summary>
                  <p className="text-default-500">{state.message}</p>
                </details>
              )}
              <div aria-label="周期备份状态" className="space-y-1 break-words">
                {periodicBackupLines(state.periodicBackup).map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
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
