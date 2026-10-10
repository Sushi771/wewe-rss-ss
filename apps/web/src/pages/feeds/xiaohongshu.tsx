import {
  Button,
  Checkbox,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Spinner,
  Switch,
} from '@nextui-org/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import dayjs from 'dayjs';
import ManagementFolders from '@web/components/ManagementFolders';
import { trpc } from '@web/utils/trpc';
import { getAuthCode } from '@web/utils/auth';
import { serverOriginUrl } from '@web/utils/env';
import { refreshCreatorBatch } from '@web/utils/xiaohongshu-refresh';

type SaveSettings = { directory: string; askEveryTime: boolean };
type DirectoryChoice = SaveSettings & {
  cancelled?: boolean;
  pickToken?: string;
};
const localApi = async <T,>(endpoint: string, payload?: object): Promise<T> => {
  const auth = getAuthCode();
  const response = await fetch(
    `${serverOriginUrl || ''}/download/article${endpoint}`,
    {
      method: payload ? 'POST' : 'GET',
      credentials: 'include',
      headers: {
        ...(auth ? { authorization: auth } : {}),
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    },
  );
  const result: unknown = await response.json();
  if (!response.ok)
    throw new Error(
      typeof result === 'object' &&
        result !== null &&
        'message' in result &&
        typeof result.message === 'string'
        ? result.message
        : '本机操作未完成，请核对本地保存服务与目录。',
    );
  return result as T;
};

/** Production page reads authenticated archives; incomplete videos stay unavailable. */
export default function Xiaohongshu() {
  const utils = trpc.useUtils();
  const capability = trpc.xiaohongshu.capability.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });
  const creators = trpc.xiaohongshu.list.useQuery(undefined, { retry: false });
  const groups = trpc.xiaohongshu.groups.useQuery(undefined, { retry: false });
  const [creatorId, setCreatorId] = useState('');
  const [noteId, setNoteId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [profileUrl, setProfileUrl] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [folderFilter, setFolderFilter] = useState('all');
  const [selectedCreators, setSelectedCreators] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [saveSettings, setSaveSettings] = useState<SaveSettings | null>(null);
  const [directory, setDirectory] = useState('');
  const active = useRef(false);
  const receipts = useRef<Record<string, string>>({});
  useEffect(() => {
    let current = true;
    void localApi<SaveSettings>('/settings')
      .then((settings) => {
        if (current) {
          setSaveSettings(settings);
          setDirectory(settings.directory);
        }
      })
      .catch(() => {
        if (current)
          setMessage('本机保存设置读取失败，可重新读取；ZIP 导出仍可用。');
      });
    return () => {
      current = false;
    };
  }, []);
  const current = creators.data?.items.find(
    (creator) => creator.id === creatorId,
  );
  const visibleCreators =
    creators.data?.items.filter(
      (creator) =>
        folderFilter === 'all' ||
        (folderFilter === 'ungrouped'
          ? !creator.groupId
          : creator.groupId === folderFilter),
    ) || [];
  const notes = trpc.xiaohongshu.notes.useQuery(
    { creatorId },
    { enabled: !!current, retry: false },
  );
  const body = trpc.xiaohongshu.body.useQuery(
    { creatorId, noteId },
    { enabled: !!current && !!noteId, retry: false },
  );
  const visibleNotes = useMemo(
    () =>
      (notes.data?.items || []).filter((note) =>
        note.title
          .toLocaleLowerCase()
          .includes(search.trim().toLocaleLowerCase()),
      ),
    [notes.data, search],
  );
  const selectableNotes = visibleNotes.filter(
    (note) => note.status === 'complete',
  );
  const selectedNotes = visibleNotes.filter(
    (note) => note.status === 'complete' && selectedIds.has(note.id),
  );
  const noteStatus = (note: {
    status: string;
    kind: 'image-text' | 'video';
  }) =>
    note.status === 'complete'
      ? note.kind === 'video'
        ? '视频缓存（结构字节已核，未解码/播放）'
        : '图文缓存'
      : note.kind === 'video' || note.status === 'video-skipped'
        ? '视频未归档'
        : '正文或图片未归档';
  const allSelected =
    selectableNotes.length > 0 &&
    selectableNotes.every((note) => selectedIds.has(note.id));
  const add = trpc.xiaohongshu.add.useMutation();
  const edit = trpc.xiaohongshu.edit.useMutation();
  const remove = trpc.xiaohongshu.remove.useMutation();
  const refresh = trpc.xiaohongshu.refresh.useMutation();
  const exportNotes = trpc.xiaohongshu.export.useMutation();
  const saveGroup = trpc.xiaohongshu.saveGroup.useMutation();
  const removeGroup = trpc.xiaohongshu.removeGroup.useMutation();
  const moveCreators = trpc.xiaohongshu.moveCreators.useMutation();
  useEffect(() => {
    if (
      !active.current &&
      creators.data &&
      !creators.data.items.some((creator) => creator.id === creatorId)
    ) {
      setCreatorId(creators.data.items[0]?.id || '');
      setNoteId('');
      setSelectedIds(new Set());
    }
  }, [creators.data, creatorId]);
  const run = async (operation: () => Promise<void>) => {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setMessage('');
    try {
      await operation();
    } catch (cause) {
      setMessage(
        '操作未完成；既有归档保留。' +
          (cause instanceof Error
            ? cause.message
            : '请核对数据源或本地保存状态。'),
      );
    } finally {
      active.current = false;
      setBusy(false);
    }
  };
  const selectCreator = (id: string) => {
    if (active.current) return;
    setCreatorId(id);
    setNoteId('');
    setSearch('');
    setSelectedIds(new Set());
    setMessage(receipts.current[id] || '');
    setMobileSidebarOpen(false);
  };
  const handleSearch = (value: string) => {
    if (active.current) return;
    setSearch(value);
    setSelectedIds(new Set());
  };
  const selectNote = (id: string, selected: boolean) => {
    if (active.current) return;
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (selected) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const updateCreator = async (id: string) => {
    const result = await refresh.mutateAsync({ id });
    const name =
      creators.data?.items.find((creator) => creator.id === id)?.displayName ||
      '已选博主';
    receipts.current[id] =
      name + '：' + result.message + ' 新增完整缓存笔记：' + result.added;
    await Promise.all([
      utils.xiaohongshu.list.invalidate(),
      utils.xiaohongshu.notes.invalidate(),
    ]);
    setMessage(receipts.current[id]);
    return result.status;
  };
  const handleAdd = () =>
    run(async () => {
      const result = await add.mutateAsync({ displayName, profileUrl });
      setMessage(result.message);
      await utils.xiaohongshu.list.invalidate();
      setCreatorId(result.creator.id);
      setNoteId('');
      setSelectedIds(new Set());
      setFolderFilter('all');
      setDisplayName('');
      setProfileUrl('');
      setAdding(false);
    });
  const handleRefreshAll = () =>
    run(async () => {
      if (!capability.data?.canRefresh) return;
      const items = creators.data?.items || [];
      const enabled = items.filter((creator) => creator.enabled);
      const result = await refreshCreatorBatch(
        enabled.map((creator) => creator.id),
        updateCreator,
      );
      const detail = result.failedId
        ? result.error || receipts.current[result.failedId] || '更新未完成。'
        : '';
      setMessage(
        `批量更新：完成 ${result.completed} 位，未完成 ${result.failedId ? 1 : 0} 位，未执行 ${result.remaining} 位；已停用跳过 ${items.length - enabled.length} 位。${detail}`,
      );
    });
  const handleDownload = () =>
    run(async () => {
      if (!current || !selectedNotes.length) return;
      const result = await exportNotes.mutateAsync({
        creatorId: current.id,
        noteIds: selectedNotes.map((note) => note.id),
      });
      const bytes = Uint8Array.from(atob(result.base64), (char) =>
        char.charCodeAt(0),
      );
      const url = URL.createObjectURL(
        new Blob([bytes], { type: result.mimeType }),
      );
      const link = document.createElement('a');
      try {
        link.href = url;
        link.download = result.filename;
        document.body.appendChild(link);
        link.click();
      } finally {
        link.remove();
        URL.revokeObjectURL(url);
      }
      setMessage(
        `${current.displayName}：已导出选中的 ${result.notes} 篇完整缓存笔记 ZIP。`,
      );
    });
  const handleLocalSave = () =>
    run(async () => {
      if (!current || !saveSettings || !selectedNotes.length) return;
      let pickToken: string | undefined;
      if (saveSettings.askEveryTime) {
        const chosen = await localApi<DirectoryChoice>('/directory', {});
        if (chosen.cancelled) {
          setMessage(`已取消路径选择，${current.displayName} 本次未保存。`);
          return;
        }
        pickToken = chosen.pickToken;
        setSaveSettings({
          directory: chosen.directory,
          askEveryTime: chosen.askEveryTime,
        });
        setDirectory(chosen.directory);
      }
      const result = await localApi<{
        saved: boolean;
        savedCount: number;
        alreadySavedCount: number;
        videoCount?: number;
        videoDecoded?: boolean;
        videoVerification?: string;
      }>('/xiaohongshu/save', {
        creatorId: current.id,
        noteIds: selectedNotes.map((note) => note.id),
        ...(pickToken ? { pickToken } : {}),
      });
      if (
        result.saved !== true ||
        !Number.isInteger(result.savedCount) ||
        result.savedCount < 0 ||
        !Number.isInteger(result.alreadySavedCount) ||
        result.alreadySavedCount < 0 ||
        result.savedCount + result.alreadySavedCount !== selectedNotes.length
      )
        throw new Error('本机保存数量未确认，请核对已保存内容。');
      const videoCount =
        result.videoCount === undefined ? 0 : result.videoCount;
      const selectedVideoCount = selectedNotes.filter(
        (note) => note.kind === 'video',
      ).length;
      if (
        !Number.isInteger(videoCount) ||
        videoCount < 0 ||
        videoCount !== selectedVideoCount ||
        (videoCount > 0 &&
          (result.videoDecoded !== false ||
            result.videoVerification !== 'container-and-bytes'))
      )
        throw new Error('本机视频保存数量或核验状态未确认，请核对已保存内容。');
      setMessage(
        `${current.displayName}：本次新增保存 ${result.savedCount} 篇，已有保存 ${result.alreadySavedCount} 篇；每篇独立目录保存正文与 image 图片（有图时）。${videoCount > 0 ? `其中 ${videoCount} 篇含已归档 video 文件（含已有保存）；视频结构字节已核，尚未解码或播放。` : '本批次不含已归档视频。'}`,
      );
    });
  const handleChooseDirectory = () =>
    run(async () => {
      const chosen = await localApi<DirectoryChoice>('/directory', {});
      if (chosen.cancelled) {
        setMessage('已取消目录选择，原设置保留。');
        return;
      }
      setSaveSettings({
        directory: chosen.directory,
        askEveryTime: chosen.askEveryTime,
      });
      setDirectory(chosen.directory);
      setMessage('已记住保存目录。');
    });
  const handleSaveSettings = (
    askEveryTime = saveSettings?.askEveryTime || false,
  ) =>
    run(async () => {
      const settings = await localApi<SaveSettings>('/settings', {
        askEveryTime,
      });
      setSaveSettings(settings);
      setDirectory(settings.directory);
      setMessage('已记住保存设置。');
    });
  const invalidateFolders = async () => {
    await Promise.all([
      utils.xiaohongshu.groups.invalidate(),
      utils.xiaohongshu.list.invalidate(),
    ]);
  };
  return (
    <main
      className="flex h-full min-h-0 min-w-0 flex-col md:flex-row"
      aria-label="小红书博主与笔记管理"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-neutral-200 px-3 py-2 md:hidden dark:border-neutral-700">
        <label className="min-w-0 flex-1 text-xs text-neutral-500">
          当前博主
          <select
            aria-label="手机选择小红书博主"
            className="bg-background mt-1 w-full min-w-0 rounded border p-2 text-sm"
            value={creatorId}
            disabled={busy}
            onChange={(event) => selectCreator(event.target.value)}
          >
            <option value="">选择博主</option>
            {creators.data?.items.map((creator) => (
              <option key={creator.id} value={creator.id}>
                {creator.displayName}
              </option>
            ))}
          </select>
        </label>
        <Button
          size="sm"
          variant="flat"
          isDisabled={busy}
          aria-expanded={mobileSidebarOpen}
          aria-controls="xiaohongshu-management-sidebar"
          onPress={() => {
            if (!active.current) setMobileSidebarOpen(!mobileSidebarOpen);
          }}
        >
          {mobileSidebarOpen ? '收起管理' : '管理博主'}
        </Button>
      </div>
      <aside
        id="xiaohongshu-management-sidebar"
        className={`mac-sidebar max-h-[45vh] !w-full !min-w-0 overflow-y-auto md:!flex md:max-h-none md:!w-[260px] ${mobileSidebarOpen ? '!flex' : '!hidden'}`}
        aria-label="小红书博主列表"
      >
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-[13px] font-bold text-neutral-400">
            小红书 · {creators.data?.items.length || 0}
          </span>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="light"
              isDisabled={busy}
              onPress={() => {
                setManaging(!managing);
                setSelectedCreators([]);
              }}
            >
              管理
            </Button>
            <Button
              size="sm"
              variant="light"
              isDisabled={busy}
              onPress={() => setAdding(true)}
            >
              添加
            </Button>
          </div>
        </div>
        <ManagementFolders
          folders={groups.data?.items || []}
          filter={folderFilter}
          selectedIds={selectedCreators}
          dragType="application/x-wewe-xiaohongshu"
          disabled={busy || !groups.data}
          onFilter={(filter) => {
            if (active.current) return;
            setFolderFilter(filter);
            setSelectedCreators([]);
          }}
          onBusyChange={(value) => {
            active.current = value;
            setBusy(value);
          }}
          onSave={async (input) => {
            await saveGroup.mutateAsync(input);
            await invalidateFolders();
          }}
          onRemove={async (id) => {
            await removeGroup.mutateAsync({ id });
            if (folderFilter === id) setFolderFilter('all');
            await invalidateFolders();
          }}
          onMove={async (ids, groupId) => {
            await moveCreators.mutateAsync({ ids, groupId });
            setSelectedCreators([]);
            await invalidateFolders();
          }}
        />
        {groups.error && (
          <p role="alert" className="px-4 text-sm">
            文件夹读取失败，请重新读取页面。
          </p>
        )}
        {creators.error && (
          <p role="alert" className="px-4 text-sm">
            博主列表读取失败，既有归档保留。
          </p>
        )}
        {managing && visibleCreators.length > 0 && (
          <Checkbox
            size="sm"
            className="px-4 py-2"
            aria-label="选择当前文件夹全部博主"
            isDisabled={busy}
            isSelected={visibleCreators.every((creator) =>
              selectedCreators.includes(creator.id),
            )}
            onValueChange={(value) =>
              setSelectedCreators(
                value ? visibleCreators.map((creator) => creator.id) : [],
              )
            }
          >
            全选博主
          </Checkbox>
        )}
        <ul>
          {visibleCreators.map((creator) => (
            <li
              key={creator.id}
              className={`mac-sidebar-item ${creatorId === creator.id && !managing ? 'active' : ''}`}
              draggable={!busy}
              onDragStart={(event) => {
                if (active.current) {
                  event.preventDefault();
                  return;
                }
                event.dataTransfer.setData(
                  'application/x-wewe-xiaohongshu',
                  creator.id,
                );
                event.dataTransfer.effectAllowed = 'move';
              }}
            >
              {managing && (
                <Checkbox
                  size="sm"
                  aria-label={`选择博主 ${creator.displayName}`}
                  isDisabled={busy}
                  isSelected={selectedCreators.includes(creator.id)}
                  onValueChange={(value) =>
                    setSelectedCreators((previous) =>
                      value
                        ? [...previous, creator.id]
                        : previous.filter((id) => id !== creator.id),
                    )
                  }
                />
              )}
              <button
                type="button"
                disabled={busy}
                aria-pressed={creatorId === creator.id}
                className="min-w-0 flex-1 truncate text-left text-sm"
                onClick={() => selectCreator(creator.id)}
              >
                {creator.displayName}
              </button>
              <span className="shrink-0 text-xs opacity-60">
                {creator._count.notes}
              </span>
            </li>
          ))}
        </ul>
        {!creators.isLoading && !creators.error && !visibleCreators.length && (
          <p className="p-4 text-sm text-neutral-500">
            {folderFilter === 'all' ? '尚未添加博主。' : '此文件夹暂无博主。'}
          </p>
        )}
      </aside>
      <section
        className="mac-content !min-w-0 flex-1"
        aria-label="小红书笔记列表"
      >
        <div className="mac-toolbar !h-auto !flex-wrap !py-2">
          <div className="flex w-full min-w-0 items-center gap-3">
            <h1 className="truncate text-[15px] font-semibold">
              {current?.displayName || '小红书笔记'}
            </h1>
            {current && (
              <Switch
                size="sm"
                isSelected={current.enabled}
                isDisabled={busy}
                aria-label={`启用 ${current.displayName}`}
                onValueChange={(enabled) =>
                  run(async () => {
                    await edit.mutateAsync({ id: current.id, enabled });
                    await utils.xiaohongshu.list.invalidate();
                  })
                }
              >
                启用更新
              </Switch>
            )}
          </div>
          <div className="flex w-full flex-wrap items-center gap-2">
            <Button
              size="sm"
              className="mac-btn-outline"
              isDisabled={
                busy || !current?.enabled || !capability.data?.canRefresh
              }
              onPress={() =>
                run(async () => {
                  if (current) await updateCreator(current.id);
                })
              }
            >
              刷新此博主
            </Button>
            <Button
              size="sm"
              variant="light"
              isDisabled={
                busy ||
                !capability.data?.canRefresh ||
                !creators.data?.items.some((creator) => creator.enabled)
              }
              onPress={handleRefreshAll}
            >
              刷新全部
            </Button>
            <Button
              size="sm"
              color="primary"
              variant="flat"
              isDisabled={busy || !saveSettings || !selectedNotes.length}
              onPress={handleLocalSave}
            >
              保存到本机 ({selectedNotes.length})
            </Button>
            <Button
              size="sm"
              variant="light"
              isDisabled={busy || !selectedNotes.length}
              onPress={handleDownload}
            >
              导出 ZIP（可选）
            </Button>
            <Button
              size="sm"
              variant="light"
              isDisabled={busy || !current}
              onPress={() => setSearchOpen(!searchOpen)}
            >
              搜索笔记
            </Button>
            {current && managing && (
              <Button
                size="sm"
                color="danger"
                variant="light"
                isDisabled={busy || current._count.notes > 0}
                onPress={() => {
                  if (
                    window.confirm(
                      '移除此待接入博主？已有归档的博主请使用停用。',
                    )
                  )
                    void run(async () => {
                      await remove.mutateAsync({ id: current.id });
                      await utils.xiaohongshu.list.invalidate();
                    });
                }}
              >
                移除待接入博主
              </Button>
            )}
          </div>
        </div>
        <div className="space-y-2 border-b border-neutral-200 px-4 py-3 text-sm dark:border-neutral-700">
          <p role="status">
            {capability.error
              ? '来源状态查询失败，未自动更新。'
              : capability.data?.message || '正在确认来源状态…'}
          </p>
          <p className="text-xs text-neutral-500">
            添加博主只保存待接入记录。完整视频缓存仅核验结构与字节，尚未解码或播放；未取得视频仍显示“视频未归档”。
          </p>
          {message && (
            <p role="status" className="break-words">
              {message}
            </p>
          )}
          <details>
            <summary className="cursor-pointer break-all text-neutral-500">
              本机保存设置 · {saveSettings?.directory || '尚未读取'}
            </summary>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Input
                aria-label="本机保存目录"
                className="min-w-0 flex-1 basis-64"
                value={directory}
                isReadOnly
              />
              <Button
                size="sm"
                variant="flat"
                isDisabled={busy}
                onPress={handleChooseDirectory}
              >
                选择目录
              </Button>
              <Switch
                size="sm"
                aria-label="每次保存选择目录"
                isSelected={saveSettings?.askEveryTime || false}
                isDisabled={busy || !saveSettings}
                onValueChange={(value) => handleSaveSettings(value)}
              >
                每次保存选择目录
              </Switch>
              {!saveSettings && (
                <Button
                  size="sm"
                  isDisabled={busy}
                  onPress={() =>
                    run(async () => {
                      const settings =
                        await localApi<SaveSettings>('/settings');
                      setSaveSettings(settings);
                      setDirectory(settings.directory);
                    })
                  }
                >
                  重新读取
                </Button>
              )}
            </div>
            <p className="mt-2 text-xs text-neutral-500">
              选中笔记逐篇保存正文、image 图片（有图时）及 video
              文件（有视频时），ZIP
              可单独导出。文件夹只管理订阅，不改变保存目录。
            </p>
          </details>
        </div>
        {searchOpen && (
          <div className="px-4 py-2">
            <Input
              aria-label="搜索笔记标题"
              placeholder="搜索笔记标题…"
              value={search}
              onValueChange={handleSearch}
              isDisabled={busy}
            />
          </div>
        )}
        <div className="px-4 py-2 text-xs text-neutral-500">
          当前{search ? '筛选' : '博主'} {visibleNotes.length} 篇；已选择{' '}
          {selectedNotes.length} 篇完整缓存笔记。
          {search && '修改搜索会清空选择。'}
        </div>
        {notes.error && (
          <p role="alert" className="px-4 py-2 text-sm">
            笔记列表读取失败，既有归档未改动。
          </p>
        )}
        <div className="flex-1 overflow-y-auto">
          <div className="compact-list">
            <div className="compact-list-header !flex-wrap">
              <div className="compact-col-check">
                <Checkbox
                  size="sm"
                  aria-label="选择筛选结果全部完整笔记"
                  isDisabled={busy || !selectableNotes.length}
                  isSelected={allSelected}
                  isIndeterminate={!allSelected && selectedNotes.length > 0}
                  onValueChange={(value) => {
                    if (!active.current)
                      setSelectedIds(
                        value
                          ? new Set(selectableNotes.map((note) => note.id))
                          : new Set(),
                      );
                  }}
                />
              </div>
              <div className="compact-col-title">笔记标题</div>
              <div className="hidden text-xs md:block">发布时间 · 归档状态</div>
            </div>
            {visibleNotes.map((note) => (
              <div
                key={note.id}
                className="compact-row article-row !grid grid-cols-[24px_minmax(0,1fr)] !items-start md:!flex md:!items-center"
              >
                <div className="compact-col-check">
                  <Checkbox
                    size="sm"
                    aria-label={`选择笔记 ${note.title}`}
                    isDisabled={busy || note.status !== 'complete'}
                    isSelected={selectedIds.has(note.id)}
                    onValueChange={(value) => selectNote(note.id, value)}
                  />
                </div>
                <button
                  type="button"
                  disabled={busy || note.status !== 'complete'}
                  className="compact-title min-w-0 !whitespace-normal break-words text-left text-[15px] hover:text-[#007AFF] disabled:text-neutral-500 md:!whitespace-nowrap"
                  onClick={() => {
                    if (!active.current) setNoteId(note.id);
                  }}
                >
                  {note.title}
                </button>
                <div className="col-start-2 flex min-w-0 shrink-0 flex-col items-start gap-1 py-1 text-xs text-neutral-500 md:ml-auto md:items-end">
                  <span>
                    {note.publishTime > 0
                      ? dayjs(note.publishTime * 1000).format(
                          'YYYY-MM-DD HH:mm',
                        )
                      : '发布时间未知'}
                  </span>
                  <span className="whitespace-normal text-left md:max-w-[150px] md:text-right">
                    {noteStatus(note)}
                  </span>
                </div>
              </div>
            ))}
            {notes.isLoading && current && (
              <div className="flex justify-center p-4">
                <Spinner size="sm" />
              </div>
            )}
            {!notes.isLoading && !notes.error && !visibleNotes.length && (
              <p className="p-10 text-center text-sm text-neutral-400">
                {!current
                  ? '选择一个博主查看笔记。'
                  : search
                    ? '没有匹配的笔记。'
                    : '暂无已归档笔记，接入真实数据源后才能更新。'}
              </p>
            )}
          </div>
        </div>
      </section>
      <Modal
        isOpen={adding}
        onClose={() => {
          if (!active.current) setAdding(false);
        }}
      >
        <ModalContent>
          <ModalHeader>添加小红书博主</ModalHeader>
          <ModalBody>
            <p className="text-sm text-neutral-500">
              保存公开主页待接入记录，不会自动登录或读取笔记。
            </p>
            <Input
              label="博主备注名称"
              value={displayName}
              onValueChange={setDisplayName}
              isDisabled={busy}
              maxLength={120}
            />
            <Input
              label="小红书公开主页链接"
              value={profileUrl}
              onValueChange={setProfileUrl}
              isDisabled={busy}
              maxLength={2000}
            />
            {message && <p role="status">{message}</p>}
          </ModalBody>
          <ModalFooter>
            <Button
              variant="flat"
              isDisabled={busy}
              onPress={() => setAdding(false)}
            >
              取消
            </Button>
            <Button
              color="primary"
              isDisabled={busy || !displayName.trim() || !profileUrl.trim()}
              onPress={handleAdd}
            >
              保存待接入博主
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
      <Modal
        isOpen={!!noteId}
        onClose={() => {
          if (!active.current) setNoteId('');
        }}
        size="4xl"
        scrollBehavior="inside"
        classNames={{ wrapper: 'z-[200]', backdrop: 'z-[190]' }}
      >
        <ModalContent>
          <ModalHeader className="min-w-0 break-words pr-10">
            {body.data?.title || '读取已保存正文'}
          </ModalHeader>
          <ModalBody>
            <p className="text-sm text-neutral-500">
              读取已归档正文与图片；视频笔记仅显示正文和封面，本次没有联网取文或加载视频。
            </p>
            {body.isLoading ? (
              <Spinner />
            ) : body.error ? (
              <p role="alert">正文未能读取，未向远端请求图片。</p>
            ) : (
              body.data && (
                <article className="space-y-3">
                  {body.data.kind === 'video' && body.data.video && (
                    <p className="text-sm text-neutral-500">
                      已缓存视频 {body.data.video.bytes.toLocaleString()}{' '}
                      字节，结构字节已核，尚未解码或播放。保存到本机会包含
                      video/ 文件；本页不加载视频字节。
                    </p>
                  )}
                  <p className="whitespace-pre-wrap break-words">
                    {body.data.text}
                  </p>
                  {body.data.images.map((src, index) => (
                    <img
                      key={index}
                      src={src}
                      alt={`第 ${index + 1} 张归档${body.data?.kind === 'video' ? '封面' : '图片'}`}
                      className="h-auto max-w-full"
                    />
                  ))}
                </article>
              )
            )}
          </ModalBody>
        </ModalContent>
      </Modal>
    </main>
  );
}
