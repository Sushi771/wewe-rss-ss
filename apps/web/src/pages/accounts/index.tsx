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
import dayjs from 'dayjs';
import { StatusDropdown } from '@web/components/StatusDropdown';
import { trpc } from '@web/utils/trpc';
import { statusMap } from '@web/constants';
import { useEffect, useState } from 'react';

const AccountPage = () => {
  const { isOpen, onOpen, onClose, onOpenChange } = useDisclosure();
  const [count, setCount] = useState(0);
  const [reloginAccountId, setReloginAccountId] = useState<string | null>(null);

  const { refetch, data, isFetching } = trpc.account.list.useQuery({});
  const queryUtils = trpc.useUtils();
  const { mutateAsync: updateAccount } = trpc.account.edit.useMutation({});
  const { mutateAsync: deleteAccount } = trpc.account.delete.useMutation({});
  const { mutateAsync: addAccount } = trpc.account.add.useMutation({});

  const { mutateAsync, data: loginData } =
    trpc.platform.createLoginUrl.useMutation({
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
      refetchIntervalInBackground: false,
      enabled: !!loginData?.uuid,
      async onSuccess(data) {
        if (data.vid && data.token) {
          const name = data.username!;
          if (reloginAccountId) {
            await updateAccount({
              id: reloginAccountId,
              data: { token: data.token, status: 1 },
            });
            toast.success('重新登录成功');
            setReloginAccountId(null);
          } else {
            await addAccount({ id: `${data.vid}`, name, token: data.token });
            toast.success('添加成功');
          }
          onClose();
          refetch();
        } else if (data.message) {
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

  const openRelogin = (accountId: string) => {
    setReloginAccountId(accountId);
    onOpen();
    mutateAsync();
  };

  const openAdd = () => {
    setReloginAccountId(null);
    onOpen();
    mutateAsync();
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
              已失效，订阅无法更新。请重新登录扫码恢复。
            </span>
          </div>
        )}

        {/* 紧凑列表 */}
        <div className="compact-list mt-4">
          <div className="compact-list-header">
            <div className="w-[180px] px-4">用户名</div>
            <div className="w-[120px]">状态</div>
            <div className="flex-1">上次活跃</div>
            <div className="w-[160px] px-4 text-right">操作</div>
          </div>

          {!isFetching && data?.items.length === 0 && (
            <div className="py-20 text-center text-[15px] text-neutral-400">
              暂无账号信息
            </div>
          )}

          {data?.items.map((item) => {
            const isBlocked = data?.blocks.includes(item.id);
            const isInvalid = item.status === 0;

            return (
              <div key={item.id} className="compact-row group">
                {/* 用户名 + ID (Hover) */}
                <div className="w-[180px] px-4">
                  <Tooltip
                    content={`VID: ${item.id}`}
                    placement="right"
                    closeDelay={0}
                  >
                    <div className="flex cursor-default flex-col overflow-hidden">
                      <span className="truncate text-[15px] font-medium text-neutral-800 dark:text-neutral-200">
                        {item.name}
                      </span>
                      <span className="text-[11px] text-neutral-400">
                        WeRead Account
                      </span>
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
                  {dayjs(item.updatedAt).format('YYYY-MM-DD HH:mm')}
                </div>

                {/* 操作 */}
                <div className="flex w-[160px] items-center justify-end gap-4 px-4">
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
                      请使用账号 <strong>{reloginAccountId}</strong> 扫码
                    </div>
                  )}
                  {loginData ? (
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
