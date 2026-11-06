import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getAuthCode } from '@web/utils/auth';
import { privateOnlineMode } from '@web/utils/env';
import { connectMemorySession } from '@web/utils/xhs-memory-connection';

export default function XhsMemoryConnection({
  disabled,
  onConnected,
}: {
  disabled: boolean;
  onConnected: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState('');
  const form = useRef<HTMLFormElement>(null);
  const first = useRef<HTMLInputElement>(null);
  const second = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const active = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    const fields = [first.current, second.current];
    return () => {
      for (const field of fields) if (field) field.value = '';
    };
  }, [open]);
  const close = () => {
    form.current?.reset();
    setOpen(false);
    setMessage('');
  };
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || active.current || !form.current?.reportValidity()) return;
    active.current = true;
    setSending(true);
    setMessage('正在连接本次会话…');
    const input = {
      a1: first.current?.value ?? '',
      webSession: second.current?.value ?? '',
    };
    form.current.reset();
    const result = await connectMemorySession(input, {
      origin: window.location.origin,
      privateMode: privateOnlineMode,
      authCode: getAuthCode,
      send: (request, init) => window.fetch(request, init),
    });
    active.current = false;
    if (!mounted.current) return;
    setSending(false);
    if (result.status === 'connected') {
      setOpen(false);
      setMessage(
        result.sourceBlocked
          ? '本次会话已连接；原来源暂停记录仍保留，尚不能采集。'
          : '本次会话已连接，尚未验证平台认证；未开始采集。',
      );
      try {
        await onConnected();
      } catch {
        if (mounted.current)
          setMessage('本次会话已连接，状态刷新未确认，请重新读取连接状态。');
      }
    } else {
      setMessage(
        result.status === 'invalid'
          ? '输入格式不正确，请重新填写。'
          : result.status === 'unavailable'
            ? '请在本机程序页面连接会话。'
            : result.status === 'rejected'
              ? '连接被拒绝，请核对本机访问权限和输入。'
              : '连接结果未确认，请重新读取连接状态；不会自动重试。',
      );
    }
  };
  return (
    <div className="w-full space-y-2">
      {!open && (
        <button
          type="button"
          disabled={disabled || sending}
          className="rounded border px-3 py-2 disabled:opacity-50"
          onClick={() => {
            setMessage('');
            setOpen(true);
          }}
        >
          连接本次会话（不保存）
        </button>
      )}
      {open && (
        <form
          ref={form}
          onSubmit={submit}
          autoComplete="off"
          className="space-y-2"
        >
          <p>由本人在本机输入合法会话。仅本次运行有效，重启后不保留。</p>
          <label className="block">
            a1
            <input
              ref={first}
              type="password"
              name="sessionA1"
              required
              maxLength={8192}
              autoComplete="off"
              spellCheck={false}
              disabled={disabled || sending}
              className="ml-2 rounded border bg-transparent px-2 py-1"
            />
          </label>
          <label className="block">
            web_session
            <input
              ref={second}
              type="password"
              name="sessionWeb"
              required
              maxLength={8192}
              autoComplete="off"
              spellCheck={false}
              disabled={disabled || sending}
              className="ml-2 rounded border bg-transparent px-2 py-1"
            />
          </label>
          <p>连接不会验证平台、开始采集或解除原来源暂停记录。</p>
          <button
            type="submit"
            disabled={disabled || sending}
            className="rounded border px-3 py-2 disabled:opacity-50"
          >
            仅本次连接
          </button>{' '}
          <button
            type="button"
            disabled={sending}
            onClick={close}
            className="rounded border px-3 py-2 disabled:opacity-50"
          >
            取消并清空
          </button>
        </form>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
