import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Dropdown,
  DropdownTrigger,
  DropdownMenu,
  DropdownItem,
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@nextui-org/react';
import { useRef, useState } from 'react';
import FolderDragRow from './FolderDragRow';

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
  onReorder?: (ids: string[], expectedIds: string[]) => Promise<unknown>;
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
  onReorder,
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
  const reorder = (id: string, targetId: string) => {
    if (!onReorder || id === targetId) return;
    const expectedIds = folders.map((folder) => folder.id);
    const from = expectedIds.indexOf(id),
      to = expectedIds.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const ids = [...expectedIds];
    ids.splice(from, 1);
    ids.splice(to, 0, id);
    void run(() => onReorder(ids, expectedIds));
  };
  return (
    <div className="folder-navigation" aria-label="管理文件夹">
      <div className="folder-navigation-header">
        <Popover placement="bottom-start">
          <PopoverTrigger>
            <Button
              size="sm"
              variant="light"
              className="h-7 min-w-0 px-1 text-xs text-neutral-500"
              aria-label="分组帮助"
            >
              分组 ⓘ
            </Button>
          </PopoverTrigger>
          <PopoverContent className="max-w-[240px] p-3 text-xs leading-5">
            拖动文件夹手柄可排序，也可在更多菜单上移或下移。将订阅拖到文件夹可分组；手机或批量移动请先点“管理”，勾选后选择目标文件夹。
          </PopoverContent>
        </Popover>
        <Button
          size="sm"
          variant="light"
          className="h-7 min-w-0 px-2 text-xs"
          aria-label="新建文件夹"
          isDisabled={disabled}
          onPress={() => {
            setEditing(null);
            setName('');
          }}
        >
          + 新建
        </Button>
      </div>
      {[
        { id: 'all', name: '全部' },
        { id: 'ungrouped', name: '未分组' },
        ...folders,
      ].map((folder) => {
        const row = (
          <div
            key={folder.id}
            className="folder-navigation-row"
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
              className={`mac-sidebar-item folder-filter text-left ${filter === folder.id ? 'active' : ''}`}
              title={folder.name}
              onClick={() => onFilter(folder.id)}
            >
              <span className="folder-filter-label">{folder.name}</span>
            </button>
            {!['all', 'ungrouped'].includes(folder.id) && (
              <Dropdown>
                <DropdownTrigger>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="light"
                    isDisabled={disabled}
                    className="h-7 w-7 min-w-7"
                    aria-label={`文件夹 ${folder.name} 更多操作`}
                  >
                    ⋯
                  </Button>
                </DropdownTrigger>
                <DropdownMenu
                  aria-label={`文件夹 ${folder.name} 操作`}
                  onAction={(key) => {
                    if (disabled || active.current) return;
                    if (key === 'rename') {
                      setEditing(folder);
                      setName(folder.name);
                    } else if (key === 'delete') {
                      if (
                        window.confirm(
                          `删除空文件夹“${folder.name}”？请先移出其中的订阅。`,
                        )
                      )
                        void run(() => onRemove(folder.id));
                    } else if (key === 'up' || key === 'down') {
                      const index = folders.findIndex(
                        (item) => item.id === folder.id,
                      );
                      const target = folders[index + (key === 'up' ? -1 : 1)];
                      if (target) reorder(folder.id, target.id);
                    }
                  }}
                >
                  <DropdownItem key="rename">重命名</DropdownItem>
                  <DropdownItem
                    key="up"
                    isDisabled={!onReorder || folders[0]?.id === folder.id}
                  >
                    上移
                  </DropdownItem>
                  <DropdownItem
                    key="down"
                    isDisabled={!onReorder || folders.at(-1)?.id === folder.id}
                  >
                    下移
                  </DropdownItem>
                  <DropdownItem
                    key="delete"
                    color="danger"
                    className="text-danger"
                  >
                    删除文件夹
                  </DropdownItem>
                </DropdownMenu>
              </Dropdown>
            )}
          </div>
        );
        return onReorder && !['all', 'ungrouped'].includes(folder.id) ? (
          <FolderDragRow
            key={folder.id}
            id={folder.id}
            name={folder.name}
            disabled={disabled}
            onMove={(targetId) => reorder(folder.id, targetId)}
          >
            {row}
          </FolderDragRow>
        ) : (
          row
        );
      })}
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
