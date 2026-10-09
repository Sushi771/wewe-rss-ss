import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from '@nextui-org/react';
import { useRef, useState } from 'react';

type Folder = { id: string; name: string };
type Props = {
  folders: Folder[];
  filter: string;
  selectedIds: string[];
  dragType: string;
  disabled: boolean;
  onFilter: (id: string) => void;
  onSave: (input: { id?: string; name: string }) => Promise<unknown>;
  onRemove: (id: string) => Promise<unknown>;
  onMove: (ids: string[], groupId: string | null) => Promise<unknown>;
  onBusyChange: (busy: boolean) => void;
};

/** Application-owned folders never change upstream identities or disk paths. */
export default function ManagementFolders({
  folders,
  filter,
  selectedIds,
  dragType,
  disabled,
  onFilter,
  onSave,
  onRemove,
  onMove,
  onBusyChange,
}: Props) {
  const [editing, setEditing] = useState<Folder | null>();
  const [name, setName] = useState('');
  const [destination, setDestination] = useState('');
  const [error, setError] = useState('');
  const active = useRef(false);
  const run = async (operation: () => Promise<unknown>) => {
    if (disabled || active.current) return;
    active.current = true;
    onBusyChange(true);
    setError('');
    try {
      await operation();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : '文件夹操作未完成，请重新读取列表。',
      );
    } finally {
      active.current = false;
      onBusyChange(false);
    }
  };
  const drop = (event: React.DragEvent, groupId: string | null) => {
    event.preventDefault();
    if (disabled || active.current) return;
    const id = event.dataTransfer.getData(dragType);
    if (!id) return; // Ignore drops from another platform and external content.
    void run(() =>
      onMove(selectedIds.includes(id) ? selectedIds : [id], groupId),
    );
  };
  return (
    <div className="space-y-2 px-3 pb-3" aria-label="管理文件夹">
      <div className="flex items-center justify-between">
        <span className="text-xs text-neutral-500">文件夹</span>
        <Button
          size="sm"
          variant="light"
          isDisabled={disabled}
          onPress={() => {
            setEditing(null);
            setName('');
          }}
        >
          新建
        </Button>
      </div>
      <p className="text-xs leading-5 text-neutral-500">
        将订阅拖到文件夹可分组；手机或批量移动请先点“管理”，勾选后选择目标文件夹。
      </p>
      {[
        { id: 'all', name: '全部' },
        { id: 'ungrouped', name: '未分组' },
        ...folders,
      ].map((folder) => (
        <div
          key={folder.id}
          className="flex min-w-0 items-center gap-1"
          onDragOver={(event) => {
            if (
              !disabled &&
              folder.id !== 'all' &&
              event.dataTransfer.types.includes(dragType)
            )
              event.preventDefault();
          }}
          onDrop={(event) => {
            if (folder.id !== 'all')
              drop(event, folder.id === 'ungrouped' ? null : folder.id);
          }}
        >
          <button
            type="button"
            disabled={disabled}
            aria-pressed={filter === folder.id}
            className={`mac-sidebar-item !my-0 !min-w-0 flex-1 truncate text-left ${filter === folder.id ? 'active' : ''}`}
            onClick={() => onFilter(folder.id)}
          >
            {folder.name}
          </button>
          {!['all', 'ungrouped'].includes(folder.id) && (
            <>
              <Button
                size="sm"
                variant="light"
                isDisabled={disabled}
                className="min-w-0 px-2"
                aria-label={`重命名文件夹 ${folder.name}`}
                onPress={() => {
                  setEditing(folder);
                  setName(folder.name);
                }}
              >
                改名
              </Button>
              <Button
                size="sm"
                variant="light"
                isDisabled={disabled}
                className="min-w-0 px-2"
                aria-label={`删除文件夹 ${folder.name}`}
                onPress={() => {
                  if (
                    window.confirm(
                      `删除空文件夹“${folder.name}”？请先移出其中的订阅。`,
                    )
                  )
                    void run(() => onRemove(folder.id));
                }}
              >
                删除
              </Button>
            </>
          )}
        </div>
      ))}
      {selectedIds.length > 0 && (
        <div className="space-y-2">
          <label className="flex flex-col gap-1 text-xs">
            移动已选 {selectedIds.length} 项
            <select
              aria-label="移动到文件夹"
              className="bg-background min-w-0 rounded border p-2 text-sm"
              value={destination}
              disabled={disabled}
              onChange={(event) => setDestination(event.target.value)}
            >
              <option value="">未分组</option>
              {folders.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.name}
                </option>
              ))}
            </select>
          </label>
          <Button
            size="sm"
            variant="flat"
            isDisabled={disabled}
            onPress={() =>
              void run(() => onMove(selectedIds, destination || null))
            }
          >
            移动已选
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="break-words text-xs text-red-600">
          {error}
        </p>
      )}
      <Modal
        isOpen={editing !== undefined}
        onClose={() => {
          if (!disabled && !active.current) setEditing(undefined);
        }}
      >
        <ModalContent>
          <ModalHeader>{editing ? '重命名文件夹' : '新建文件夹'}</ModalHeader>
          <ModalBody>
            <Input
              label="文件夹名称"
              value={name}
              maxLength={80}
              isDisabled={disabled}
              onValueChange={setName}
            />
            {error && <p role="alert">{error}</p>}
          </ModalBody>
          <ModalFooter>
            <Button
              variant="flat"
              isDisabled={disabled}
              onPress={() => setEditing(undefined)}
            >
              取消
            </Button>
            <Button
              color="primary"
              isDisabled={disabled || !name.trim()}
              onPress={() =>
                void run(async () => {
                  await onSave({
                    ...(editing ? { id: editing.id } : {}),
                    name: name.trim(),
                  });
                  setEditing(undefined);
                })
              }
            >
              保存
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}
