import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getAuthCode } from '@web/utils/auth';
import { privateOnlineMode } from '@web/utils/env';
import {
  savedSessionRequest,
  savedSessionStatus,
  type SavedSessionStatus,
} from '@web/utils/xhs-saved-connection';

export default function XhsSavedConnection() {
  const [status, setStatus] = useState<SavedSessionStatus>();
  const [statusError, setStatusError] = useState(false);
  const [statusVersion, setStatusVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let current = true;
    setStatusError(false);
    void savedSessionStatus(
      {
        origin: window.location.origin,
        privateMode: privateOnlineMode,
        authCode: getAuthCode,
        send: (url, init) => window.fetch(url, init),
      },
      controller.signal,
    )
      .then((result) => {
        if (current) setStatus(result);
      })
      .catch(() => {
        if (current) {
          setStatus(undefined);
          setStatusError(true);
        }
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      current = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [statusVersion]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(false);
  const [message, setMessage] = useState('');
  const first = useRef<HTMLInputElement>(null);
  const second = useRef<HTMLInputElement>(null);
  const auto = useRef<HTMLInputElement>(null);
  const replace = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const request = useRef<AbortController>();
  const generation = useRef(0);
  const clear = () => {
    if (first.current) first.current.value = '';
    if (second.current) second.current.value = '';
  };
  useLayoutEffect(() => {
    const fields = [first.current, second.current];
    return () => {
      generation.current += 1;
      request.current?.abort();
      for (const field of fields) if (field) field.value = '';
    };
  }, [open]);
  const close = () => {
    clear();
    setVisible(false);
    setBusy(false);
    setOpen(false);
    setMessage('');
  };
  const run = async (save: boolean) => {
    if (busy || (save && !form.current?.reportValidity())) return;
    const version = ++generation.current;
    const controller = new AbortController();
    request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    setBusy(true);
    setMessage('');
    const input = save
      ? {
          a1: first.current?.value ?? '',
          webSession: second.current?.value ?? '',
          replaceSaved: !!replace.current?.checked,
          autoRestore: !!auto.current?.checked,
        }
      : undefined;
    clear();
    setVisible(false);
    try {
      const result = await savedSessionRequest(
        {
          origin: window.location.origin,
          privateMode: privateOnlineMode,
          authCode: getAuthCode,
          send: (url, init) => window.fetch(url, init),
        },
        input,
        controller.signal,
      );
      if (result) {
        if (generation.current === version) {
          if (first.current) first.current.value = result.a1;
          if (second.current) second.current.value = result.webSession;
          setVisible(true);
          setMessage('已显示本机保存的凭证；关闭后清空页面内容。');
        }
        result.a1 = '';
        result.webSession = '';
      } else if (generation.current === version) {
        setStatusVersion((value) => value + 1);
        setMessage(
          '已加密保存并连接。凭证可能自然失效；失效后请在此更新。未自动开始采集。',
        );
      }
    } catch {
      if (generation.current === version)
        setMessage(
          save
            ? '保存未确认。若已有保存记录，请明确勾选替换；检查本机连接状态后再操作。'
            : '无法读取保存记录，请检查本机服务和权限。',
        );
    } finally {
      clearTimeout(timeout);
      if (generation.current === version) setBusy(false);
    }
  };
  return (
    <section
      aria-label="小红书登录凭证"
      className="space-y-3 rounded-lg border p-4"
    >
      <h2 className="font-semibold">小红书登录凭证</h2>
      <p className="text-default-500 text-sm">
        仅在本机加密保存，供本机采集程序使用。登录可能失效，届时重新获取并更新凭证。
      </p>
      {status?.needsReconnect && (
        <p role="alert">登录已失效，请更新小红书凭证</p>
      )}
      {status?.restoreFailed && (
        <p role="alert">本机登录恢复失败，请重新连接小红书凭证。</p>
      )}
      {status && (
        <p role="status" className="text-sm">
          {status.sessionPresent
            ? '本机已有登录会话（平台有效性以采集回执为准）'
            : '本机尚未连接登录会话'}
          ；重启自动恢复{status.autoRestore ? '已开启' : '未开启'}。
        </p>
      )}
      {statusError && <p role="status">本机登录状态读取失败，请刷新重试。</p>}
      <button
        type="button"
        className="rounded border px-3 py-2"
        onClick={() => setStatusVersion((value) => value + 1)}
      >
        刷新登录状态
      </button>
      {!open ? (
        <button
          className="rounded border px-3 py-2"
          onClick={() => setOpen(true)}
        >
          管理小红书凭证
        </button>
      ) : (
        <form
          ref={form}
          autoComplete="off"
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void run(true);
          }}
        >
          <p className="text-sm">
            凭证等同登录钥匙；显示时请避免共享屏幕。关闭或离开页面会清空输入。
          </p>
          <label className="block">
            a1
            <input
              ref={first}
              type={visible ? 'text' : 'password'}
              required
              maxLength={8192}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              className="ml-2 rounded border bg-transparent p-2"
            />
          </label>
          <label className="block">
            web_session
            <input
              ref={second}
              type={visible ? 'text' : 'password'}
              required
              maxLength={8192}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              className="ml-2 rounded border bg-transparent p-2"
            />
          </label>
          <button
            type="button"
            disabled={busy}
            className="rounded border px-3 py-2"
            onClick={() => setVisible((value) => !value)}
          >
            {visible ? '遮罩输入' : '显示输入'}
          </button>{' '}
          <button
            type="button"
            disabled={busy}
            className="rounded border px-3 py-2"
            onClick={() => void run(false)}
          >
            读取并显示本机已保存凭证
          </button>
          <label className="block text-sm">
            <input ref={auto} type="checkbox" disabled={busy} />{' '}
            重启后自动恢复此登录状态（用于持续采集）
          </label>
          <label className="block text-sm">
            <input ref={replace} type="checkbox" disabled={busy} />{' '}
            我确认替换本机旧凭证记录（旧值将被覆盖）
          </label>
          <button
            type="submit"
            disabled={busy}
            className="rounded border px-3 py-2"
          >
            {busy ? '处理中…' : '加密保存并连接'}
          </button>{' '}
          <button
            type="button"
            className="rounded border px-3 py-2"
            onClick={close}
          >
            关闭并清空
          </button>
        </form>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
    </section>
  );
}
