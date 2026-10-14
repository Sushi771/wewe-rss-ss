import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from '@nextui-org/react';
import { useMemo, useState } from 'react';

export type FolderMember = { id: string; name: string; groupId: string | null };
const PAGE_SIZE = 50;
const BATCH_LIMIT = 100;

/** Page only the rendered options; selection survives search and pagination. */
export default function FolderMemberPicker({
  folder,
  members,
  disabled,
  error,
  onClose,
  onAdd,
}: {
  folder: { id: string; name: string };
  members: FolderMember[];
  disabled: boolean;
  error?: string;
  onClose: () => void;
  onAdd: (ids: string[]) => Promise<boolean>;
}) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const candidates = useMemo(
    () =>
      Array.from(
        new Map(members.map((member) => [member.id, member])).values(),
      ),
    [members],
  );
  const matches = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return candidates.filter((member) =>
      member.name.toLocaleLowerCase().includes(query),
    );
  }, [candidates, search]);
  const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const visible = matches.slice(
    currentPage * PAGE_SIZE,
    (currentPage + 1) * PAGE_SIZE,
  );
  const available = new Set(
    candidates
      .filter((member) => member.groupId !== folder.id)
      .map((member) => member.id),
  );
  const ids = [...selected].filter((id) => available.has(id));
  const toggle = (id: string) =>
    setSelected((previous) => {
      const next = new Set([...previous].filter((id) => available.has(id)));
      if (!available.has(id)) return next;
      if (next.has(id)) next.delete(id);
      else if (next.size < BATCH_LIMIT) next.add(id);
      return next;
    });
  return (
    <Modal
      isOpen
      portalContainer={
        typeof document === 'undefined' ? undefined : document.body
      }
      classNames={{
        backdrop: 'subscription-dialog-backdrop',
        wrapper: 'subscription-dialog-overlay',
        base: 'subscription-dialog',
        header: 'subscription-dialog-header',
        body: 'subscription-dialog-body',
        footer: 'subscription-dialog-footer',
        closeButton: 'subscription-dialog-close',
      }}
      scrollBehavior="inside"
      onClose={() => {
        if (!disabled) onClose();
      }}
      isDismissable={!disabled}
      isKeyboardDismissDisabled={disabled}
    >
      <ModalContent>
        <ModalHeader>添加订阅到「{folder.name}」</ModalHeader>
        <ModalBody>
          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}
          {disabled && (
            <p role="status" className="text-sm">
              正在保存分类，请等待确认。
            </p>
          )}
          <p className="text-xs text-neutral-500">
            可一次选择最多 100 个订阅；其他文件夹中的订阅会移动到这里。
          </p>
          <Input
            aria-label="搜索已有订阅"
            placeholder="搜索订阅名称"
            value={search}
            onValueChange={(value) => {
              setSearch(value);
              setPage(0);
            }}
          />
          <div className="flex items-center justify-between text-sm">
            <span role="status">
              已选 {ids.length} / {BATCH_LIMIT}，匹配 {matches.length} 个
            </span>
            <Button
              size="sm"
              variant="light"
              isDisabled={disabled}
              onPress={() =>
                setSelected((previous) => {
                  const next = new Set(
                    [...previous].filter((id) => available.has(id)),
                  );
                  for (const member of visible) {
                    if (next.size >= BATCH_LIMIT) break;
                    if (available.has(member.id)) next.add(member.id);
                  }
                  return next;
                })
              }
            >
              选择本页
            </Button>
            <Button
              size="sm"
              variant="light"
              isDisabled={disabled || !ids.length}
              onPress={() => setSelected(new Set())}
            >
              清空
            </Button>
          </div>
          <div aria-label="可添加的订阅" className="space-y-1">
            {visible.map((member) => {
              const alreadyAdded = member.groupId === folder.id;
              return (
                <label
                  key={member.id}
                  className="flex min-h-9 items-center gap-2 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={alreadyAdded || selected.has(member.id)}
                    disabled={
                      disabled ||
                      alreadyAdded ||
                      (!selected.has(member.id) && ids.length >= BATCH_LIMIT)
                    }
                    onChange={() => toggle(member.id)}
                  />
                  <span className="min-w-0 flex-1 break-words">
                    {member.name}
                  </span>
                  {alreadyAdded && (
                    <span className="shrink-0 text-xs text-neutral-500">
                      已在文件夹
                    </span>
                  )}
                </label>
              );
            })}
            {!visible.length && <p className="text-sm">没有匹配的订阅</p>}
          </div>
          <div className="flex items-center justify-between">
            <Button
              size="sm"
              variant="flat"
              isDisabled={currentPage === 0}
              onPress={() => setPage(currentPage - 1)}
            >
              上一页
            </Button>
            <span className="text-xs">
              第 {currentPage + 1} / {pages} 页
            </span>
            <Button
              size="sm"
              variant="flat"
              isDisabled={currentPage + 1 >= pages}
              onPress={() => setPage(currentPage + 1)}
            >
              下一页
            </Button>
          </div>
        </ModalBody>
        <ModalFooter>
          <Button variant="flat" isDisabled={disabled} onPress={onClose}>
            取消
          </Button>
          <Button
            color="primary"
            isLoading={disabled}
            isDisabled={disabled || !ids.length}
            onPress={async () => {
              if (await onAdd(ids)) onClose();
            }}
          >
            添加所选 ({ids.length})
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
