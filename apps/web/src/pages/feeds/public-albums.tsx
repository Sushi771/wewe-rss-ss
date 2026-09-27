import { useState } from 'react';
import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from '@nextui-org/react';
import { trpc } from '@web/utils/trpc';
import { toast } from 'sonner';

export default function PublicAlbums({
  mpId,
  name,
  albumIds,
  hasLocalDirectory,
  isDisabled,
  onBusyChange,
  onResult,
}: {
  mpId: string;
  name: string;
  albumIds: string[];
  hasLocalDirectory: boolean;
  isDisabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onResult: (source: string, message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const collector = trpc.collection.collectPublicAlbums.useMutation();
  const utils = trpc.useUtils();
  const ids = [...new Set(input.split(/[,，\s]+/).filter(Boolean))];
  const invalid = ids.some((id) => !/^\d+$/.test(id));
  const busy = collector.isLoading || isDisabled;

  return (
    <>
      <Button
        size="sm"
        className="mac-btn-outline"
        isDisabled={busy}
        onPress={() => {
          setInput(albumIds.join(', '));
          collector.reset();
          setOpen(true);
        }}
      >
        公开合集补采
      </Button>
      <Modal
        isOpen={open}
        onOpenChange={setOpen}
        size="2xl"
        isDismissable={!busy}
        hideCloseButton={busy}
      >
        <ModalContent>
          <ModalHeader>公开合集补采 · {name}</ModalHeader>
          <ModalBody>
            <p className="text-sm">
              输入当前公众号的公开合集 ID，多个 ID 用逗号分隔。可从合集链接的
              album_id 参数取得
              ID。采集会读取所选合集的所有可返回页面，成功后绑定这些合集，之后点击“更新”将在线刷新它们。
            </p>
            <Input
              label="公开合集 ID"
              placeholder="多个合集 ID 用逗号分隔"
              value={input}
              onValueChange={setInput}
              isDisabled={busy}
              isInvalid={invalid}
              errorMessage={
                invalid ? '请只填写数字 ID，并以逗号分隔' : undefined
              }
            />
            <p className="rounded-lg bg-orange-50 p-3 text-sm text-orange-800 dark:bg-orange-950 dark:text-orange-200">
              只补采所选公开合集。合集外文章和同次推送的次条是否完整，尚未验证；该通道不提供阅读、点赞或收藏数据。
            </p>
            {hasLocalDirectory && (
              <p className="text-sm text-orange-700 dark:text-orange-300">
                当前已绑定本地目录。点击下方“补采并改用公开合集”后，后续“更新”将改用公开合集来源。
              </p>
            )}
            {collector.error && (
              <p role="alert" className="text-sm text-red-600">
                补采失败：{collector.error.message}
              </p>
            )}
          </ModalBody>
          <ModalFooter>
            <Button
              variant="light"
              isDisabled={busy}
              onPress={() => setOpen(false)}
            >
              关闭
            </Button>
            <Button
              color="primary"
              isDisabled={busy || invalid || !ids.length}
              isLoading={collector.isLoading}
              onPress={async () => {
                onBusyChange(true);
                try {
                  const result = await collector.mutateAsync({
                    mpId,
                    albumIds: ids,
                  });
                  await Promise.all([
                    utils.feed.list.invalidate(),
                    utils.article.list.reset(),
                    utils.article.summary.invalidate(),
                  ]);
                  onResult(result.source, result.message);
                  toast.warning(result.message, { duration: 12000 });
                  setOpen(false);
                } catch (error) {
                  const message =
                    error instanceof Error ? error.message : '补采失败';
                  onResult('error', message);
                  toast.error(message);
                } finally {
                  onBusyChange(false);
                }
              }}
            >
              {hasLocalDirectory ? '补采并改用公开合集' : '补采并绑定合集'}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
}
