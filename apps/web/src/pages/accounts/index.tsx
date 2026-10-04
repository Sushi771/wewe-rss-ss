import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  Button,
  useDisclosure,
  Spinner,
  Tooltip,
} from '@nextui-org/react';
import { QRCodeSVG } from 'qrcode.react';
import { toast } from 'sonner';
import { PlusIcon } from '@web/components/PlusIcon';
import { StatusDropdown } from '@web/components/StatusDropdown';
import { trpc } from '@web/utils/trpc';
import { statusMap } from '@web/constants';
import { useEffect, useState } from 'react';

const AccountPage = () => {
  const { isOpen, onOpen, onClose, onOpenChange } = useDisclosure();
  const [count, setCount] = useState(0);
  const [reloginAccountId, setReloginAccountId] = useState<string | null>(null);
  const [loginError, setLoginError] = useState('');
  const [connectionAccountId, setConnectionAccountId] = useState<string | null>(
    null,
  );

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
          const accountSuffix = String(data.vid).slice(-4);
          if (reloginAccountId && `${data.vid}` !== reloginAccountId) {
            toast.warning(
              `扫码账号（末四位 ${accountSuffix}）与原账号（末四位 ${reloginAccountId.slice(-4)}）不一致，已作为新账号保存`,
            );
          } else {
            toast.success(
              `账号已保存，编号末四位 ${accountSuffix}；请按“最近扫码登录”识别后连接手动更新。`,
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
        <p className="mx-4 mt-4 text-sm text-neutral-500">
          优先显示已核验的微信读书昵称。扫码时间和编号末四位帮助区分账号；昵称未读取时会明确标注，保存名称不冒充平台昵称。
        </p>
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
          <div className="compact-list-header">
            <div className="w-[180px] px-4">账号标识</div>
            <div className="w-[120px]">状态</div>
            <div className="flex-1">最近扫码登录（北京时间）</div>
            <div className="w-[280px] px-4 text-right">操作</div>
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
              <div key={item.id} className="compact-row group">
                {/* Verified platform nickname; stored labels remain separate. */}
                <div className="w-[180px] px-4">
                  <Tooltip
                    content={`读书账号编号末四位：${item.id.slice(-4)}`}
                    placement="right"
                    closeDelay={0}
                  >
                    <div className="flex cursor-default flex-col overflow-hidden">
                      <span className="truncate text-[15px] font-medium text-neutral-800 dark:text-neutral-200">
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
                      {item.platformAvatar && (
                        <img
                          src={item.platformAvatar}
                          alt="微信读书头像"
                          className="h-7 w-7 rounded-full"
                          referrerPolicy="no-referrer"
                        />
                      )}
                      <span className="text-[11px] text-neutral-400">
                        编号末四位 {item.id.slice(-4)}
                      </span>
                      {latestScan && (
                        <span className="text-primary text-xs font-medium">
                          最近扫码登录
                        </span>
                      )}
                    </div>
                  </Tooltip>
                </div>

                {/* 状态 */}
                <div className="w-[120px]">
                  {isBlocked ? (
                    <span className="mac-badge mac-badge-warning">小黑屋</span>
                  ) : item.status === 0 ? (
                    <span className="mac-badge mac-badge-danger">
                      {statusMap[item.status].label}
                    </span>
                  ) : (
                    <span className="mac-badge mac-badge-success">
                      {statusMap[item.status].label}
                    </span>
                  )}
                </div>

                {/* 时间 */}
                <div className="flex-1 text-[13px] text-neutral-400">
                  {item.nativeLoginAt
                    ? new Date(item.nativeLoginAt).toLocaleString('zh-CN', {
                        timeZone: 'Asia/Shanghai',
                        hour12: false,
                      })
                    : '暂无正常扫码记录'}
                </div>

                {/* 操作 */}
                <div className="flex w-[280px] items-center justify-end gap-3 px-4">
                  {isInvalid ? (
                    <span
                      className="mac-action-link"
                      onClick={() => openRelogin(item.id)}
                    >
                      重新登录
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
                    ></StatusDropdown>
                  )}
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
      >
        <ModalContent>
          <ModalHeader>连接手动更新</ModalHeader>
          <ModalBody className="pb-6">
            {connection.isFetching ? (
              <Spinner />
            ) : connection.error ? (
              <p>{connection.error.message}</p>
            ) : (
              <>
                <p>{connection.data?.accountLabel}</p>
                <p className="text-sm text-neutral-500">
                  请选择使用此账号更新的公众号。连接后请在公众号页点击原刷新按钮；自动刷新保持关闭。
                </p>
                {!connection.data?.options.length && (
                  <p>当前没有可连接的手动更新公众号。</p>
                )}
                {connection.data?.options.map((option) => (
                  <div
                    key={option.mpId}
                    className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-700"
                  >
                    <p className="mb-2 font-medium">{option.name}</p>
                    <p className="mb-3 text-sm text-neutral-500">
                      {option.message}
                    </p>
                    <Button
                      size="sm"
                      color="primary"
                      isDisabled={!option.ready}
                      isLoading={connectManualRefresh.isLoading}
                      onPress={() => {
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
                      确认连接
                    </Button>
                  </div>
                ))}
              </>
            )}
          </ModalBody>
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
                      请使用编号末四位{' '}
                      <strong>{reloginAccountId.slice(-4)}</strong>{' '}
                      对应的账号扫码
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
