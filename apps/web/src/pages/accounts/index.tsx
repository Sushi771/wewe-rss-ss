import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  useDisclosure,
  Spinner,
} from '@nextui-org/react';
import { QRCodeSVG } from 'qrcode.react';
import { toast } from 'sonner';
import { PlusIcon } from '@web/components/PlusIcon';
import { StatusDropdown } from '@web/components/StatusDropdown';
import { trpc } from '@web/utils/trpc';
import { statusMap } from '@web/constants';
import { useEffect, useId, useState } from 'react';

const AccountPage = () => {
  const { isOpen, onOpen, onClose, onOpenChange } = useDisclosure();
  const [count, setCount] = useState(0);
  const [reloginAccountId, setReloginAccountId] = useState<string | null>(null);
  const [loginError, setLoginError] = useState('');
  const [connectionAccountId, setConnectionAccountId] = useState<string | null>(
    null,
  );
  const connectionNoticeId = useId();

  const { refetch, data, isFetching } = trpc.account.list.useQuery({});
  const queryUtils = trpc.useUtils();
  const { mutateAsync: updateAccount } = trpc.account.edit.useMutation({});
  const { mutateAsync: deleteAccount } = trpc.account.delete.useMutation({});
  const connection = trpc.account.manualRefreshOptions.useQuery(
    { accountId: connectionAccountId || '0' },
    { enabled: !!connectionAccountId, retry: false },
  );
  const connectManualRefresh = trpc.account.connectManualRefresh.useMutation({
    onSuccess(result) {
      toast.success(result.message);
      setConnectionAccountId(null);
    },
    onError(error) {
      toast.error(error.message);
    },
  });

  const {
    mutateAsync,
    data: loginData,
    reset: resetLogin,
  } = trpc.platform.createLoginUrl.useMutation({
    onError(err) {
      toast.error(err.message || '获取登录二维码失败');
      setLoginError(err.message || '获取登录二维码失败');
      setCount(0);
    },
    onSuccess(data) {
      if (data.uuid) {
        setCount(60);
      }
    },
  });

  const { data: loginResult } = trpc.platform.getLoginResult.useQuery(
    {
      id: loginData?.uuid ?? '',
    },
    {
      refetchInterval: (data) => {
        if (data?.terminal) return false;
        if (
          data?.message &&
          (data.message.includes('过期') || data.message.includes('取消'))
        ) {
          return false;
        }
        return 3000;
      },
      refetchIntervalInBackground: false,
      enabled: !!loginData?.uuid && isOpen && count > 0,
      retry: false,
      onError(err) {
        toast.error(err.message || '登录状态查询失败，已停止本次轮询');
        setCount(0);
      },
      async onSuccess(data) {
        if (data.saved && data.vid) {
          if (reloginAccountId && `${data.vid}` !== reloginAccountId) {
            toast.warning(
              '此次扫码账号与原账号不同，已单独保存；请按昵称核对。',
            );
          } else {
            toast.success(
              '账号已保存；请按昵称和最近扫码记录选择账号，连接手动更新。',
            );
          }
          setReloginAccountId(null);
          onClose();
          refetch();
        } else if (
          data.terminal &&
          data.message &&
          !data.message.includes('扫码') &&
          !data.message.includes('确认')
        ) {
          toast.error(`登录失败: ${data.message}`);
        }
      },
    },
  );

  useEffect(() => {
    let timerId: NodeJS.Timeout;
    if (count > 0 && isOpen) {
      timerId = setTimeout(() => {
        setCount(count - 1);
      }, 1000);
    }
    return () => timerId && clearTimeout(timerId);
  }, [count, isOpen]);

  const invalidAccounts = data?.items.filter((item) => item.status === 0) ?? [];
  const latestLoginAt = data?.items.reduce(
    (latest, item) =>
      Math.max(latest, Date.parse(item.nativeLoginAt || '') || 0),
    0,
  );

  const openRelogin = (accountId: string) => {
    resetLogin();
    setLoginError('');
    setCount(0);
    setReloginAccountId(accountId);
    onOpen();
    void mutateAsync().catch(() => undefined);
  };

  const openAdd = () => {
    resetLogin();
    setLoginError('');
    setCount(0);
    setReloginAccountId(null);
    onOpen();
    void mutateAsync().catch(() => undefined);
  };

  return (
    <div className="flex h-full flex-col">
      {/* 状态栏 */}
      <div className="mac-toolbar">
        <div className="flex flex-1 items-center gap-2 overflow-hidden">
          <span className="truncate text-[15px] font-semibold">
            账号管理 · {data?.items.length || 0}
          </span>
          {isFetching && <Spinner size="sm" color="current" />}
        </div>
        <div className="flex items-center gap-2">
          <Button
            onPress={openAdd}
            size="sm"
            color="primary"
            variant="flat"
            className="h-8 font-medium"
            startContent={<PlusIcon />}
          >
            添加账号
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* 失效账号警告横幅 */}
        {invalidAccounts.length > 0 && (
          <div className="mac-alert-danger mx-4 mt-4">
            <span className="text-[14px]">
              <strong>{invalidAccounts.length}</strong> 个账号 Token
              已标记失效。重新登录只恢复读书会话；文章更新结果以公众号页面为准。
            </span>
          </div>
        )}

        {/* 紧凑列表 */}
        <div className="compact-list mt-4">
          <div className="compact-list-header account-header">
            <div>账号昵称</div>
            <div>状态</div>
            <div>最近扫码登录（北京时间）</div>
            <div className="text-right">操作</div>
          </div>

          {!isFetching && data?.items.length === 0 && (
            <div className="py-20 text-center text-[15px] text-neutral-400">
              暂无账号信息
            </div>
          )}

          {data?.items.map((item) => {
            const isBlocked = data?.blocks.includes(item.id);
            const isInvalid = item.status === 0;
            const generatedName =
              !item.name || item.name === `WeRead_${item.id}`;
            const latestScan =
              !!item.nativeLoginAt &&
              Date.parse(item.nativeLoginAt) === latestLoginAt;

            return (
              <div key={item.id} className="compact-row account-row group">
                {/* Verified platform nickname; stored labels remain separate. */}
                <div className="flex min-w-0 items-center gap-3">
                  {item.platformAvatar && (
                    <img
                      src={item.platformAvatar}
                      alt="微信读书头像"
                      className="h-8 w-8 shrink-0 rounded-full"
                      referrerPolicy="no-referrer"
                    />
                  )}
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="break-words text-[15px] font-medium leading-6 text-neutral-800 dark:text-neutral-200">
                      {item.platformName ||
                        (generatedName
                          ? '昵称未读取'
                          : `保存名称：${item.name}`)}
                    </span>
                    {item.platformName && (
                      <span className="text-[11px] text-neutral-400">
                        微信读书昵称
                      </span>
                    )}
                  </div>
                </div>

                {/* 状态 */}
                <div className="flex shrink-0 items-center">
                  {isBlocked ? (
                    <span className="mac-badge mac-badge-warning">小黑屋</span>
                  ) : item.status === 0 ? (
                    <span className="mac-badge mac-badge-danger">
                      {statusMap[item.status].label}
                    </span>
                  ) : (
                    <StatusDropdown
                      value={item.status}
                      onChange={(value) => {
                        updateAccount({
                          id: item.id,
                          data: { status: value },
                        }).then(() => {
                          toast.success('已更新');
                          refetch();
                        });
                      }}
                    />
                  )}
                </div>

                {/* 时间 */}
                <div className="account-login flex min-w-0 flex-col gap-1 text-[13px] leading-5 text-neutral-400">
                  <span>
                    {item.nativeLoginAt
                      ? new Date(item.nativeLoginAt).toLocaleString('zh-CN', {
                          timeZone: 'Asia/Shanghai',
                          hour12: false,
                        })
                      : '暂无正常扫码记录'}
                  </span>
                  {latestScan && (
                    <span className="text-primary whitespace-nowrap text-xs font-medium">
                      最近扫码登录
                    </span>
                  )}
                </div>

                {/* 操作 */}
                <div className="account-actions flex items-center justify-end gap-2">
                  {isInvalid ? (
                    <span
                      className="mac-action-link"
                      onClick={() => openRelogin(item.id)}
                    >
                      重新登录
                    </span>
                  ) : null}
                  {!isInvalid && (
                    <button
                      className="mac-action-link"
                      onClick={() => openRelogin(item.id)}
                    >
                      重新登录
                    </button>
                  )}
                  {!isInvalid && (
                    <button
                      className="mac-action-link"
                      onClick={() => setConnectionAccountId(item.id)}
                    >
                      连接手动更新
                    </button>
                  )}
                  <span
                    className="mac-action-link danger"
                    onClick={() => {
                      if (window.confirm('确定删除吗？')) {
                        deleteAccount(item.id).then(() => {
                          toast.success('已删除');
                          refetch();
                        });
                      }
                    }}
                  >
                    删除
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <Modal
        isOpen={!!connectionAccountId}
        onClose={() => setConnectionAccountId(null)}
        size="md"
        placement="center"
        scrollBehavior="inside"
        aria-describedby={connectionNoticeId}
        classNames={{
          wrapper: 'account-connection-overlay',
          backdrop: 'account-connection-backdrop',
          base: 'account-connection-dialog',
          header: 'account-connection-header',
          body: 'account-connection-body',
          footer: 'account-connection-footer',
          closeButton: 'account-connection-close',
        }}
      >
        <ModalContent>
          <ModalHeader>连接手动更新</ModalHeader>
          <ModalBody role="region" aria-label="公众号连接状态列表" tabIndex={0}>
            {connection.isFetching ? (
              <Spinner />
            ) : connection.error ? (
              <p>{connection.error.message}</p>
            ) : (
              <>
                <p>{connection.data?.accountLabel}</p>
                <p id={connectionNoticeId} className="text-sm text-neutral-500">
                  仅“可连接”的公众号可以确认。灰色按钮表示暂不可连接，原因见各项说明。连接只保存授权，自动刷新保持关闭。
                </p>
                {!connection.data?.options.length && (
                  <p>当前没有可连接的手动更新公众号。</p>
                )}
                {connection.data?.options.map((option, index) => (
                  <div
                    key={option.mpId}
                    className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-700"
                  >
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <p className="min-w-0 break-words font-medium">
                        {option.name}
                      </p>
                      <span className="rounded bg-neutral-100 px-2 py-1 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                        {option.ready
                          ? '可连接'
                          : option.reason === 'source-unconfigured'
                            ? '未配置来源'
                            : option.reason === 'different-channel'
                              ? '其他更新通道'
                              : '会话暂不可用'}
                      </span>
                    </div>
                    <p
                      id={`${connectionNoticeId}-${index}`}
                      className="mb-3 break-words text-sm text-neutral-500"
                    >
                      {option.message}
                    </p>
                    <Button
                      size="sm"
                      color={option.ready ? 'primary' : 'default'}
                      variant={option.ready ? 'solid' : 'flat'}
                      aria-describedby={`${connectionNoticeId}-${index}`}
                      isDisabled={!option.ready}
                      isLoading={connectManualRefresh.isLoading}
                      onPress={() => {
                        if (!option.ready || connectManualRefresh.isLoading)
                          return;
                        if (
                          window.confirm(
                            `确认使用 ${connection.data?.accountLabel} 连接“${option.name}”？以后点击刷新将读取最新10篇正文及图片，遇限制即停止，旧文章保留。此次连接不会发取文请求。`,
                          )
                        ) {
                          connectManualRefresh.mutate({
                            accountId: connectionAccountId!,
                            mpId: option.mpId,
                            revision: option.revision,
                            confirm: true,
                          });
                        }
                      }}
                    >
                      {option.ready ? '确认连接' : '暂不可连接'}
                    </Button>
                  </div>
                ))}
              </>
            )}
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={() => setConnectionAccountId(null)}>
              返回账号管理
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* 登录弹窗 */}
      <Modal
        isOpen={isOpen}
        onOpenChange={async () => {
          onOpenChange();
          setReloginAccountId(null);
          await queryUtils.platform.getLoginResult.cancel();
        }}
        size="xs"
        backdrop="blur"
        classNames={{
          base: 'rounded-2xl',
          header: 'border-b-[0.5px] border-neutral-100 dark:border-neutral-800',
        }}
      >
        <ModalContent>
          {() => (
            <>
              <ModalHeader>
                <span className="text-[17px] font-semibold">
                  {reloginAccountId ? '重新授权' : '添加读书账号'}
                </span>
              </ModalHeader>
              <ModalBody className="py-8">
                <div className="flex flex-col items-center">
                  {reloginAccountId && (
                    <div className="mb-6 rounded-lg bg-orange-50 px-3 py-2 text-center text-[13px] text-orange-500 dark:bg-orange-900/20">
                      请使用所选账号的微信扫码
                    </div>
                  )}
                  {loginError ? (
                    <div className="text-[14px] text-red-500">{loginError}</div>
                  ) : loginData ? (
                    <div className="relative rounded-xl border border-neutral-100 bg-white p-3 shadow-sm">
                      {loginResult?.message && (
                        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-white/90 p-4 text-center">
                          <span className="text-[15px] font-medium text-neutral-800">
                            {loginResult.message}
                          </span>
                        </div>
                      )}
                      <QRCodeSVG size={180} value={loginData.scanUrl} />
                    </div>
                  ) : (
                    <div className="flex h-[200px] flex-col items-center justify-center gap-3">
                      <Spinner color="primary" />
                      <span className="text-[14px] text-neutral-400">
                        生成二维码...
                      </span>
                    </div>
                  )}
                  <div className="mt-6 text-[14px] font-medium text-neutral-500">
                    微信扫码登录{' '}
                    {!loginResult?.message && count > 0 && (
                      <span className="text-red-500">({count}s)</span>
                    )}
                  </div>
                </div>
              </ModalBody>
            </>
          )}
        </ModalContent>
      </Modal>
    </div>
  );
};

export default AccountPage;
