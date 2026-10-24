import {
  SubscriptionSearch,
  SubscriptionMore,
  SubscriptionToolbar,
  SubscriptionDialog,
  ContentSortControls,
  ContentSelectionHeader,
  SubscriptionProgress,
} from '@web/components/SubscriptionPrimitives';
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ArticleDateFilter from '@web/components/ArticleDateFilter';
import type { ArticleDateSelection } from '@web/utils/article-date-selection';
import { dateSelectionFilter } from '@web/utils/article-date-selection';
import {
  articleFilterSchema,
  formatShanghaiPublicationTime,
} from '@wewe-rss/shared';
import ManagementFolders from '@web/components/ManagementFolders';
import { trpc } from '@web/utils/trpc';
import { getAuthCode } from '@web/utils/auth';
import { serverOriginUrl } from '@web/utils/env';
import {
  selectedImageNotes,
  taskFinished,
  taskText,
  watchSubscriptionTask,
} from '@web/utils/xiaohongshu-subscription';
import type {
  SubscriptionResolution,
  SubscriptionTask,
  TaskReceipt,
} from '@web/utils/xiaohongshu-subscription';
import { failureMessage } from '@web/utils/operation-message';

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
  const [resolution, setResolution] = useState<SubscriptionResolution | null>(
    null,
  );
  const [subscriptionGroup, setSubscriptionGroup] = useState('');
  const [taskId, setTaskId] = useState('');
  const [task, setTask] = useState<SubscriptionTask | null>(null);
  const [progressOpen, setProgressOpen] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const taskRunning = useRef(false);
  const queuedCreators = useRef<string[]>([]);
  const cancelPending = useRef(false);
  const subscriptionApi = useMemo(
    () => utils.client.xiaohongshu,
    [utils.client],
  );
  const taskApiRef = useRef({ subscriptionApi, utils });
  taskApiRef.current = { subscriptionApi, utils };
  const [profileUrl, setProfileUrl] = useState('');
  const [message, setMessage] = useState('');
  const [operationError, setOperationError] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [folderFilter, setFolderFilter] = useState('all');
  const [selectedCreators, setSelectedCreators] = useState<string[]>([]);
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [dateSelection, setDateSelection] = useState<ArticleDateSelection>({
    mode: 'day',
    start: '',
    end: '',
  });
  const parsedDates = useMemo(
    () => articleFilterSchema.safeParse(dateSelectionFilter(dateSelection)),
    [dateSelection],
  );
  const dateError = parsedDates.success
    ? undefined
    : parsedDates.error.issues[0]?.message;
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [saveSettings, setSaveSettings] = useState<SaveSettings | null>(null);
  const [directory, setDirectory] = useState('');
  const active = useRef(false);

  const startTask = useCallback(
    (receipt: TaskReceipt, kind: 'list' | 'download', total = 0) => {
      if (!receipt.taskId)
        throw new Error('未收到任务编号，请重新读取页面确认操作结果。');
      taskRunning.current = true;
      setTask({
        kind,
        state: 'queued',
        total,
        completed: 0,
        skipped: 0,
        failed: 0,
        remaining: total,
      });
      setProgressOpen(true);
      setTaskId(receipt.taskId);
    },
    [],
  );
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
        if (current) setMessage('本机保存设置读取失败，请重新读取后保存。');
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
  const notesInput = {
    creatorId,
    search: search.trim() || undefined,
    ...dateSelectionFilter(dateSelection),
  };
  const notes = trpc.xiaohongshu.notes.useQuery(notesInput, {
    enabled: !!current && !dateError,
    retry: false,
  });
  const body = trpc.xiaohongshu.body.useQuery(
    { creatorId, noteId },
    { enabled: !!current && !!noteId, retry: false },
  );
  const visibleNotes = useMemo(
    () =>
      dateError
        ? []
        : [...(notes.data?.items || [])].sort((a, b) => {
            if (!a.publishTime || !b.publishTime)
              return a.publishTime
                ? -1
                : b.publishTime
                  ? 1
                  : a.id.localeCompare(b.id);
            return (
              (direction === 'asc'
                ? a.publishTime - b.publishTime
                : b.publishTime - a.publishTime) || a.id.localeCompare(b.id)
            );
          }),
    [dateError, notes.data, direction],
  );
  const selectableNotes = visibleNotes.filter(
    (note) => note.kind === 'image-text' || note.status === 'complete',
  );
  const selectedNotes = selectedImageNotes(visibleNotes, selectedIds);
  const selectedArchives = visibleNotes.filter(
    (note) => selectedIds.has(note.id) && note.status === 'complete',
  );
  const noteStatus = (note: {
    status: string;
    kind: 'image-text' | 'video';
  }) =>
    note.status === 'complete'
      ? note.kind === 'video'
        ? '视频已保存（播放未验证）'
        : '图文已保存'
      : note.kind === 'video' || note.status === 'video-skipped'
        ? '视频未归档'
        : '正文或图片未归档';
  const allSelected =
    selectableNotes.length > 0 &&
    selectableNotes.every((note) => selectedIds.has(note.id));
  const edit = trpc.xiaohongshu.edit.useMutation();
  const remove = trpc.xiaohongshu.remove.useMutation();
  const exportNotes = trpc.xiaohongshu.export.useMutation();
  const saveGroup = trpc.xiaohongshu.saveGroup.useMutation({ retry: false });
  const removeGroup = trpc.xiaohongshu.removeGroup.useMutation();
  const moveCreators = trpc.xiaohongshu.moveCreators.useMutation();
  useEffect(() => {
    if (!taskId) return;
    const { subscriptionApi, utils } = taskApiRef.current;
    const controller = new AbortController();
    void watchSubscriptionTask({
      taskId,
      query: (input) => subscriptionApi.task.query(input),
      signal: controller.signal,
      onTask: (next) => {
        setTask(next);
        setOperationError('');
        if (taskFinished(next)) {
          const nextCreator =
            next.state === 'completed'
              ? queuedCreators.current.shift()
              : undefined;
          if (nextCreator) {
            void subscriptionApi.refresh
              .mutate({ id: nextCreator })
              .then((receipt) => startTask(receipt, 'list'))
              .catch((cause) => {
                queuedCreators.current = [];
                taskRunning.current = false;
                active.current = false;
                setBusy(false);
                setOperationError(
                  failureMessage(cause, '下一位博主列表更新未开始。'),
                );
              });
            void utils.xiaohongshu.list.invalidate();
            void utils.xiaohongshu.notes.invalidate();
            return;
          }
          setTaskId('');
          queuedCreators.current = [];
          taskRunning.current = false;
          active.current = false;
          cancelPending.current = false;
          setCancelling(false);
          setBusy(false);
          setMessage(taskText(next));
          setSelectedIds(new Set());
          void utils.xiaohongshu.list.invalidate();
          void utils.xiaohongshu.notes.invalidate();
        }
      },
      onError: () =>
        setOperationError(
          '进度暂时无法读取，正在重新连接。请勿重复开始；可尝试取消任务。',
        ),
    });
    return () => controller.abort();
  }, [taskId, startTask]);
  const handleCancelTask = async () => {
    if (!taskId || !taskRunning.current || cancelPending.current) return;
    cancelPending.current = true;
    queuedCreators.current = [];
    setCancelling(true);
    try {
      await subscriptionApi.cancelTask.mutate({ taskId });
      if (taskRunning.current)
        setMessage('已请求取消，正在确认已完成和剩余笔记。');
    } catch (cause) {
      cancelPending.current = false;
      setCancelling(false);
      if (taskRunning.current)
        setOperationError(failureMessage(cause, '取消未确认，请重试取消。'));
    }
  };
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
    setOperationError('');
    try {
      await operation();
    } catch (cause) {
      if (!taskRunning.current) queuedCreators.current = [];
      setMessage(
        failureMessage(cause, '操作未完成，请检查服务设置或本机保存目录。') +
          '已有归档保留。',
      );
      setOperationError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!taskRunning.current) {
        active.current = false;
        setBusy(false);
      }
    }
  };
  const selectCreator = (id: string) => {
    if (active.current) return;
    setCreatorId(id);
    setNoteId('');
    setSearch('');
    setDateSelection({ mode: 'day', start: '', end: '' });
    setSelectedIds(new Set());
    setMessage('');
    if (!taskRunning.current) {
      setTaskId('');
      setTask(null);
      setOperationError('');
    }
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
    setSelectedIds(new Set());
    startTask(await subscriptionApi.refresh.mutate({ id }), 'list');
  };
  const handleRefreshAll = () =>
    run(async () => {
      const ids = (creators.data?.items || [])
        .filter((creator) => creator.enabled)
        .map((creator) => creator.id);
      if (!ids.length) return;
      queuedCreators.current = ids.slice(1);
      await updateCreator(ids[0]);
    });
  const handleResolve = () =>
    run(async () => {
      setResolution(null);
      const result = await subscriptionApi.resolveSubscription.mutate({
        url: profileUrl.trim(),
      });
      setResolution(result);
    });
  const handleAdd = () =>
    run(async () => {
      if (!resolution) return;
      if (new Date(resolution.expiresAt).getTime() <= Date.now()) {
        setResolution(null);
        throw new Error('作者确认已过期，请重新识别链接。');
      }
      const result = await subscriptionApi.subscribe.mutate({
        resolutionId: resolution.resolutionId,
        ...(subscriptionGroup && !resolution.existingCreatorId
          ? { groupId: subscriptionGroup }
          : {}),
      });
      if (result.subscribed !== true)
        throw new Error('订阅尚未确认，请重新读取博主列表。');
      setMessage(
        result.created
          ? '订阅成功，正在读取笔记列表。'
          : '已订阅此博主，可更新笔记列表。',
      );
      await utils.xiaohongshu.list.invalidate();
      setCreatorId(result.creatorId);
      setNoteId('');
      setSelectedIds(new Set());
      setFolderFilter('all');
      setProfileUrl('');
      setResolution(null);
      setAdding(false);
      if (result.created) {
        try {
          await updateCreator(result.creatorId);
        } catch (cause) {
          setMessage('订阅已保存，笔记列表暂未读取。可稍后更新列表。');
          setOperationError(failureMessage(cause, '列表更新未开始。'));
        }
      }
    });
  const handleDownload = () =>
    run(async () => {
      if (!current) return;
      const archived = selectedArchives;
      if (!archived.length) return;
      if (archived.length > 100)
        throw new Error('每次最多导出 100 篇，请减少选择后再试。');
      const result = await exportNotes.mutateAsync({
        creatorId: current.id,
        noteIds: archived.map((note) => note.id),
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
        `${current.displayName}：已导出选中的 ${result.notes} 篇已完整保存的笔记 ZIP。`,
      );
    });
  const handleLocalSave = () =>
    run(async () => {
      if (!current || !saveSettings || !selectedNotes.length) return;
      if (selectedNotes.length > 100)
        throw new Error('每次最多保存 100 篇，请减少选择后再试。');
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
      const receipt = await subscriptionApi.downloadNotes.mutate({
        creatorId: current.id,
        noteIds: selectedNotes.map((note) => note.id),
        ...(pickToken ? { pickToken } : {}),
      });
      startTask(receipt, 'download', selectedNotes.length);
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
    <main className="feed-workspace" aria-label="小红书博主与笔记管理">
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
        className={`mac-sidebar feed-sidebar ${mobileSidebarOpen ? 'feed-sidebar-open' : ''}`}
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
              onPress={() => {
                setResolution(null);
                setMessage('');
                setOperationError('');
                setProfileUrl('');
                setSubscriptionGroup(
                  folderFilter !== 'all' && folderFilter !== 'ungrouped'
                    ? folderFilter
                    : '',
                );
                setAdding(true);
              }}
            >
              订阅
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
            await utils.xiaohongshu.groups.cancel();
            const saved = await saveGroup.mutateAsync(input);
            await utils.xiaohongshu.groups.cancel();
            utils.xiaohongshu.groups.setData(undefined, (previous) => {
              if (!previous) return previous;
              const exists = previous.items.some(
                (folder) => folder.id === saved.id,
              );
              return {
                ...previous,
                items: exists
                  ? previous.items.map((folder) =>
                      folder.id === saved.id ? saved : folder,
                    )
                  : [...previous.items, saved].sort(
                      (a, b) => a.order - b.order || a.id.localeCompare(b.id),
                    ),
              };
            });
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
        className="mac-content feed-content !min-w-0 !overflow-y-auto"
        aria-label="小红书笔记列表"
      >
        {task && (
          <SubscriptionProgress
            ariaLabel="笔记任务进度"
            compact={taskFinished(task)}
            value={task.completed + task.skipped}
            total={task.total}
            progressLabel="已完成的笔记数量"
            label={taskText(task)}
            open={progressOpen}
            onOpenChange={setProgressOpen}
            summary={progressOpen ? '收起进度' : '查看进度'}
            actions={
              !taskFinished(task) ? (
                <Button
                  size="sm"
                  variant="light"
                  isDisabled={cancelling}
                  onPress={handleCancelTask}
                >
                  {cancelling ? '正在取消' : '取消任务'}
                </Button>
              ) : null
            }
          >
            <p role="status" className="py-1 text-xs">
              {taskText(task)}
            </p>
          </SubscriptionProgress>
        )}
        <SubscriptionToolbar>
          <div className="flex min-w-0 basis-full flex-wrap items-center gap-x-3 gap-y-1 sm:flex-1 sm:basis-0">
            <h1 className="truncate text-[15px] font-semibold">
              {current?.displayName || '小红书笔记'}
            </h1>
            <span role="status" className="text-xs text-neutral-500">
              {capability.data?.canRefresh ? '可更新笔记列表' : '阅读本地存量'}
            </span>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <SubscriptionSearch
              open={searchOpen}
              label="搜索笔记"
              controls="xhs-search-panel"
              disabled={busy || !current}
              onToggle={() => setSearchOpen(!searchOpen)}
            />
            <Button
              size="sm"
              color="primary"
              variant="flat"
              isDisabled={
                busy ||
                !saveSettings ||
                !selectedNotes.length ||
                selectedNotes.length > 100
              }
              onPress={handleLocalSave}
            >
              下载图文到本地 ({selectedNotes.length})
            </Button>
            <Button
              size="sm"
              variant="light"
              isDisabled={busy || !selectedArchives.length}
              onPress={handleDownload}
            >
              导出已保存 ZIP
            </Button>
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
              更新笔记列表
            </Button>
            <SubscriptionMore key={creatorId}>
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
                更新全部列表
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
            </SubscriptionMore>
          </div>
        </SubscriptionToolbar>
        {message && (
          <p role="status" className="px-3 py-1 text-xs">
            {message}
          </p>
        )}
        <details className="feed-reading-details shrink-0 border-b border-neutral-200 px-3 py-2 text-xs dark:border-neutral-700">
          <summary className="cursor-pointer text-neutral-500">
            来源与本机保存设置{operationError ? ' · 有错误待查看' : ''}
          </summary>
          <div className="space-y-2 py-2">
            <p role="status">
              {capability.error
                ? '更新状态读取失败，请稍后重试。'
                : capability.data
                  ? capability.data.canRefresh
                    ? '可以更新笔记。'
                    : '尚未连接可用来源，暂时无法更新笔记。'
                  : '正在确认更新状态…'}
            </p>
            {capability.data?.message && (
              <details>
                <summary>查看来源详情</summary>
                <p>{capability.data.message}</p>
              </details>
            )}
            <p className="text-xs text-neutral-500">
              订阅后先更新笔记列表，再勾选图文下载正文与图片。已保存的图文会自动去重。
            </p>

            {operationError && (
              <details>
                <summary>查看错误详情</summary>
                <p className="break-words">{operationError}</p>
              </details>
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
                选中图文逐篇保存正文与图片，ZIP
                可单独导出已保存的内容。文件夹只管理订阅，不改变保存目录。
              </p>
            </details>
          </div>
        </details>
        <fieldset disabled={busy} className="disabled:opacity-60">
          <ArticleDateFilter
            value={dateSelection}
            error={dateError}
            onChange={(value) => {
              if (active.current) return;
              setDateSelection(value);
              setSelectedIds(new Set());
            }}
          />
        </fieldset>
        {searchOpen && (
          <div className="px-4 py-2">
            <Input
              aria-label="搜索笔记标题或正文"
              placeholder="搜索标题或已保存正文…"
              value={search}
              onValueChange={handleSearch}
              isDisabled={busy}
            />
          </div>
        )}
        <ContentSortControls
          sort="publishTime"
          onSortChange={() => {}}
          direction={direction}
          onDirectionChange={(value) => {
            setDirection(value);
            setSelectedIds(new Set());
          }}
          options={[{ value: 'publishTime', label: '发布时间' }]}
          disabled={busy}
        />
        <div className="px-3 py-1 text-xs text-neutral-500">
          当前{search ? '筛选' : '博主'} {visibleNotes.length} 篇；已选择{' '}
          {selectedNotes.length}{' '}
          篇图文。全选仅勾选已加载内容；新笔记需另行勾选。
          {search && '修改搜索会清空选择。'}
          {selectedNotes.length > 100 && (
            <span role="alert">每次最多保存或导出 100 篇，请减少选择。</span>
          )}
        </div>
        {notes.error && (
          <p role="alert" className="px-4 py-2 text-sm">
            笔记列表读取失败，既有归档未改动。
          </p>
        )}
        <div
          className="feed-article-scroll mt-2 min-h-0 flex-1 overflow-y-auto"
          role="region"
          aria-label="笔记列表"
          tabIndex={0}
        >
          <div className="compact-list">
            <ContentSelectionHeader
              title={<>笔记标题 · {visibleNotes.length} 篇</>}
              selected={allSelected}
              indeterminate={!allSelected && selectedIds.size > 0}
              disabled={busy || !selectableNotes.length}
              onChange={(value) => {
                if (!active.current)
                  setSelectedIds(
                    value
                      ? new Set(selectableNotes.map((note) => note.id))
                      : new Set(),
                  );
              }}
            />
            {visibleNotes.map((note) => (
              <div
                key={note.id}
                className="compact-row article-row !grid grid-cols-[24px_minmax(0,1fr)] !items-start md:!flex md:!items-center"
              >
                <div className="compact-col-check">
                  <Checkbox
                    size="sm"
                    aria-label={`选择笔记 ${note.title}`}
                    isDisabled={
                      busy ||
                      (note.kind !== 'image-text' && note.status !== 'complete')
                    }
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
                  <span>{formatShanghaiPublicationTime(note.publishTime)}</span>
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
                    : '暂无笔记，请更新笔记列表后选择图文保存。'}
              </p>
            )}
          </div>
        </div>
      </section>
      <SubscriptionDialog
        isOpen={adding}
        onClose={() => {
          if (!active.current) {
            setAdding(false);
            setResolution(null);
          }
        }}
        isKeyboardDismissDisabled={busy}
      >
        <ModalContent>
          <ModalHeader>订阅小红书博主</ModalHeader>
          <ModalBody>
            <p className="text-sm text-neutral-500">
              粘贴笔记链接或博主主页链接，确认作者后订阅。
            </p>
            <Input
              label="笔记或博主主页链接"
              value={profileUrl}
              onValueChange={(value) => {
                setProfileUrl(value);
                setResolution(null);
              }}
              isDisabled={busy}
              maxLength={2000}
            />
            {resolution && (
              <div
                className="space-y-2 rounded-lg border p-3"
                aria-label="确认订阅作者"
              >
                <p>
                  {resolution.inputKind === 'note' ? '笔记作者' : '博主'}：
                  {resolution.author.name}
                </p>
                <p className="break-all text-xs text-neutral-500">
                  {resolution.author.profileUrl}
                </p>
                {resolution.existingCreatorId && (
                  <p>已订阅此博主，确认后可查看笔记。</p>
                )}
                <label className="block text-sm">
                  订阅文件夹
                  <select
                    className="mt-1 w-full rounded border bg-transparent p-2"
                    aria-label="订阅文件夹"
                    value={subscriptionGroup}
                    disabled={busy || !!resolution.existingCreatorId}
                    onChange={(event) =>
                      setSubscriptionGroup(event.target.value)
                    }
                  >
                    <option value="">未分组</option>
                    {groups.data?.items.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            {message && <p role="status">{message}</p>}
          </ModalBody>
          <ModalFooter>
            <Button
              variant="flat"
              isDisabled={busy}
              onPress={() => {
                setAdding(false);
                setResolution(null);
              }}
            >
              取消
            </Button>
            {resolution ? (
              <Button color="primary" isDisabled={busy} onPress={handleAdd}>
                {resolution.existingCreatorId ? '查看已订阅博主' : '确认订阅'}
              </Button>
            ) : (
              <Button
                color="primary"
                isDisabled={busy || !profileUrl.trim()}
                onPress={handleResolve}
              >
                识别作者
              </Button>
            )}
          </ModalFooter>
        </ModalContent>
      </SubscriptionDialog>
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
              这里可阅读已保存的正文和图片；视频笔记仅显示封面。
            </p>
            {body.isLoading ? (
              <Spinner />
            ) : body.error ? (
              <p role="alert">正文读取失败，请稍后重试。</p>
            ) : (
              body.data && (
                <article className="space-y-3">
                  {body.data.kind === 'video' && body.data.video && (
                    <p className="text-sm text-neutral-500">
                      已缓存视频 {body.data.video.bytes.toLocaleString()}{' '}
                      字节。播放尚未验证，请保存到本机后检查。
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
