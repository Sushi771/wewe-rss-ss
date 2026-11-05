import { Modal } from '@web/components/AppOverlays';
import {
  Button,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Spinner,
} from '@nextui-org/react';
import { useEffect, useRef, useState } from 'react';
import { trpc } from '@web/utils/trpc';

type LoginView = ReturnType<
  typeof trpc.account.wechat2rssLoginStart.useMutation
>['data'];

const AccountPage = () => {
  const [isOpen, setOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [login, setLogin] = useState<LoginView>();
  const hasQr = login?.state === 'waiting' && Boolean(login.qrcode);
  const [error, setError] = useState('');
  const [showLegacy, setShowLegacy] = useState(false);
  const active = useRef(false);
  const generation = useRef(0);
  const sessionId = useRef<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const checkingRef = useRef(false);
  const mounted = useRef(true);
  const accounts = trpc.account.wechat2rssAccounts.useQuery(undefined, {
    enabled: false,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: false,
  });
  const legacy = trpc.account.list.useQuery(
    {},
    { enabled: showLegacy, retry: false, refetchOnWindowFocus: false },
  );
  const start = trpc.account.wechat2rssLoginStart.useMutation({ retry: false });
  const poll = trpc.account.wechat2rssLoginPoll.useMutation({ retry: false });
  const close = trpc.account.wechat2rssLoginClose.useMutation({ retry: false });
  const closeAction = useRef(close.mutateAsync);
  closeAction.current = close.mutateAsync;

  const stopTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
  };
  const release = (id?: string) => {
    if (id) void closeAction.current({ sessionId: id }).catch(() => {});
  };
  const finish = (result: LoginView) => {
    active.current = false;
    stopTimer();
    release(sessionId.current);
    sessionId.current = undefined;
    setLogin(result);
    if (result?.state === 'succeeded') void accounts.refetch();
  };
  const schedule = (version: number, expiresAt: number, rounds = 0) => {
    timer.current = setTimeout(
      async () => {
        if (
          !mounted.current ||
          !active.current ||
          generation.current !== version
        )
          return;
        if (Date.now() >= expiresAt || rounds >= 60) {
          finish({
            state: 'expired',
            message: '本次登录已过期，请手动重新获取二维码。',
          });
          return;
        }
        try {
          const result = await poll.mutateAsync({
            sessionId: sessionId.current!,
          });
          if (
            !mounted.current ||
            !active.current ||
            generation.current !== version
          )
            return;
          if (result.state !== 'waiting') {
            finish(result);
            return;
          }
          setLogin(result);
          schedule(version, expiresAt, rounds + 1);
        } catch {
          if (
            !mounted.current ||
            !active.current ||
            generation.current !== version
          )
            return;
          finish({
            state: 'failed',
            message: '登录状态读取失败，请手动重试。',
          });
        }
      },
      Math.min(3000, Math.max(0, expiresAt - Date.now())),
    );
  };
  const begin = async () => {
    if (active.current) return;
    active.current = true;
    const version = ++generation.current;
    stopTimer();
    setOpen(true);
    setStarting(true);
    setLogin(undefined);
    setError('');
    try {
      const result = await start.mutateAsync();
      if (
        !mounted.current ||
        !active.current ||
        generation.current !== version
      ) {
        release(result.sessionId);
        return;
      }
      setLogin(result);
      if (result.state === 'waiting' && result.sessionId && result.expiresAt) {
        sessionId.current = result.sessionId;
        schedule(version, Math.min(result.expiresAt, Date.now() + 180_000));
      } else finish(result);
    } catch {
      if (!mounted.current || !active.current || generation.current !== version)
        return;
      finish({ state: 'failed', message: '二维码获取失败，请手动重试。' });
    } finally {
      if (mounted.current && generation.current === version) setStarting(false);
    }
  };
  const dismiss = () => {
    generation.current++;
    active.current = false;
    stopTimer();
    release(sessionId.current);
    sessionId.current = undefined;
    setOpen(false);
    setStarting(false);
    setLogin(undefined);
  };
  const check = async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    setError('');
    try {
      await accounts.refetch({ throwOnError: true });
    } catch {
      if (mounted.current) setError('账号状态读取失败，请手动重试。');
    } finally {
      checkingRef.current = false;
      if (mounted.current) setChecking(false);
    }
  };
  useEffect(() => {
    const epoch = generation;
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current = false;
      epoch.current++;
      if (timer.current) clearTimeout(timer.current);
      if (sessionId.current)
        void closeAction
          .current({ sessionId: sessionId.current })
          .catch(() => {});
      sessionId.current = undefined;
    };
  }, []);

  const snapshot = error || accounts.isError ? undefined : accounts.data;
  return (
    <div className="space-y-5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Wechat2RSS 账号</h1>
        <div className="flex flex-wrap gap-2">
          <Button
            as="a"
            href="http://127.0.0.1:18080/#/"
            target="_blank"
            rel="noopener noreferrer"
            variant="flat"
          >
            打开 Wechat2RSS 后台
          </Button>
          <Button onPress={check} isLoading={checking}>
            刷新账号状态
          </Button>
          <Button
            color="primary"
            onPress={begin}
            isDisabled={starting || login?.state === 'waiting'}
          >
            添加微信账号
          </Button>
        </div>
      </div>
      <p className="text-default-500 text-sm">
        在此扫描二维码登录，微信扫码和官方确认由你完成。账号保存在 Wechat2RSS
        实例中。
      </p>
      <section
        aria-label="Wechat2RSS 账号状态"
        className="space-y-3 rounded-lg border p-4"
      >
        <p role="status">
          {error ||
            (accounts.isError
              ? '账号状态读取失败，请手动重试。'
              : snapshot?.message || '尚未读取账号状态，请点击刷新账号状态。')}
        </p>
        {snapshot?.checkedAt && (
          <p className="text-default-500 text-xs">
            检查时间：{snapshot.checkedAt}
          </p>
        )}
        {snapshot?.accounts.map((account, index) => (
          <div
            key={index}
            className="flex flex-wrap justify-between gap-2 border-t pt-3"
          >
            <span>{account.name}</span>
            <span>
              {account.needCheck
                ? '待官方验证'
                : account.available
                  ? '账号可用'
                  : '账号暂不可用'}
            </span>
            {account.needCheck && account.waitTime && (
              <span className="text-sm">等待至：{account.waitTime}</span>
            )}
          </div>
        ))}
      </section>
      <details
        onToggle={(event) => setShowLegacy(event.currentTarget.open)}
        className="rounded-lg border p-3"
      >
        <summary className="cursor-pointer text-sm">
          旧本地账号记录（只读）
        </summary>
        <p className="text-default-500 mt-2 text-xs">
          保留原有记录；这些记录不表示 Wechat2RSS 已登录。
        </p>
        {showLegacy && legacy.isFetching && <Spinner size="sm" />}
        {showLegacy && legacy.isError && <p>旧记录读取失败。</p>}
        {showLegacy &&
          legacy.data?.items.map((account) => (
            <p key={account.id} className="mt-2 text-sm">
              {account.name || '旧账号'}
            </p>
          ))}
      </details>
      <Modal
        isOpen={isOpen}
        classNames={{ base: hasQr ? 'wechat-qr-dialog' : '' }}
        onOpenChange={(open) => {
          if (!open) dismiss();
        }}
        onClose={dismiss}
      >
        <ModalContent>
          <ModalHeader>
            {hasQr ? '微信扫码登录' : '登录 Wechat2RSS 微信账号'}
          </ModalHeader>
          <ModalBody
            className={hasQr ? 'wechat-qr-body' : undefined}
            tabIndex={0}
            role="region"
            aria-label="Wechat2RSS 登录状态与二维码"
          >
            {starting && <Spinner label="正在获取二维码…" />}
            {!starting && login?.state === 'waiting' && !login.qrcode && (
              <Spinner label="正在生成二维码…" />
            )}
            {hasQr ? (
              <div className="wechat-qr-layout">
                <img
                  src={login?.qrcode}
                  alt="Wechat2RSS 微信登录二维码"
                  className="wechat-login-qr"
                />
                <div className="wechat-qr-instructions">
                  <p role="status">{login?.message}</p>
                  <p className="text-default-500 text-xs">
                    请用微信扫描完整二维码。关闭窗口会停止检查登录状态。
                  </p>
                  <p className="wechat-qr-short-hint text-xs">
                    窗口较矮；若扫码困难，请增大窗口或降低浏览器缩放。
                  </p>
                  <p className="wechat-qr-too-small text-sm" role="status">
                    窗口高度不足，无法完整显示二维码。请增大窗口或降低浏览器缩放后扫码。
                  </p>
                </div>
              </div>
            ) : (
              <p role="status">{login?.message}</p>
            )}
            {login?.state === 'waiting' && !hasQr && (
              <p className="text-default-500 text-xs">
                二维码最多等待三分钟。关闭窗口会停止检查登录状态。
              </p>
            )}
          </ModalBody>
          {!hasQr && (
            <ModalFooter>
              {login &&
                login.state !== 'waiting' &&
                login.state !== 'succeeded' && (
                  <Button onPress={begin}>重新获取二维码</Button>
                )}
              <Button onPress={dismiss}>关闭</Button>
            </ModalFooter>
          )}
        </ModalContent>
      </Modal>
    </div>
  );
};
export default AccountPage;
