import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  Button,
  useDisclosure,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
  Chip,
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
  // 当重新登录某个失效账号时，记录其 ID，用于更新而非新建
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
            // 重新登录：更新已有账号的 token 并重新启用
            await updateAccount({
              id: reloginAccountId,
              data: { token: data.token, status: 1 /* ENABLE */ },
            });
            toast.success('重新登录成功', {
              description: `账号 ${reloginAccountId} Token 已更新`,
            });
            setReloginAccountId(null);
          } else {
            // 新增账号
            await addAccount({ id: `${data.vid}`, name, token: data.token });
            toast.success('添加成功', {
              description: `用户名：${name}(${data.vid})`,
            });
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
    let timerId;
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
    <div>
      {/* 失效账号警告横幅 */}
      {invalidAccounts.length > 0 && (
        <div className="mx-4 mt-4 p-3 bg-red-50 border border-red-300 rounded-lg flex items-center gap-2 text-red-700 text-sm">
          <span className="text-lg">⚠️</span>
          <span>
            有 <strong>{invalidAccounts.length}</strong> 个账号 Token 已失效（微信读书重新登录过或被踢下线），订阅无法自动更新。请点击对应账号的
            <strong>「重新登录」</strong>按钮扫码恢复。
          </span>
        </div>
      )}

      <div className="flex justify-between m-4">
        <div className="font-bold">共{data?.items.length || 0}个账号</div>
        <Button
          onPress={openAdd}
          size="sm"
          color="primary"
          endContent={<PlusIcon />}
        >
          添加读书账号
        </Button>
      </div>
      <Table aria-label="Example static collection table">
        <TableHeader>
          <TableColumn>ID</TableColumn>
          <TableColumn>用户名</TableColumn>
          <TableColumn>状态</TableColumn>
          <TableColumn>更新时间</TableColumn>
          <TableColumn>操作</TableColumn>
        </TableHeader>
        <TableBody
          emptyContent={<div className="m-auto text-center">暂无数据</div>}
          isLoading={isFetching}
          loadingContent={<Spinner />}
        >
          {data?.items.map((item) => {
            const isBlocked = data?.blocks.includes(item.id);
            const isInvalid = item.status === 0;

            return (
              <TableRow key={item.id}>
                <TableCell>{item.id}</TableCell>
                <TableCell>{item.name}</TableCell>
                <TableCell>
                  {isBlocked ? (
                    <Chip className="capitalize" size="sm" variant="flat">
                      今日小黑屋
                    </Chip>
                  ) : (
                    <Chip
                      className="capitalize"
                      color={statusMap[item.status].color}
                      size="sm"
                      variant="flat"
                    >
                      {statusMap[item.status].label}
                    </Chip>
                  )}
                </TableCell>
                <TableCell>
                  {dayjs(item.updatedAt).format('YYYY-MM-DD')}
                </TableCell>
                <TableCell className="flex gap-2">
                  {isInvalid ? (
                    // 失效账号：只显示"重新登录"和"删除"
                    <Button
                      size="sm"
                      color="warning"
                      onPress={() => openRelogin(item.id)}
                    >
                      重新登录
                    </Button>
                  ) : (
                    <StatusDropdown
                      value={item.status}
                      onChange={(value) => {
                        updateAccount({
                          id: item.id,
                          data: { status: value },
                        }).then(() => {
                          toast.success('更新成功!');
                          refetch();
                        });
                      }}
                    ></StatusDropdown>
                  )}

                  <Button
                    size="sm"
                    color="danger"
                    onPress={() => {
                      deleteAccount(item.id).then(() => {
                        toast.success('删除成功!');
                        refetch();
                      });
                    }}
                  >
                    删除
                  </Button>
                </TableCell>
              </TableRow>
            );
          }) || []}
        </TableBody>
      </Table>

      <Modal
        isOpen={isOpen}
        onOpenChange={async () => {
          onOpenChange();
          setReloginAccountId(null);
          await queryUtils.platform.getLoginResult.cancel();
        }}
      >
        <ModalContent>
          {() => (
            <>
              <ModalHeader className="flex flex-col gap-1">
                {reloginAccountId
                  ? `重新登录账号 ${reloginAccountId}`
                  : '添加读书账号'}
              </ModalHeader>
              <ModalBody>
                <div className="m-auto pb-8 text-center">
                  {reloginAccountId && (
                    <div className="mb-3 text-sm text-orange-600 bg-orange-50 border border-orange-200 rounded p-2">
                      请使用账号 <strong>{reloginAccountId}</strong> 对应的微信扫描下方二维码重新授权
                    </div>
                  )}
                  {loginData ? (
                    <div>
                      <div className="relative">
                        {loginResult?.message && (
                          <div className="absolute top-0 left-0 bottom-0 right-0 bg-white bg-opacity-75 flex justify-center items-center">
                            <div className="text-xl">
                              {loginResult?.message}
                            </div>
                          </div>
                        )}
                        <QRCodeSVG size={150} value={loginData?.scanUrl} />
                      </div>
                      <div className="mt-4">
                        微信扫码登录{' '}
                        {!loginResult?.message && count > 0 && (
                          <span className="text-red-400">({count}s)</span>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="m-auto flex justify-center align-middle items-center">
                      <Spinner />
                      二维码加载中
                    </div>
                  )}
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
