import XhsBatchSubscription from '@web/components/XhsBatchSubscription';
import type { BatchApi } from '@web/utils/xhs-subscription-batch';
import XhsCombinedFilter from '@web/components/XhsCombinedFilter';
import {
  compileFilter,
  filterNotes,
  emptyCombinedFilter,
  conditionLabel,
} from '@web/utils/xhs-combined-filter';
import type { CombinedFilter } from '@web/utils/xhs-combined-filter';
import { nextMetricOrder, orderNotes } from '@web/utils/xhs-metric-sort';
import type { MetricKey, MetricOrder } from '@web/utils/xhs-metric-sort';
import XhsCreatorAvatar from '@web/components/XhsCreatorAvatar';
import XhsWholeCreator from '@web/components/XhsWholeCreator';
import {
  ContentExportScope,
  ContentLoadMore,
  SubscriptionSearch,
  SubscriptionMore,
  SubscriptionToolbar,
  SubscriptionDialog,
  ContentSortControls,
  SubscriptionProgress,
} from '@web/components/SubscriptionPrimitives';
import {
  Button,
  Checkbox,
  Chip,
  Input,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Spinner,
  Switch,
} from '@nextui-org/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ArticleDateFilter from '@web/components/ArticleDateFilter';
import { noteArchiveStatus } from '@web/utils/xhs-note-presentation';
import XhsOriginalLink from '@web/components/XhsOriginalLink';
import type { PrepareXhsLink } from '@web/components/XhsOriginalLink';
import XhsSourceBudget from '@web/components/XhsSourceBudget';
import type { SourceBudgetApi } from '@web/components/XhsSourceBudget';
import {
  XhsMetricLine,
  XhsNumericFilter,
  XhsNumericFilterValue,
  XhsCreatorMetricRefresh,
} from '@web/components/XhsEngagement';
import type { XhsCreatorMetric } from '@wewe-rss/shared';
import type { ArticleDateSelection } from '@web/utils/article-date-selection';
import { dateSelectionFilter } from '@web/utils/article-date-selection';
import {
  articleFilterSchema,
  formatShanghaiPublicationTime,
} from '@wewe-rss/shared';
import ManagementFolders from '@web/components/ManagementFolders';
import XhsTaskRecovery from '@web/components/XhsTaskRecovery';
import { trpc } from '@web/utils/trpc';
import { getAuthCode } from '@web/utils/auth';
import { serverOriginUrl } from '@web/utils/env';
import {
  exportArchiveGroups,
  toggleLoadedSelection,
  selectedImageNotes,
  taskFinished,
  mayResumeTask,
  preferredRecoveredTask,
  canAdoptRecoveredTask,
  taskNextStep,
  taskSettling,
  taskText,
  watchSubscriptionTask,
} from '@web/utils/xiaohongshu-subscription';
import type {
  SubscriptionResolution,
  SubscriptionTask,
  TaskReceipt,
  RecoveredTask,
  RecentTasksClient,
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
  const connection = trpc.xiaohongshu.connectionStatus.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });
  const restoreConnection = trpc.xiaohongshu.restoreSession.useMutation({
    retry: false,
  });
  const disconnectConnection = trpc.xiaohongshu.disconnectSession.useMutation({
    retry: false,
  });
  const [creatorMetricFilter, setCreatorMetricFilter] = useState<
    Omit<XhsNumericFilterValue, 'metric'> & { metric?: XhsCreatorMetric }
  >({});
  const [noteConditions, setNoteConditions] =
    useState<CombinedFilter>(emptyCombinedFilter);
  const compiledConditions = useMemo(
    () => compileFilter(noteConditions),
    [noteConditions],
  );
  const validCreatorRange =
    creatorMetricFilter.min === undefined ||
    creatorMetricFilter.max === undefined ||
    creatorMetricFilter.min <= creatorMetricFilter.max;
  const validNoteRange = compiledConditions.valid;
  const creators = trpc.xiaohongshu.list.useQuery(creatorMetricFilter, {
    retry: false,
    enabled: validCreatorRange,
  });
  const groups = trpc.xiaohongshu.groups.useQuery(undefined, { retry: false });
  const [creatorId, setCreatorId] = useState('');
  const [sourceSettingsOpen, setSourceSettingsOpen] = useState(false);
  const sourceSettingsRef = useRef<HTMLDetailsElement>(null);
  const queuedDownloads = useRef<
    Array<{ creatorId: string; noteIds: string[] }>
  >([]);
  const nextDownloadRef = useRef<
    (job: { creatorId: string; noteIds: string[] }) => Promise<void>
  >(async () => {});
  const [taskCreatorId, setTaskCreatorId] = useState('');
  const [loadedCount, setLoadedCount] = useState(20);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportScope, setExportScope] = useState<
    'selected' | 'filtered' | 'all'
  >('selected');
  const zipController = useRef<AbortController | null>(null);
  const [zipProgress, setZipProgress] = useState<{
    completed: number;
    total: number;
    state: 'running' | 'completed' | 'cancelled' | 'failed';
  } | null>(null);
  useEffect(() => () => zipController.current?.abort(), []);
  const [resolution, setResolution] = useState<SubscriptionResolution | null>(
    null,
  );
  const [subscriptionGroup, setSubscriptionGroup] = useState('');
  const [taskId, setTaskId] = useState('');
  const [task, setTask] = useState<SubscriptionTask | null>(null);
  const [progressOpen, setProgressOpen] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const taskRunning = useRef(false);
  const lastTaskId = useRef('');
  const queuedCreators = useRef<string[]>([]);
  const cancelPending = useRef(false);
  const subscriptionApi = useMemo(
    () => utils.client.xiaohongshu,
    [utils.client],
  );
  const prepareOriginalLink = useCallback<PrepareXhsLink>(
    (input) => {
      const client = subscriptionApi as typeof subscriptionApi & {
        prepareOriginalLink: {
          mutate: (input: {
            noteId: string;
            refreshContext?: boolean;
          }) => ReturnType<PrepareXhsLink>;
        };
      };
      return client.prepareOriginalLink.mutate({
        noteId: input.noteId,
        ...(input.refreshContext ? { refreshContext: true } : {}),
      });
    },
    [subscriptionApi],
  );
  const sourceBudgetApi = subscriptionApi as typeof subscriptionApi &
    SourceBudgetApi;
  const showOriginalBudget = () => {
    setSourceSettingsOpen(true);
    if (sourceSettingsRef.current) {
      sourceSettingsRef.current.open = true;
      sourceSettingsRef.current.scrollIntoView({ block: 'nearest' });
    }
  };
  const taskApiRef = useRef({ subscriptionApi, utils });
  taskApiRef.current = { subscriptionApi, utils };
  const [profileUrl, setProfileUrl] = useState('');
  const [message, setMessage] = useState('');
  const [operationError, setOperationError] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [managing, setManaging] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [folderFilter, setFolderFilter] = useState('all');
  const [selectedCreators, setSelectedCreators] = useState<string[]>([]);
  const [metricOrder, setMetricOrder] = useState<MetricOrder>(null);
  const sortMetric = (metric: MetricKey) => {
    if (!active.current) {
      setMetricOrder((value) => nextMetricOrder(value, metric));
      setLoadedCount(20);
    }
  };
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [dateSelection, setDateSelection] = useState<ArticleDateSelection>({
    mode: 'day',
    start: '',
    end: '',
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !adding && !exportOpen)
        setSearchOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [adding, exportOpen]);
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

  const [recoveredTasks, setRecoveredTasks] = useState<RecoveredTask[]>([]);
  const [recoveryLoading, setRecoveryLoading] = useState(true);
  const [recoveryError, setRecoveryError] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const activityGeneration = useRef(0);
  const recoveryAttempted = useRef(false);
  const recoveryRequest = useRef(0);
  const readRecentRef = useRef<() => Promise<void>>(async () => {});
  const adoptRecoveredTask = useCallback(
    (record: RecoveredTask, expand = true) => {
      if (active.current) return;
      activityGeneration.current++;
      recoveryAttempted.current = true;
      queuedCreators.current = [];
      queuedDownloads.current = [];
      lastTaskId.current = record.taskId;
      setTaskCreatorId(record.creatorId);
      setTask(record);
      setZipProgress(null);
      setOperationError('');
      setProgressOpen(expand);
      cancelPending.current = false;
      setCancelling(false);
      const watching = !taskFinished(record) || taskSettling(record);
      taskRunning.current = watching;
      active.current = watching;
      setBusy(watching);
      setTaskId(watching ? record.taskId : '');
      setMessage('已找回本地任务记录。继续未完成内容需要明确点击。');
    },
    [],
  );
  const readRecentTasks = useCallback(async () => {
    const request = ++recoveryRequest.current;
    const generation = activityGeneration.current;
    setRecoveryLoading(true);
    setRecoveryError(false);
    try {
      // Exact supplied contract; this local boundary disappears after backend integration.
      const client = taskApiRef.current
        .subscriptionApi as typeof subscriptionApi & RecentTasksClient;
      const result = await client.recentTasks.query({ limit: 10 });
      if (request !== recoveryRequest.current) return;
      setRecoveredTasks(result.items);
      const chosen = preferredRecoveredTask(result.items);
      if (
        canAdoptRecoveredTask({
          requestedGeneration: generation,
          currentGeneration: activityGeneration.current,
          busy: active.current,
          alreadyRecovered: recoveryAttempted.current,
        })
      ) {
        recoveryAttempted.current = true;
        if (chosen) adoptRecoveredTask(chosen, false);
      }
    } catch {
      if (request === recoveryRequest.current) setRecoveryError(true);
    } finally {
      if (request === recoveryRequest.current) setRecoveryLoading(false);
    }
  }, [adoptRecoveredTask]);
  readRecentRef.current = readRecentTasks;
  const invalidateRecoveryRequest = useCallback(() => {
    recoveryRequest.current++;
  }, []);
  useEffect(() => {
    void readRecentTasks();
    return invalidateRecoveryRequest;
  }, [readRecentTasks, invalidateRecoveryRequest]);
  const selectRecoveredTask = async (record: RecoveredTask) => {
    if (active.current) return;
    if (!record.supersededByTaskId) return adoptRecoveredTask(record);
    const child = recoveredTasks.find(
      (item) => item.taskId === record.supersededByTaskId,
    );
    if (child) return adoptRecoveredTask(child);
    const generation = ++activityGeneration.current;
    recoveryAttempted.current = true;
    try {
      const childRecord = await subscriptionApi.task.query({
        taskId: record.supersededByTaskId,
      });
      if (generation === activityGeneration.current && !active.current)
        adoptRecoveredTask(childRecord);
    } catch {
      if (generation === activityGeneration.current)
        setOperationError('接续任务暂时无法读取，请重新读取本地任务记录。');
    }
  };
  const startTask = useCallback(
    (receipt: TaskReceipt, kind: 'list' | 'download', total = 0) => {
      if (!receipt.taskId)
        throw new Error('未收到任务编号，请重新读取页面确认操作结果。');
      activityGeneration.current++;
      recoveryAttempted.current = true;
      setZipProgress(null);
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
      setTaskCreatorId(receipt.creatorId || '');
      lastTaskId.current = receipt.taskId;
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
    creatorId: creatorId || undefined,
    ...(folderFilter === 'all'
      ? {}
      : { groupId: folderFilter === 'ungrouped' ? null : folderFilter }),
    search: search.trim() || undefined,
    ...dateSelectionFilter(dateSelection),
  };
  const notes = trpc.xiaohongshu.notes.useQuery(notesInput, {
    enabled: !dateError && validNoteRange,
    retry: false,
  });
  const visibleNotes = useMemo(
    () =>
      dateError || !validNoteRange
        ? []
        : orderNotes(
            filterNotes(notes.data?.items || [], compiledConditions),
            metricOrder,
            direction,
          ),
    [
      dateError,
      validNoteRange,
      notes.data,
      metricOrder,
      direction,
      compiledConditions,
    ],
  );
  const loadedNotes = visibleNotes.slice(0, loadedCount);
  const selectableNotes = loadedNotes.filter(
    (note) => note.kind === 'image-text' || note.status === 'complete',
  );
  const selectedNotes = selectedImageNotes(visibleNotes, selectedIds);
  const selectedArchives = visibleNotes.filter(
    (note) => selectedIds.has(note.id) && note.status === 'complete',
  );
  const allArchiveNotes = trpc.xiaohongshu.notes.useQuery(
    { creatorId: creatorId || undefined },
    { enabled: exportOpen && exportScope === 'all', retry: false },
  );
  const exportPreviewCount =
    exportScope === 'selected'
      ? selectedArchives.length
      : (exportScope === 'all'
          ? allArchiveNotes.data?.items
          : visibleNotes
        )?.filter((note) => note.status === 'complete').length;
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
        if (taskFinished(next) && !taskSettling(next)) {
          const nextDownload =
            next.state === 'completed'
              ? queuedDownloads.current.shift()
              : undefined;
          if (nextDownload) {
            void nextDownloadRef.current(nextDownload).catch((cause) => {
              queuedDownloads.current = [];
              taskRunning.current = false;
              active.current = false;
              setTaskId('');
              setBusy(false);
              setOperationError(
                failureMessage(cause, '下一位博主的保存未开始。'),
              );
            });
            void utils.xiaohongshu.notes.invalidate();
            return;
          }
          queuedDownloads.current = [];
          const nextCreator =
            next.state === 'completed'
              ? queuedCreators.current.shift()
              : undefined;
          if (nextCreator) {
            void subscriptionApi.refresh
              .mutate({ id: nextCreator, maxPages: 2 })
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
          void readRecentRef.current();
          void utils.xiaohongshu.list.invalidate();
          void utils.xiaohongshu.notes.invalidate();
          void utils.xiaohongshu.capability.invalidate();
          void utils.xiaohongshu.connectionStatus.invalidate();
        }
      },
      onError: () =>
        setOperationError(
          '进度暂时无法读取，正在重新连接。请勿重复开始；可尝试取消任务。',
        ),
    });
    return () => controller.abort();
  }, [taskId, startTask]);
  const handleResumeTask = () =>
    run(async () => {
      if (!task || !mayResumeTask(task) || !lastTaskId.current) return;
      let pickToken: string | undefined;
      if (task.kind === 'download' && saveSettings?.askEveryTime) {
        const chosen = await localApi<DirectoryChoice>('/directory', {});
        if (chosen.cancelled) {
          setMessage('已取消续跑目录选择，原任务保留。');
          return;
        }
        pickToken = chosen.pickToken;
        setSaveSettings({
          directory: chosen.directory,
          askEveryTime: chosen.askEveryTime,
        });
        setDirectory(chosen.directory);
      }
      const previousTaskId = lastTaskId.current;
      const receipt = await subscriptionApi.resumeTask
        .mutate({
          taskId: lastTaskId.current,
          ...(pickToken ? { pickToken } : {}),
        })
        .catch((cause: unknown) => {
          if (
            cause instanceof Error &&
            cause.message.includes('XHS_TASK_RECEIPT_UNCERTAIN')
          ) {
            const block = {
              state: 'blocked' as const,
              resumable: false,
              code: 'XHS_TASK_RECEIPT_UNCERTAIN',
              message: '续跑回执无法确认，请先重新读取本地任务记录。',
            };
            setTask((previous) =>
              previous ? { ...previous, ...block } : previous,
            );
            setRecoveredTasks((previous) =>
              previous.map((record) =>
                record.taskId === previousTaskId
                  ? { ...record, ...block }
                  : record,
              ),
            );
            void readRecentRef.current();
          }
          throw cause;
        });
      setRecoveredTasks((previous) =>
        previous.filter((record) => record.taskId !== previousTaskId),
      );
      startTask(receipt, task.kind, task.total);
      void readRecentRef.current();
    });
  const handleCancelTask = async () => {
    if (!taskId || !taskRunning.current || cancelPending.current) return;
    cancelPending.current = true;
    queuedCreators.current = [];
    queuedDownloads.current = [];
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
      creatorId &&
      creators.data &&
      !creators.data.items.some((creator) => creator.id === creatorId)
    ) {
      setCreatorId('');
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
      if (!taskRunning.current) {
        queuedCreators.current = [];
        queuedDownloads.current = [];
      }
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
    setLoadedCount(20);
    setExportOpen(false);
    setZipProgress(null);
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
    setLoadedCount(20);
    setExportOpen(false);
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
    startTask(
      await subscriptionApi.refresh.mutate({ id, maxPages: 2 }),
      'list',
    );
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
      const controller = new AbortController();
      zipController.current = controller;
      const scopeName = current?.displayName || '全部笔记';
      const allScope = { creatorId: creatorId || undefined };
      const scope = exportScope;
      const selectedSnapshot = [...selectedArchives];
      const combinationSnapshot = compiledConditions;
      const filterSnapshot = {
        ...notesInput,
        ...(notes.data?.queryVersion
          ? { queryVersion: notes.data.queryVersion }
          : {}),
      };
      setExportOpen(false);
      setTask(null);
      setProgressOpen(true);
      setZipProgress({ completed: 0, total: 0, state: 'running' });
      let completed = 0;
      let total = 0;
      try {
        const exportFilter = scope === 'all' ? allScope : filterSnapshot;
        const freshScope =
          scope === 'selected'
            ? undefined
            : await utils.client.xiaohongshu.notes.query(exportFilter);
        const exportSnapshot = {
          ...exportFilter,
          ...(freshScope?.queryVersion
            ? { queryVersion: freshScope.queryVersion }
            : {}),
        };
        const candidates =
          scope === 'selected'
            ? selectedSnapshot
            : scope === 'filtered'
              ? filterNotes(freshScope!.items, combinationSnapshot)
              : freshScope!.items;
        if (controller.signal.aborted) {
          setZipProgress({ completed, total, state: 'cancelled' });
          return;
        }
        const ids = candidates
          .filter((note) => note.status === 'complete')
          .map((note) => note.id);
        total = ids.length;
        if (!ids.length) throw new Error('此范围暂无已保存完整的笔记。');
        setZipProgress({ completed, total, state: 'running' });
        const result = await exportArchiveGroups({
          notes: candidates.filter((note) => note.status === 'complete'),
          signal: controller.signal,
          // The owner partitions filenames; the query version belongs to the
          // entire confirmed scope, including a mixed-author selection.
          send: (_creatorId, noteIds) =>
            exportNotes.mutateAsync({ ...exportSnapshot, noteIds }),
          save: (receipt, part, parts, authorId, authors) => {
            const bytes = Uint8Array.from(atob(receipt.base64), (char) =>
              char.charCodeAt(0),
            );
            const url = URL.createObjectURL(
              new Blob([bytes], { type: receipt.mimeType }),
            );
            const link = document.createElement('a');
            try {
              link.href = url;
              link.download =
                (authors > 1
                  ? authorId.replace(/[^a-zA-Z0-9_-]/g, '_') + '-'
                  : '') +
                (parts > 1
                  ? receipt.filename.replace(/\.zip$/i, '') +
                    `-part-${part}-of-${parts}.zip`
                  : receipt.filename);
              document.body.appendChild(link);
              link.click();
            } finally {
              link.remove();
              URL.revokeObjectURL(url);
            }
          },
          onProgress: (count, size) => {
            completed = count;
            setZipProgress({ completed, total: size, state: 'running' });
          },
        });
        setZipProgress({
          completed: result.completed,
          total: result.total,
          state: result.cancelled ? 'cancelled' : 'completed',
        });
        setMessage(
          `${scopeName}：ZIP 导出${result.cancelled ? '已取消' : '已完成'}，已交给浏览器下载 ${result.completed}/${result.total} 篇。`,
        );
      } catch (cause) {
        setZipProgress({ completed, total, state: 'failed' });
        throw cause;
      } finally {
        if (zipController.current === controller) zipController.current = null;
      }
    });
  const startDownloadJob = async (job: {
    creatorId: string;
    noteIds: string[];
  }) => {
    if (!saveSettings) throw new Error('请先读取本机保存设置。');
    let pickToken: string | undefined;
    if (saveSettings.askEveryTime) {
      const chosen = await localApi<DirectoryChoice>('/directory', {});
      if (chosen.cancelled) {
        queuedDownloads.current = [];
        taskRunning.current = false;
        active.current = false;
        setTaskId('');
        setBusy(false);
        setMessage('已取消目录选择，未开始后续保存。');
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
      creatorId: job.creatorId,
      noteIds: job.noteIds,
      ...(pickToken ? { pickToken } : {}),
    });
    startTask(receipt, 'download', job.noteIds.length);
  };
  nextDownloadRef.current = startDownloadJob;
  const handleLocalSave = (archivedOnly = false) =>
    run(async () => {
      const targets = archivedOnly ? selectedArchives : selectedNotes;
      if (!saveSettings || !targets.length) return;
      const byAuthor = new Map<string, string[]>();
      for (const note of targets) {
        const ids = byAuthor.get(note.creatorId) || [];
        ids.push(note.id);
        byAuthor.set(note.creatorId, ids);
      }
      const jobs = [...byAuthor].map(([creatorId, noteIds]) => ({
        creatorId,
        noteIds,
      }));
      queuedDownloads.current = jobs.slice(1);
      await startDownloadJob(jobs[0]);
    });
  const updateConnection = (action: 'restore' | 'disconnect') =>
    run(async () => {
      if (action === 'restore') await restoreConnection.mutateAsync();
      else await disconnectConnection.mutateAsync();
      setResolution(null);
      await Promise.all([
        connection.refetch(),
        utils.xiaohongshu.capability.invalidate(),
      ]);
      setMessage(
        action === 'restore'
          ? '已恢复本机会话，请重新识别需要订阅的链接。'
          : '已断开本机会话，本地内容保留。',
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
    setSelectedIds(new Set());
    await Promise.all([
      utils.xiaohongshu.groups.invalidate(),
      utils.xiaohongshu.list.invalidate(),
      utils.xiaohongshu.notes.invalidate(),
    ]);
  };
  return (
    <main className="feed-workspace" aria-label="小红书博主与笔记管理">
      <div className="feed-source-controls flex shrink-0 items-center gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-700">
        {current && (
          <XhsCreatorAvatar
            url={
              (current as typeof current & { avatarUrl?: string | null })
                .avatarUrl
            }
            name={current.displayName}
          />
        )}
        <label className="min-w-0 flex-1 text-xs text-neutral-500">
          当前博主
          <select
            aria-label="手机选择小红书博主"
            className="bg-background mt-1 w-full min-w-0 rounded border p-2 text-sm"
            value={creatorId}
            disabled={busy}
            onChange={(event) => {
              if (!active.current) {
                setFolderFilter('all');
                selectCreator(event.target.value);
              }
            }}
          >
            <option value="">全部笔记</option>
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
          {mobileSidebarOpen ? '收起管理' : '管理与分组'}
        </Button>
        {folderFilter !== 'all' && (
          <span className="feed-active-group text-xs" role="status">
            分组：
            {folderFilter === 'ungrouped'
              ? '未分组'
              : groups.data?.items.find((folder) => folder.id === folderFilter)
                  ?.name}
          </span>
        )}
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
            setCreatorId('');
            setLoadedCount(20);
            setSelectedIds(new Set());
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
        <Button
          size="sm"
          variant={creatorId ? 'light' : 'flat'}
          isDisabled={busy}
          onPress={() => {
            if (!active.current) {
              setFolderFilter('all');
              selectCreator('');
            }
          }}
        >
          全部笔记
        </Button>
        <XhsNumericFilter
          disabled={busy}
          creator
          value={creatorMetricFilter}
          onChange={(value) => {
            setCreatorMetricFilter(value as typeof creatorMetricFilter);
            setSelectedCreators([]);
            setSelectedIds(new Set());
          }}
        />
        {current && (
          <XhsCreatorMetricRefresh
            key={current.id}
            creatorId={current.id}
            enabled={!busy && capability.data?.canRefresh === true}
          />
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
                <XhsCreatorAvatar
                  url={
                    (creator as typeof creator & { avatarUrl?: string | null })
                      .avatarUrl
                  }
                  name={creator.displayName}
                />
                {creator.displayName}
                <span className="block truncate">
                  <XhsMetricLine snapshot={creator.metrics} creator />
                </span>
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
        <XhsWholeCreator creatorId={creatorId} />
        <XhsTaskRecovery
          tasks={recoveredTasks}
          loading={recoveryLoading}
          error={recoveryError}
          disabled={busy}
          selectedTaskId={task ? lastTaskId.current : ''}
          open={recoveryOpen}
          onOpenChange={setRecoveryOpen}
          onRetry={() => void readRecentTasks()}
          onSelect={(record) => void selectRecoveredTask(record)}
          authorName={(id) =>
            creators.data?.items.find((item) => item.id === id)?.displayName ||
            '已保存的博主任务'
          }
        />
        {zipProgress && (
          <SubscriptionProgress
            ariaLabel="ZIP 导出进度"
            compact={zipProgress.state !== 'running'}
            value={zipProgress.completed}
            total={zipProgress.total}
            progressLabel="已导出的笔记数量"
            label={`ZIP 导出 ${zipProgress.completed}/${zipProgress.total}`}
            open={progressOpen}
            onOpenChange={setProgressOpen}
            summary={progressOpen ? '收起进度' : '查看进度'}
            actions={
              zipProgress.state === 'running' ? (
                <Button
                  size="sm"
                  variant="light"
                  onPress={() => zipController.current?.abort()}
                >
                  取消导出
                </Button>
              ) : null
            }
          >
            <p role="status">
              ZIP 导出
              {
                {
                  running: '进行中',
                  completed: '已完成',
                  cancelled: '已取消',
                  failed: '未完成',
                }[zipProgress.state]
              }
              ：{zipProgress.completed}/{zipProgress.total} 篇。每 100
              篇生成一个文件。
            </p>
          </SubscriptionProgress>
        )}
        {task && (
          <p className="px-3 py-1 text-xs text-neutral-500">
            {creators.data?.items.find((item) => item.id === taskCreatorId)
              ?.displayName || '笔记任务'}
            {queuedDownloads.current.length
              ? ` · 后续 ${queuedDownloads.current.length} 位博主`
              : ''}
          </p>
        )}
        {task && (
          <SubscriptionProgress
            ariaLabel="笔记任务进度"
            compact={taskFinished(task) && !taskSettling(task)}
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
              ) : mayResumeTask(task) ? (
                <Button
                  size="sm"
                  variant="light"
                  isDisabled={busy}
                  onPress={handleResumeTask}
                >
                  继续未完成任务
                </Button>
              ) : null
            }
            notice={
              taskSettling(task) ? (
                <p role="status">正在结束当前保存，确认后可继续未完成任务。</p>
              ) : undefined
            }
          >
            <p role="status" className="py-1 text-xs">
              {taskText(task)}
            </p>
            <p className="py-1 text-xs text-neutral-500">
              {taskNextStep(task)}
            </p>
          </SubscriptionProgress>
        )}
        <SubscriptionToolbar>
          <div className="flex min-w-0 basis-full flex-wrap items-center gap-x-3 gap-y-1 sm:flex-1 sm:basis-0">
            <h1 className="truncate text-[15px] font-semibold">
              {current?.displayName ||
                (folderFilter === 'all' ? '全部笔记' : '分组笔记')}
            </h1>
            <span role="status" className="text-xs text-neutral-500">
              {capability.data?.canRefresh
                ? '每次更新最多读取 2 页，更多需明确继续'
                : '管理已有目录'}
            </span>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="light"
              isDisabled={busy}
              onPress={() => setBatchOpen(true)}
            >
              批量订阅
            </Button>
            <SubscriptionSearch
              open={searchOpen}
              label="搜索笔记"
              controls="xhs-search-panel"
              disabled={busy}
              onToggle={() => setSearchOpen(!searchOpen)}
            />
            <Button
              size="sm"
              color="primary"
              variant="flat"
              isDisabled={busy || !saveSettings || !selectedNotes.length}
              onPress={() => handleLocalSave()}
            >
              下载图文到本地 ({selectedNotes.length})
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
              <Button
                size="sm"
                variant="light"
                isDisabled={busy}
                onPress={() => {
                  setExportScope(
                    selectedArchives.length ? 'selected' : 'filtered',
                  );
                  setExportOpen(true);
                }}
              >
                导出已保存 ZIP
              </Button>

              <Button
                size="sm"
                variant="light"
                isDisabled={busy || !saveSettings || !selectedArchives.length}
                onPress={() => handleLocalSave(true)}
              >
                保存已选归档到本地
              </Button>
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
        <details
          ref={sourceSettingsRef}
          onToggle={(event) => setSourceSettingsOpen(event.currentTarget.open)}
          className="feed-reading-details shrink-0 border-b border-neutral-200 px-3 py-2 text-xs dark:border-neutral-700"
        >
          <summary className="cursor-pointer text-neutral-500">
            来源与本机保存设置{operationError ? ' · 有错误待查看' : ''}
          </summary>
          <div className="space-y-2 py-2">
            {sourceSettingsOpen && !adding && (
              <section aria-label="共享来源请求额度">
                <XhsSourceBudget
                  key="shared-source-budget"
                  api={sourceBudgetApi}
                  scope={{ purpose: 'resolution' }}
                />
              </section>
            )}
            <section aria-label="小红书连接状态" className="space-y-2">
              <p role="status">
                {connection.error
                  ? '连接状态暂时无法读取，可重试。'
                  : !connection.data
                    ? '正在读取本机连接状态…'
                    : !connection.data.liveEnabled
                      ? '真实访问尚未启用，可查看已存数据和导出本地内容。'
                      : connection.data.code ===
                          'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED'
                        ? '来源 API 拒绝了请求，原因尚不明确；采集已停止。网页可访问不代表此接口可用，请先核查来源状态。'
                        : connection.data.code ===
                            'XHS_SOURCE_VERIFICATION_BLOCKED'
                          ? '来源明确提示需要验证，但当前没有可确认的验证入口；采集已停止，请先核查来源状态。'
                          : connection.data.code?.startsWith('XHS_SOURCE_')
                            ? '来源请求已暂停，请核查采集会话与来源状态后再明确连接。'
                            : connection.data.code ===
                                'XHS_DISCONNECT_INCOMPLETE'
                              ? '连接已断开，但受保护记录清理未确认，请重新读取状态。'
                              : !connection.data.connected
                                ? '尚未连接，请通过本机安全连接工具完成连接。'
                                : connection.data.verified
                                  ? '本机会话可用。'
                                  : '本机会话已就绪，平台验证尚未完成。'}
              </p>
              {connection.data && (
                <p className="text-default-500 text-xs" role="status">
                  {connection.data.riskCode
                    ? '本机存在已记录的来源停止状态；原因和解除条件须核查，恢复会话不会清除该记录。'
                    : '未发现已记录的来源停止状态；缺失的历史记录仍待核查，不能据此认定限制已解除。'}
                </p>
              )}
              {connection.data?.requestAttempts && (
                <p className="text-default-500 text-xs">
                  本进程请求尝试：作者{' '}
                  {connection.data.requestAttempts.profiles}、列表{' '}
                  {connection.data.requestAttempts.lists}、详情{' '}
                  {connection.data.requestAttempts.details}、图片{' '}
                  {connection.data.requestAttempts.media}
                  。读取状态不增加请求；重启后计数重新开始。
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="light"
                  isDisabled={busy}
                  onPress={() =>
                    void Promise.all([
                      connection.refetch(),
                      utils.xiaohongshu.capability.invalidate(),
                    ])
                  }
                >
                  重新读取连接状态
                </Button>
                <Button
                  size="sm"
                  variant="flat"
                  isDisabled={
                    busy ||
                    !connection.data?.liveEnabled ||
                    connection.data?.stored !== true
                  }
                  onPress={() => updateConnection('restore')}
                >
                  恢复本机会话
                </Button>
                <Button
                  size="sm"
                  variant="light"
                  isDisabled={
                    busy ||
                    !(connection.data?.connected || connection.data?.stored)
                  }
                  onPress={() => updateConnection('disconnect')}
                >
                  断开本机会话
                </Button>
              </div>
              <p className="text-xs text-neutral-500">
                连接信息仅由本机安全工具处理。恢复后需重新识别链接；断开不删除已保存笔记。
              </p>
            </section>
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
        <div className="xhs-filter-bar">
          <div className="xhs-active-filters" aria-label="已选条件">
            {creatorMetricFilter.metric && (
              <span>
                博主 · {creatorMetricFilter.metric === 'fans' ? '粉丝' : '关注'}{' '}
                {creatorMetricFilter.min ?? '不限'}–
                {creatorMetricFilter.max ?? '不限'}
              </span>
            )}
            {noteConditions.conditions.map((condition) => (
              <span key={condition.id}>{conditionLabel(condition)}</span>
            ))}
            <span>
              {metricOrder
                ? {
                    likes: '点赞',
                    collects: '收藏',
                    shares: '分享',
                    comments: '评论',
                  }[metricOrder.metric] +
                  (metricOrder.direction === 'desc' ? ' ↓' : ' ↑')
                : '按时间' + (direction === 'desc' ? ' ↓' : ' ↑')}
            </span>
            {(noteConditions.conditions.length > 0 ||
              creatorMetricFilter.metric ||
              search ||
              dateSelection.start) && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setNoteConditions(emptyCombinedFilter());
                  setCreatorMetricFilter({});
                  setSearch('');
                  setDateSelection({ mode: 'day', start: '', end: '' });
                  setLoadedCount(20);
                  setSelectedIds(new Set());
                }}
              >
                清除筛选
              </button>
            )}
          </div>
          <fieldset disabled={busy} className="disabled:opacity-60">
            <ArticleDateFilter
              value={dateSelection}
              error={dateError}
              onChange={(value) => {
                if (active.current) return;
                setLoadedCount(20);
                setExportOpen(false);
                setDateSelection(value);
                setSelectedIds(new Set());
              }}
            />
          </fieldset>
          {searchOpen && (
            <div id="xhs-search-panel" className="px-4 py-2">
              <Input
                autoFocus
                isClearable
                onClear={() => handleSearch('')}
                maxLength={200}
                aria-label="搜索笔记标题或正文"
                placeholder="搜索标题或已保存正文…"
                value={search}
                onValueChange={handleSearch}
                isDisabled={busy}
              />
            </div>
          )}
          {!searchOpen && search !== '' && (
            <div className="min-w-0 shrink-0 px-4 py-2">
              <Chip
                size="sm"
                variant="flat"
                title={`搜索：${search}`}
                aria-label={`搜索：${search}；清除关键词`}
                isDisabled={busy}
                onClose={() => handleSearch('')}
                classNames={{
                  base: 'max-w-full',
                  content: 'min-w-0 truncate',
                  closeButton: 'shrink-0',
                }}
              >
                搜索：{search}
              </Chip>
            </div>
          )}
          {search.trim() && (
            <p role="status" className="px-4 py-1 text-xs text-neutral-500">
              搜索当前范围的标题、博主名与已保存正文；未下载的正文不在搜索范围内。搜索不会联网取文。
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2 px-3 py-1 text-xs">
            <Button
              size="sm"
              variant="light"
              isDisabled={busy || !visibleNotes.length}
              onPress={() => {
                if (!active.current)
                  setSelectedIds(
                    new Set(
                      visibleNotes
                        .filter(
                          (note) =>
                            note.kind === 'image-text' ||
                            note.status === 'complete',
                        )
                        .map((note) => note.id),
                    ),
                  );
              }}
            >
              选择当前筛选全部
            </Button>
            <Button
              size="sm"
              variant="light"
              isDisabled={busy || !selectedIds.size}
              onPress={() => {
                if (!active.current) setSelectedIds(new Set());
              }}
            >
              清空选择
            </Button>
          </div>
          <XhsCombinedFilter
            disabled={busy}
            value={noteConditions}
            onChange={(value) => {
              setNoteConditions(value);
              setSelectedIds(new Set());
              setLoadedCount(20);
              setExportOpen(false);
            }}
          />

          {metricOrder ? (
            <div
              className="flex flex-wrap items-center gap-2 text-xs"
              aria-label="当前排序"
            >
              <span role="status">
                当前排序：
                {
                  {
                    likes: '点赞',
                    collects: '收藏',
                    shares: '分享',
                    comments: '评论',
                  }[metricOrder.metric]
                }{' '}
                · {metricOrder.direction === 'desc' ? '从高到低' : '从低到高'}
              </span>
              <Button
                size="sm"
                variant="light"
                isDisabled={busy}
                onPress={() => {
                  if (!active.current) {
                    setMetricOrder(null);
                    setLoadedCount(20);
                  }
                }}
              >
                恢复时间排序
              </Button>
            </div>
          ) : (
            <ContentSortControls
              sort="publishTime"
              onSortChange={() => {}}
              direction={direction}
              onDirectionChange={(value) => {
                setLoadedCount(20);
                setDirection(value);
                setMetricOrder(null);
                setSelectedIds(new Set());
              }}
              options={[{ value: 'publishTime', label: '发布时间' }]}
              disabled={busy}
            />
          )}
        </div>
        <div className="xhs-list-caption text-xs text-neutral-500">
          当前范围 {visibleNotes.length} 条目录 · 完整归档{' '}
          {visibleNotes.filter((note) => note.status === 'complete').length} 篇
          · 已选 {selectedNotes.length} 篇图文 · — 表示未采集，0 为真实数值。
          {search && '修改搜索会清空选择。'}
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
          <div
            className="compact-list xhs-note-list"
            role="table"
            aria-label="笔记数据"
          >
            <div className="xhs-note-head xhs-note-row" role="row">
              <Checkbox
                size="sm"
                aria-label="全选已加载"
                isSelected={allSelected}
                isIndeterminate={!allSelected && selectedIds.size > 0}
                isDisabled={busy || !selectableNotes.length}
                onValueChange={(value) => {
                  if (!active.current)
                    setSelectedIds(
                      value
                        ? toggleLoadedSelection(
                            selectedIds,
                            selectableNotes.map((note) => note.id),
                            true,
                          )
                        : toggleLoadedSelection(
                            selectedIds,
                            selectableNotes.map((note) => note.id),
                            false,
                          ),
                    );
                }}
              />
              <span>笔记标题 · {visibleNotes.length} 篇</span>
              <span>发布时间</span>
              {(['likes', 'collects', 'shares', 'comments'] as const).map(
                (metric) => (
                  <span
                    key={metric}
                    role="columnheader"
                    aria-sort={
                      metricOrder?.metric === metric
                        ? metricOrder.direction === 'desc'
                          ? 'descending'
                          : 'ascending'
                        : 'none'
                    }
                  >
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => sortMetric(metric)}
                      aria-label={
                        {
                          likes: '点赞',
                          collects: '收藏',
                          shares: '分享',
                          comments: '评论',
                        }[metric] +
                        '排序：' +
                        (metricOrder?.metric !== metric
                          ? '从高到低'
                          : metricOrder.direction === 'desc'
                            ? '从低到高'
                            : '恢复时间排序')
                      }
                    >
                      {
                        {
                          likes: '点赞',
                          collects: '收藏',
                          shares: '分享',
                          comments: '评论',
                        }[metric]
                      }
                      {metricOrder?.metric === metric
                        ? metricOrder.direction === 'desc'
                          ? ' ↓'
                          : ' ↑'
                        : ' ↕'}
                    </button>
                  </span>
                ),
              )}
              <span>状态</span>
            </div>
            {loadedNotes.map((note) => (
              <div
                key={note.id}
                className="content-article-row xhs-note-row"
                role="row"
              >
                <div className="compact-col-check xhs-note-check">
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
                <XhsOriginalLink
                  key={`original:${note.creatorId}:${note.id}`}
                  creatorId={note.creatorId}
                  noteId={note.id}
                  title={note.title}
                  author={!creatorId ? note.creatorName : undefined}
                  prepare={prepareOriginalLink}
                  onConfigure={showOriginalBudget}
                />
                <time
                  className="xhs-note-date"
                  title={formatShanghaiPublicationTime(note.publishTime)}
                >
                  {note.publishTime
                    ? formatShanghaiPublicationTime(note.publishTime)
                    : '时间未知'}
                </time>
                {(['likes', 'collects', 'shares', 'comments'] as const).map(
                  (metric) => {
                    const value = note.metrics?.values[metric];
                    const label = {
                      likes: '点赞',
                      collects: '收藏',
                      shares: '分享',
                      comments: '评论',
                    }[metric];
                    return (
                      <span
                        key={metric}
                        className="xhs-note-metric"
                        data-metric={metric}
                        data-label={label}
                        title={`${label}：${value == null ? '未采集' : value.toLocaleString('zh-CN')}`}
                        aria-label={`${label}：${value == null ? '未采集' : value}`}
                      >
                        {value == null
                          ? '—'
                          : new Intl.NumberFormat('zh-CN', {
                              notation: value >= 10000 ? 'compact' : 'standard',
                              maximumFractionDigits: 1,
                            }).format(value)}
                      </span>
                    );
                  },
                )}
                <span
                  className="xhs-note-status"
                  title={noteArchiveStatus(note)}
                >
                  {note.status === 'complete' ? '已归档' : '仅目录'}
                </span>
              </div>
            ))}
            {loadedNotes.length < visibleNotes.length && (
              <ContentLoadMore
                loading={false}
                disabled={busy}
                onLoad={() => {
                  if (!active.current) setLoadedCount((count) => count + 20);
                }}
              />
            )}
            {notes.isLoading && current && (
              <div className="flex justify-center p-4">
                <Spinner size="sm" />
              </div>
            )}
            {!notes.isLoading && !notes.error && !visibleNotes.length && (
              <p className="p-10 text-center text-sm text-neutral-400">
                {!current
                  ? '当前范围暂无笔记。'
                  : search
                    ? '没有匹配的笔记。'
                    : '暂无笔记，请更新笔记列表后选择图文保存。'}
              </p>
            )}
          </div>
        </div>
      </section>
      <XhsBatchSubscription
        open={batchOpen}
        onClose={() => setBatchOpen(false)}
        api={subscriptionApi as typeof subscriptionApi & BatchApi}
        groups={groups.data?.items || []}
        budget={
          batchOpen ? (
            <XhsSourceBudget
              api={sourceBudgetApi}
              scope={{ purpose: 'resolution' }}
            />
          ) : null
        }
        onSubscribed={() => {
          void utils.xiaohongshu.list.invalidate();
        }}
      />
      <SubscriptionDialog
        isOpen={exportOpen}
        onClose={() => {
          if (!active.current) setExportOpen(false);
        }}
      >
        <ModalContent>
          <ModalHeader>导出已保存笔记</ModalHeader>
          <ModalBody>
            <p aria-label="导出对象" className="text-sm">
              范围：
              {current?.displayName ||
                (folderFilter === 'all' ? '全部笔记' : '当前分组')}
            </p>
            <ContentExportScope
              name="xhs-export-scope"
              value={exportScope}
              options={[
                {
                  value: 'selected',
                  label: `选中笔记（${selectedArchives.length} 篇完整归档）`,
                  disabled: !selectedArchives.length,
                },
                {
                  value: 'filtered',
                  label: '当前筛选（含尚未加载的笔记）',
                  disabled: !!dateError,
                },
                {
                  value: 'all',
                  label: current
                    ? '本博主全部（忽略搜索及日期）'
                    : '全部笔记（忽略搜索、日期及分组）',
                },
              ]}
              onChange={setExportScope}
              disabled={busy}
            />
            <p className="text-xs text-neutral-500">
              只导出已完整保存的正文与媒体；视频归档可一起导出。超过 100
              篇自动分批生成 ZIP，开始后范围固定。
            </p>
            <p role="status">
              范围内完整归档：{exportPreviewCount ?? '读取中'} 篇。
            </p>
            {exportScope === 'all' && allArchiveNotes.error && (
              <p role="alert">范围读取失败，请关闭后重新打开。</p>
            )}
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={() => setExportOpen(false)}>
              取消
            </Button>
            <Button
              color="primary"
              isDisabled={
                busy ||
                !exportPreviewCount ||
                (exportScope === 'filtered' && !!dateError)
              }
              onPress={handleDownload}
            >
              开始导出
            </Button>
          </ModalFooter>
        </ModalContent>
      </SubscriptionDialog>
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
            {adding && (
              <XhsSourceBudget
                key="resolution-budget"
                api={sourceBudgetApi}
                scope={{ purpose: 'resolution' }}
              />
            )}
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
    </main>
  );
}
