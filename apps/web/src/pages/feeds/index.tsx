import {
  Avatar,
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Switch,
  Textarea,
  Tooltip,
  useDisclosure,
  Checkbox,
  Input,
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@nextui-org/react';
import { trpc } from '@web/utils/trpc';
import { refreshFeedViews } from '@web/utils/refresh-feed-view';
import { useMemo, useState, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import dayjs from 'dayjs';
import {
  acceptanceMode,
  privateOnlineMode,
  serverOriginUrl,
} from '@web/utils/env';
import ArticleList from './list';
import ManagementFolders from '@web/components/ManagementFolders';
import LocalCollection from './collection';
import PublicAlbums from './public-albums';
import SubscriptionTasks from './subscription-tasks';

const Feeds = () => {
  const { id } = useParams();

  const { isOpen, onOpen, onClose } = useDisclosure();
  const folders = trpc.feed.groups.useQuery(undefined, { retry: false });
  const saveFolder = trpc.feed.saveGroup.useMutation();
  const removeFolder = trpc.feed.removeGroup.useMutation();
  const moveFeeds = trpc.feed.moveFeeds.useMutation();
  const [folderFilter, setFolderFilter] = useState('all');
  const [folderBusy, setFolderBusy] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const folderOperation = useRef(false);
  const movedIntoFolder = useRef(false);
  const { refetch: refetchFeedList, data: feedData } = trpc.feed.list.useQuery(
    {},
    {
      refetchOnWindowFocus: true,
    },
  );

  const navigate = useNavigate();

  const queryUtils = trpc.useUtils();

  const { mutateAsync: addSubscriptionBatch, isLoading: isGetMpInfoLoading } =
    trpc.feed.addSubscriptionBatch.useMutation({ retry: false });
  const { mutateAsync: repairNativeSource } =
    trpc.feed.repairNativeSource.useMutation({});
  const [repairTarget, setRepairTarget] = useState<{
    id: string;
    mpName: string;
  } | null>(null);
  const [repairMessages, setRepairMessages] = useState<string[]>([]);
  const { mutateAsync: updateMpInfo } = trpc.feed.edit.useMutation({});

  const [isAddingSubscriptions, setIsAddingSubscriptions] = useState(false);
  const isAddFeedLoading = isGetMpInfoLoading || isAddingSubscriptions;
  const addSourceSelection = 'wechat2rss' as const;
  const { data: defaultAddCapability, error: addCapabilityError } =
    trpc.feed.addCapability.useQuery(undefined, {
      refetchOnWindowFocus: false,
      retry: false,
    });
  const selectedAddSource = defaultAddCapability?.sources.find(
    (source) => source.source === addSourceSelection,
  );
  const addCapability =
    !addCapabilityError && selectedAddSource
      ? {
          ...selectedAddSource,
          existingRepairAvailable:
            defaultAddCapability?.existingRepairAvailable,
        }
      : undefined;
  const [addAccountId, setAddAccountId] = useState('');
  const [addMessages, setAddMessages] = useState<string[]>([]);
  const addingSubscriptions = useRef(false);
  const cancelSubscriptions = useRef(false);
  useEffect(
    () => () => {
      // 离开本页后不继续发送旧批次，已发出的请求仍由服务端完成。
      cancelSubscriptions.current = true;
    },
    [],
  );
  const { data: addAccounts, error: addAccountsError } =
    trpc.account.list.useQuery(
      {},
      {
        enabled:
          (isOpen && !!addCapability?.requiresAccount) ||
          (!!repairTarget && !!defaultAddCapability?.existingRepairAvailable),
        retry: false,
        refetchOnWindowFocus: false,
      },
    );
  const { mutateAsync: refreshMpArticles, isLoading: isGetArticlesLoading } =
    trpc.feed.refreshArticles.useMutation();
  const {
    mutateAsync: getHistoryArticles,
    isLoading: isGetHistoryArticlesLoading,
  } = trpc.feed.getHistoryArticles.useMutation();

  const { data: inProgressHistoryMp, refetch: refetchInProgressHistoryMp } =
    trpc.feed.getInProgressHistoryMp.useQuery(undefined, {
      refetchOnWindowFocus: true,
      refetchInterval: 10 * 1e3,
      refetchOnMount: true,
      refetchOnReconnect: true,
    });

  const { data: isRefreshAllMpArticlesRunning } =
    trpc.feed.isRefreshAllMpArticlesRunning.useQuery();

  const { mutateAsync: deleteFeed, isLoading: isDeleteFeedLoading } =
    trpc.feed.delete.useMutation({});

  const [wxsLink, setWxsLink] = useState('');
  const handleOpenAdd = () => {
    if (!addingSubscriptions.current && !repairTarget) onOpen();
  };
  const handleOpenRepair = (feed: { id: string; mpName: string }) => {
    if (addingSubscriptions.current || isOpen) return;
    setRepairMessages([]);
    setRepairTarget({ id: feed.id, mpName: feed.mpName });
  };
  const handleCancelRepair = () => {
    if (addingSubscriptions.current) {
      cancelSubscriptions.current = true;
      toast.warning('已关闭修复窗口；已发送的请求无法撤回，不会自动重试。');
    }
    setRepairTarget(null);
  };
  const handleRepairConfirm = async () => {
    if (addingSubscriptions.current || !repairTarget) return;
    if (!defaultAddCapability?.existingRepairAvailable) {
      toast.error('当前来源修复不可用，未发目录请求。');
      return;
    }
    if (!addAccountId) {
      toast.error('请先选择正常Web登录账号');
      return;
    }
    const target = repairTarget;
    addingSubscriptions.current = true;
    cancelSubscriptions.current = false;
    setIsAddingSubscriptions(true);
    setRepairMessages([]);
    try {
      const result = await repairNativeSource({
        feedId: target.id,
        accountId: addAccountId,
        confirmed: true,
      });
      await refreshFeedViews(
        refetchFeedList,
        () => queryUtils.article.list.reset(),
        () => queryUtils.article.summary.invalidate(),
      );
      if (cancelSubscriptions.current) return;
      const details = [
        result.message,
        result.httpStatus === undefined ? '' : `HTTP ${result.httpStatus}`,
        result.businessCode === undefined
          ? ''
          : `业务码 ${result.businessCode}`,
      ]
        .filter(Boolean)
        .join('；');
      setRepairMessages([details]);
      if (result.accepted && !result.pending && result.feed?.id === target.id) {
        toast.success('本号来源已修复', { description: details });
        setRepairTarget(null);
      } else toast.warning('本号来源修复未完成', { description: details });
    } catch (error) {
      if (!cancelSubscriptions.current) {
        const message =
          error instanceof Error
            ? error.message
            : '来源修复未完成，旧数据保留。';
        setRepairMessages([message]);
        toast.error('来源修复未完成', { description: message });
      }
    } finally {
      addingSubscriptions.current = false;
      setIsAddingSubscriptions(false);
    }
  };
  const handleCancelAdd = () => {
    cancelSubscriptions.current = true;
    onClose();
  };
  const [isManageMode, setIsManageMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [draggedItem, setDraggedItem] = useState<number | null>(null);
  const [orderedFeeds, setOrderedFeeds] = useState(feedData?.items || []);

  const [refreshedMpIds, setRefreshedMpIds] = useState<string[]>([]);
  const [isRefreshedAll, setIsRefreshedAll] = useState(false);
  const [isCollectingAlbums, setIsCollectingAlbums] = useState(false);
  const [updateStates, setUpdateStates] = useState<
    Record<
      string,
      { source: string; message: string; time: number; status?: string }
    >
  >({});

  const rememberUpdate = (
    mpId: string,
    source: string,
    message: string,
    status?: string,
  ) => {
    setUpdateStates((previous) => ({
      ...previous,
      [mpId]: { source, message, time: Date.now(), status },
    }));
  };

  const { mutateAsync: updateOrder } = trpc.feed.updateOrder.useMutation();

  const [search, setSearch] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [articleSelectedIds, setArticleSelectedIds] = useState<Set<string>>(
    new Set(),
  );
  const [isBatchExporting, setIsBatchExporting] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isSearchOpen) {
        setIsSearchOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSearchOpen]);

  const handleBatchExport = async () => {
    if (articleSelectedIds.size === 0) return;
    setIsBatchExporting(true);
    const ids = Array.from(articleSelectedIds);
    let successCount = 0;
    try {
      for (const articleId of ids) {
        await queryUtils.client.article.saveToObsidian.mutate(articleId);
        successCount++;
      }
      toast.success(`成功导出 ${successCount} 篇文章`);
      setArticleSelectedIds(new Set());
    } catch (err: unknown) {
      toast.error(`导出中断 (${successCount}/${ids.length} 成功)`, {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsBatchExporting(false);
    }
  };

  useEffect(() => {
    if (feedData?.items) {
      setOrderedFeeds(feedData.items);
    }
  }, [feedData?.items]);

  const handleDragStart = (e: React.DragEvent, index: number) => {
    if (folderOperation.current) {
      e.preventDefault();
      return;
    }
    movedIntoFolder.current = false;
    setDraggedItem(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', index.toString());
    e.dataTransfer.setData('application/x-wewe-wechat', orderedFeeds[index].id);
  };

  const handleDragEnter = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (draggedItem === null || draggedItem === index) return;
    const newItems = [...orderedFeeds];
    const draggedContent = newItems[draggedItem];
    newItems.splice(draggedItem, 1);
    newItems.splice(index, 0, draggedContent);
    setDraggedItem(index);
    setOrderedFeeds(newItems);
  };

  const handleDragEnd = async () => {
    setDraggedItem(null);
    if (movedIntoFolder.current || folderOperation.current) {
      movedIntoFolder.current = false;
      return;
    }
    try {
      await updateOrder(
        orderedFeeds.map((item, idx) => ({ id: item.id, order: idx })),
      );
      refetchFeedList();
      toast.success('排序已保存');
    } catch (e) {
      toast.error('排序保存失败');
    }
  };

  const [currentMpId, setCurrentMpId] = useState(id || '');

  useEffect(() => {
    setCurrentMpId(id || '');
  }, [id]);

  const refreshSavedSubscriptions = async (reveal: boolean) => {
    await queryUtils.feed.list.cancel();
    const [snapshot] = await Promise.all([
      refetchFeedList({ throwOnError: true }),
      queryUtils.article.list.reset(),
      queryUtils.article.summary.invalidate(),
    ]);
    if (snapshot?.data?.items) setOrderedFeeds(snapshot.data.items);
    if (reveal)
      setFolderFilter((current) =>
        current === folderFilter ? 'all' : current,
      );
  };

  const handleConfirm = async () => {
    if (addingSubscriptions.current) return;
    if (!addCapability?.available) {
      toast.error('暂不能新增订阅', {
        description: addCapabilityError
          ? '暂时无法检查订阅服务，请稍后刷新页面；链接已保留。'
          : 'Wechat2RSS 暂不可用，请先检查实例配置与账号登录；链接已保留。',
      });
      return;
    }
    const wxsLinks = [
      ...new Set(
        wxsLink
          .split('\n')
          .map((link) => link.trim())
          .filter(Boolean),
      ),
    ];
    if (
      !wxsLinks.length ||
      wxsLinks.some(
        (link) =>
          !/^https:\/\/mp\.weixin\.qq\.com\/s(?:\/[^?#\s]+|\?[^\s]+)(?:[?#][^\s]*)?$/.test(
            link,
          ),
      )
    ) {
      toast.error('请输入公众号文章链接，一行一条；输入已保留');
      return;
    }
    if (wxsLinks.length > 20) {
      toast.error('每次最多提交20条链接；输入链接已保留');
      return;
    }
    addingSubscriptions.current = true;
    cancelSubscriptions.current = false;
    setIsAddingSubscriptions(true);
    setAddMessages([]);
    try {
      // Persist the complete input once; the server owns serial execution.
      const batch = await addSubscriptionBatch({ articleUrls: wxsLinks });
      setWxsLink((current) => (current === wxsLink ? '' : current));
      setAddMessages([
        `已保存 ${batch.items.length} 条链接，后台将依次处理。关闭窗口后仍会继续。`,
      ]);
      try {
        await queryUtils.feed.subscriptionBatches.invalidate();
      } catch {
        setAddMessages((previous) => [
          ...previous,
          '进度暂未显示，请重新读取进度，不要重复提交。',
        ]);
      }
    } catch {
      setAddMessages([
        '提交结果暂未确认，链接已保留。请先查看添加进度，不要重复提交。',
      ]);
      try {
        await queryUtils.feed.subscriptionBatches.invalidate();
      } catch {
        /* A read failure must never replay the submitted batch. */
      }
      if (!cancelSubscriptions.current)
        toast.warning('请先核对添加进度，避免重复提交');
    } finally {
      addingSubscriptions.current = false;
      setIsAddingSubscriptions(false);
    }
  };

  const { mutateAsync: batchDeleteFeeds, isLoading: isBatchDeleteLoading } =
    trpc.feed.batchDelete.useMutation({});

  const handleBatchDelete = async () => {
    if (selectedIds.length === 0) return;

    if (window.confirm(`确定删除选中的 ${selectedIds.length} 个订阅源吗？`)) {
      await batchDeleteFeeds(selectedIds);
      toast.success(`成功删除 ${selectedIds.length} 个订阅源`);
      setSelectedIds([]);
      setIsManageMode(false);
      refetchFeedList();
      if (selectedIds.includes(currentMpId)) {
        navigate('/dash/feeds');
      }
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id],
    );
  };

  const isActive = (key: string) => {
    return currentMpId === key;
  };

  const currentMpInfo = useMemo(() => {
    return feedData?.items.find((item) => item.id === currentMpId);
  }, [currentMpId, feedData?.items]);
  const {
    data: searchCandidates,
    error: searchCandidatesError,
    isFetching: isReadingSearchCandidates,
    refetch: refetchSearchCandidates,
  } = trpc.feed.searchCandidates.useQuery(
    { mpId: currentMpId },
    {
      enabled: Boolean(currentMpInfo) && /^MP_WXS_\d{5,15}$/.test(currentMpId),
      refetchOnWindowFocus: false,
      retry: false,
    },
  );
  const {
    mutateAsync: scanCandidates,
    isLoading: isScanningCandidates,
    data: candidateScanResult,
    error: candidateScanError,
  } = trpc.feed.scanCandidates.useMutation();
  const persistedUpdate = useMemo(() => {
    try {
      const result = JSON.parse(currentMpInfo?.lastCollectionResult || 'null');
      if (
        !result ||
        typeof result.source !== 'string' ||
        typeof result.message !== 'string' ||
        !Number.isFinite(result.attemptedAt)
      )
        return undefined;
      return {
        source: result.source,
        message: result.message,
        time: result.attemptedAt * 1000,
        status: typeof result.status === 'string' ? result.status : undefined,
      };
    } catch {
      return undefined;
    }
  }, [currentMpInfo?.lastCollectionResult]);
  const liveUpdate = updateStates[currentMpId];
  const currentUpdate = acceptanceMode
    ? liveUpdate
    : persistedUpdate && (!liveUpdate || persistedUpdate.time > liveUpdate.time)
      ? persistedUpdate
      : liveUpdate || persistedUpdate;
  const updateFailed =
    currentUpdate?.source === 'error' ||
    currentUpdate?.source === 'unavailable' ||
    currentUpdate?.status === 'failed' ||
    currentUpdate?.status === 'blocked';
  const currentAlbumIds = useMemo<string[]>(() => {
    try {
      const ids: unknown = JSON.parse(currentMpInfo?.publicAlbumIds || '[]');
      return Array.isArray(ids)
        ? ids.filter((item): item is string => typeof item === 'string')
        : [];
    } catch {
      return [];
    }
  }, [currentMpInfo?.publicAlbumIds]);
  const collectionRoute = currentMpInfo?.collectionRoute;
  const collectionChannel = collectionRoute?.channel;
  const collectionChannelLabel = acceptanceMode
    ? '号名搜索更新尚未接通（隔离试用）'
    : collectionChannel
      ? {
          wechat2rss: 'Wechat2RSS 私有实例',
          'public-album': '所选官方合集订阅',
          'owner-web-search': '腾讯号名搜索',
          'owner-weread-latest': '腾讯读书订阅更新',
          unavailable: '暂无可用通道',
        }[collectionChannel]
      : '等待获取通道状态';
  const collectionSelectionLabel = acceptanceMode
    ? '未启用生产来源'
    : collectionRoute
      ? {
          saved: '已保存',
          environment: '旧环境配置',
          legacy: '兼容旧配置',
          invalid: '配置无效',
        }[collectionRoute.selectedBy]
      : '';
  const collectionDescription = acceptanceMode
    ? '自主发现26条；已核验原文缓存2篇，近期待核验3篇。普通更新未发请求；正文来源受限，已有缓存和下载可检查。搜索覆盖不保证完整。'
    : collectionChannel === 'owner-weread-latest'
      ? '更新与定时任务使用本号已绑定的腾讯读书通道：已连接目录模式按最近10篇更新正文和图片，旧当前篇模式读取一篇。实际返回数量和完成情况以最近操作结果为准，不保证全部历史或最新文章齐全；遇限制即停止并保留旧正文。'
      : collectionChannel === 'owner-web-search'
        ? '更新和定时任务直接请求腾讯搜索与原文，保存取得的正文。搜索可能漏文；认证、验证或频控限制会停止请求并显示原因。'
        : collectionChannel === 'wechat2rss'
          ? '“更新”只读取私有实例当前缓存并保存本地，不提交上游采集任务。缓存及订阅前历史不保证完整；正文和图片以实际保存结果为准。'
          : collectionChannel === 'public-album'
            ? `“更新”在线刷新已绑定的 ${currentAlbumIds.length} 个官方合集，核验原文并本地缓存正文图片；覆盖这些合集，不代表公众号全部历史。该通道不提供阅读、点赞或收藏。`
            : collectionChannel === 'unavailable'
              ? collectionRoute?.selectedBy === 'invalid'
                ? '采集通道配置无效；“更新”和定时任务会记录阻塞。可在专用采集成功后重新保存通道。已有数据和导出仍可使用。'
                : '尚无可用的内置列表通道；“更新”和定时任务会记录阻塞，不读取旧本地目录。已有数据和导出仍可使用。'
              : '正在获取后续更新使用的通道。';

  const readingStatus =
    currentMpInfo?.status === 0
      ? '已停用'
      : updateFailed
        ? '更新未完成，已有内容保留'
        : collectionChannel === 'unavailable'
          ? '更新来源未就绪'
          : currentUpdate?.status === 'partial'
            ? '部分内容已保存'
            : currentUpdate
              ? '已读取当前内容'
              : '阅读本地存量';

  const handleExportOpml = async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (!feedData?.items?.length) {
      console.warn('没有订阅源');
      return;
    }

    let opmlContent = `<?xml version="1.0" encoding="UTF-8"?>
    <opml version="2.0">
      <head>
        <title>WeWeRSS 所有订阅源</title>
      </head>
      <body>
    `;

    feedData?.items.forEach((sub) => {
      opmlContent += `    <outline text="${sub.mpName}" type="rss" xmlUrl="${window.location.origin}/feeds/${sub.id}.atom" htmlUrl="${window.location.origin}/feeds/${sub.id}.atom"/>\n`;
    });

    opmlContent += `    </body>
    </opml>`;

    const blob = new Blob([opmlContent], { type: 'text/xml;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'WeWeRSS-All.opml';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <>
      <div className="feed-workspace">
        <div className="flex shrink-0 items-center gap-2 border-b border-neutral-200 px-3 py-2 md:hidden dark:border-neutral-700">
          <label className="min-w-0 flex-1 text-xs text-neutral-500">
            当前公众号
            <select
              aria-label="手机选择公众号"
              className="bg-background mt-1 w-full min-w-0 rounded border p-2 text-sm"
              value={currentMpId}
              disabled={folderBusy}
              onChange={(event) => {
                if (folderOperation.current) return;
                const selected = event.target.value;
                setCurrentMpId(selected);
                navigate(selected ? `/feeds/${selected}` : '/feeds');
                setMobileSidebarOpen(false);
              }}
            >
              <option value="">全部文章</option>
              {feedData?.items.map((feed) => (
                <option key={feed.id} value={feed.id}>
                  {feed.mpName || '公众号信息待补全'}
                </option>
              ))}
            </select>
          </label>
          <Button
            size="sm"
            variant="flat"
            isDisabled={folderBusy}
            aria-expanded={mobileSidebarOpen}
            aria-controls="wechat-management-sidebar"
            onPress={() => {
              if (!folderOperation.current)
                setMobileSidebarOpen(!mobileSidebarOpen);
            }}
          >
            {mobileSidebarOpen ? '收起管理' : '管理公众号'}
          </Button>
        </div>
        <div
          id="wechat-management-sidebar"
          role="region"
          aria-label="订阅源与分组"
          tabIndex={0}
          className={`mac-sidebar feed-sidebar ${mobileSidebarOpen ? 'feed-sidebar-open' : ''}`}
        >
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-[13px] font-bold uppercase tracking-widest text-neutral-400/80">
              订阅源 · {feedData?.items?.length || 0}
            </span>
            <div className="flex items-center gap-0.5">
              <Tooltip content={isManageMode ? '退出管理' : '管理订阅源'}>
                <Button
                  isIconOnly
                  size="sm"
                  variant="light"
                  color={isManageMode ? 'primary' : 'default'}
                  isDisabled={folderBusy}
                  onPress={() => {
                    if (folderOperation.current) return;
                    setIsManageMode(!isManageMode);
                    setSelectedIds([]);
                  }}
                  className="h-7 w-7 min-w-0"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                </Button>
              </Tooltip>
              <Tooltip content="添加订阅源">
                <Button
                  isIconOnly
                  size="sm"
                  variant="light"
                  onPress={handleOpenAdd}
                  isDisabled={isAddFeedLoading || folderBusy}
                  className="h-7 w-7 min-w-0"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ color: '#666' }}
                  >
                    <line x1="12" y1="5" x2="12" y2="19"></line>
                    <line x1="5" y1="12" x2="19" y2="12"></line>
                  </svg>
                </Button>
              </Tooltip>
            </div>
          </div>
          {isManageMode && (feedData?.items?.length || 0) > 0 && (
            <div className="flex items-center justify-between px-4 pb-2">
              <Checkbox
                isDisabled={folderBusy}
                isSelected={
                  selectedIds.length > 0 &&
                  selectedIds.length ===
                    orderedFeeds.filter(
                      (item) =>
                        folderFilter === 'all' ||
                        (folderFilter === 'ungrouped'
                          ? !item.groupId
                          : item.groupId === folderFilter),
                    ).length
                }
                onChange={() => {
                  if (folderOperation.current) return;
                  const visible = orderedFeeds.filter(
                    (item) =>
                      folderFilter === 'all' ||
                      (folderFilter === 'ungrouped'
                        ? !item.groupId
                        : item.groupId === folderFilter),
                  );
                  if (selectedIds.length === visible.length) {
                    setSelectedIds([]);
                  } else {
                    setSelectedIds(visible.map((item) => item.id));
                  }
                }}
                size="sm"
              >
                全选
              </Checkbox>
              <Button
                color="danger"
                size="sm"
                variant="flat"
                isDisabled={
                  selectedIds.length === 0 || isBatchDeleteLoading || folderBusy
                }
                onPress={handleBatchDelete}
                isLoading={isBatchDeleteLoading}
              >
                删除 ({selectedIds.length})
              </Button>
            </div>
          )}

          <ManagementFolders
            folders={folders.data?.items || []}
            filter={folderFilter}
            selectedIds={isManageMode ? selectedIds : []}
            dragType="application/x-wewe-wechat"
            disabled={
              folderBusy ||
              isBatchDeleteLoading ||
              isAddFeedLoading ||
              !folders.data
            }
            onFilter={(filter) => {
              if (folderOperation.current) return;
              setFolderFilter(filter);
              setSelectedIds([]);
              if (filter === 'all') {
                setCurrentMpId('');
                navigate('/feeds');
                setMobileSidebarOpen(false);
              }
            }}
            onBusyChange={(value) => {
              folderOperation.current = value;
              setFolderBusy(value);
            }}
            onSave={async (input) => {
              await saveFolder.mutateAsync(input);
              await folders.refetch();
            }}
            onRemove={async (id) => {
              await removeFolder.mutateAsync({ id });
              if (folderFilter === id) setFolderFilter('all');
              await folders.refetch();
            }}
            onMove={async (ids, groupId) => {
              movedIntoFolder.current = true;
              setDraggedItem(null);
              await moveFeeds.mutateAsync({ ids, groupId });
              setSelectedIds([]);
              await refetchFeedList();
            }}
          />
          {folders.error && (
            <p role="alert" className="px-4 text-xs text-red-600">
              文件夹读取失败，请重新读取页面。
            </p>
          )}

          {feedData?.items ? (
            <div className="px-0">
              <ul className="flex w-full flex-col pb-4">
                {orderedFeeds
                  .filter(
                    (item) =>
                      folderFilter === 'all' ||
                      (folderFilter === 'ungrouped'
                        ? !item.groupId
                        : item.groupId === folderFilter),
                  )
                  .map((item) => {
                    const index = orderedFeeds.findIndex(
                      (feed) => feed.id === item.id,
                    );
                    const isSelected = selectedIds.includes(item.id);
                    return (
                      <li
                        key={item.id}
                        draggable={!folderBusy}
                        onDragStart={(e) => {
                          if (folderOperation.current) {
                            e.preventDefault();
                            return;
                          }
                          movedIntoFolder.current = false;
                          e.dataTransfer.setData(
                            'application/x-wewe-wechat',
                            item.id,
                          );
                          e.dataTransfer.effectAllowed = 'move';
                          if (isManageMode) handleDragStart(e, index);
                        }}
                        onDragEnter={(e) =>
                          isManageMode && handleDragEnter(e, index)
                        }
                        onDragEnd={isManageMode ? handleDragEnd : undefined}
                        onDragOver={(e) => e.preventDefault()}
                        className={`mac-sidebar-item ${
                          isActive(item.id) && !isManageMode
                            ? 'active'
                            : isSelected && isManageMode
                              ? 'selected-manage'
                              : ''
                        } ${isManageMode ? 'drag-handle' : ''}`}
                        onClick={() => {
                          if (folderOperation.current) return;
                          if (isManageMode) {
                            toggleSelect(item.id);
                          } else {
                            setCurrentMpId(item.id);
                            navigate(`/feeds/${item.id}`);
                            setMobileSidebarOpen(false);
                          }
                        }}
                      >
                        {isManageMode && (
                          <div onClick={(e) => e.stopPropagation()}>
                            <Checkbox
                              isDisabled={folderBusy}
                              isSelected={isSelected}
                              onValueChange={() => toggleSelect(item.id)}
                            />
                          </div>
                        )}
                        <Avatar
                          src={item.mpCover}
                          className="sidebar-avatar h-6 min-h-6 w-6 min-w-6"
                        ></Avatar>
                        <span className="flex-1 truncate text-sm">
                          {item.mpName || '公众号信息待补全'}
                        </span>
                      </li>
                    );
                  })}
              </ul>
            </div>
          ) : null}
        </div>
        <div className="mac-content feed-content !min-w-0 !overflow-y-auto">
          {!isOpen && (
            <SubscriptionTasks
              feeds={feedData?.items || []}
              adding={isAddingSubscriptions}
              onSaved={refreshSavedSubscriptions}
            />
          )}
          {isAddingSubscriptions && (
            <section
              aria-label="添加订阅进度"
              className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-2 text-sm"
            >
              <p role="status" aria-live="polite">
                {isAddingSubscriptions
                  ? '正在处理添加请求，完成后会自动更新列表。'
                  : addMessages[addMessages.length - 1]}
              </p>
              <Button
                size="sm"
                variant="light"
                onPress={handleOpenAdd}
                isDisabled={isAddFeedLoading}
              >
                查看添加结果
              </Button>
            </section>
          )}
          <div className="mac-toolbar feed-reading-toolbar !h-auto shrink-0 !flex-wrap !gap-2 !px-3 !py-2">
            <div className="flex min-w-0 basis-full flex-wrap items-center gap-x-3 gap-y-1 sm:flex-1 sm:basis-0">
              <span className="min-w-0 truncate text-[15px] font-semibold">
                {currentMpId
                  ? currentMpInfo
                    ? currentMpInfo.mpName || '公众号信息待补全'
                    : '加载中...'
                  : '全部'}
              </span>
              {currentMpInfo && (
                <span
                  role={updateFailed ? 'alert' : 'status'}
                  className={
                    updateFailed
                      ? 'text-xs text-red-600'
                      : 'text-xs text-neutral-500'
                  }
                >
                  {readingStatus}
                </span>
              )}
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Tooltip content={isSearchOpen ? '关闭搜索' : '搜索文章'}>
                <Button
                  isIconOnly
                  size="sm"
                  variant="light"
                  color={isSearchOpen ? 'primary' : 'default'}
                  className="h-8 w-8 min-w-0"
                  onPress={() => setIsSearchOpen(!isSearchOpen)}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="11" cy="11" r="8" />
                    <path d="m21 21-4.3-4.3" />
                  </svg>
                </Button>
              </Tooltip>
              {!privateOnlineMode && articleSelectedIds.size > 0 && (
                <Button
                  size="sm"
                  color="primary"
                  variant="flat"
                  className="mr-2 h-8 font-medium"
                  isLoading={isBatchExporting}
                  onPress={handleBatchExport}
                >
                  批量导出 Obsidian ({articleSelectedIds.size})
                </Button>
              )}
              {currentMpInfo ? (
                <>
                  <Tooltip content={collectionDescription}>
                    <Button
                      size="sm"
                      className="mac-btn-outline"
                      isDisabled={
                        isAddFeedLoading ||
                        isGetArticlesLoading ||
                        isCollectingAlbums
                      }
                      onPress={async () => {
                        const mpId = currentMpInfo.id;
                        try {
                          const results = await refreshMpArticles({ mpId });
                          await refreshFeedViews(
                            refetchFeedList,
                            () => queryUtils.article.list.reset(),
                            () => queryUtils.article.summary.invalidate(),
                          );
                          if (
                            results.length > 0 &&
                            results.every((r) => r.complete)
                          )
                            setRefreshedMpIds((prev) => [...prev, mpId]);
                          for (const result of results) {
                            rememberUpdate(
                              mpId,
                              result.source,
                              result.message,
                              result.status,
                            );
                            if (result.complete)
                              toast.success(result.message, {
                                duration: 8000,
                              });
                            else if (
                              result.status === 'failed' ||
                              result.status === 'blocked'
                            )
                              toast.error(result.message, {
                                duration: 10000,
                              });
                            else
                              toast.warning(result.message, {
                                duration: 10000,
                              });
                          }
                          setTimeout(() => {
                            setRefreshedMpIds((prev) =>
                              prev.filter((id) => id !== mpId),
                            );
                          }, 3000);
                        } catch (e) {
                          await refetchFeedList();
                          rememberUpdate(
                            mpId,
                            'error',
                            e instanceof Error ? e.message : '更新失败',
                          );
                          toast.error(
                            e instanceof Error ? e.message : '更新失败',
                          );
                        }
                      }}
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M21 2v6h-6" />
                        <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
                        <path d="M3 22v-6h6" />
                        <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
                      </svg>
                      <span className="text-[14px]">
                        {isGetArticlesLoading
                          ? '更新中'
                          : refreshedMpIds.includes(currentMpInfo.id)
                            ? '更新完成'
                            : '更新本号'}
                      </span>
                    </Button>
                  </Tooltip>
                  <a
                    href={`${serverOriginUrl}/download/feed/${currentMpInfo.id}.zip`}
                    className="mac-action-link ml-1 flex h-8 items-center px-2 text-[14px]"
                  >
                    下载本号 ZIP
                  </a>
                </>
              ) : (
                <>
                  <Button
                    size="sm"
                    className="mac-btn-outline h-8"
                    isDisabled={
                      isAddFeedLoading ||
                      isRefreshAllMpArticlesRunning ||
                      isGetArticlesLoading ||
                      isCollectingAlbums
                    }
                    onPress={async () => {
                      try {
                        const results = await refreshMpArticles({});
                        await refreshFeedViews(
                          refetchFeedList,
                          () => queryUtils.article.list.reset(),
                          () => queryUtils.article.summary.invalidate(),
                        );
                        for (const result of results) {
                          if ('id' in result && typeof result.id === 'string')
                            rememberUpdate(
                              result.id,
                              result.source,
                              result.message,
                              result.status,
                            );
                        }
                        setIsRefreshedAll(
                          results.length > 0 &&
                            results.every((r) => r.complete),
                        );
                        const complete = results.filter(
                          (r) => r.complete,
                        ).length;
                        const incomplete = results.filter((r) => !r.complete);
                        if (incomplete.length)
                          toast.warning(
                            `完整更新 ${complete} 个；${incomplete.length} 个采集受限或阻塞`,
                            {
                              description: incomplete
                                .map((r) => r.message)
                                .join('；'),
                              duration: 12000,
                            },
                          );
                        else toast.success(`完整更新 ${complete} 个公众号`);
                        setTimeout(() => setIsRefreshedAll(false), 3000);
                      } catch (e) {
                        toast.error(
                          e instanceof Error ? e.message : '更新失败',
                        );
                      }
                    }}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M21 2v6h-6" />
                      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
                      <path d="M3 22v-6h6" />
                      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
                    </svg>
                    <span className="text-[14px]">
                      {isRefreshAllMpArticlesRunning || isGetArticlesLoading
                        ? '更新中'
                        : isRefreshedAll
                          ? '更新完成'
                          : '更新全部'}
                    </span>
                  </Button>
                </>
              )}
              <Popover
                key={currentMpId}
                placement="bottom-end"
                className="feed-reading-more"
              >
                <PopoverTrigger>
                  <Button
                    size="sm"
                    variant="light"
                    className="mac-action-link min-w-0 shrink-0 px-2 text-sm"
                    aria-label="更多订阅操作"
                  >
                    更多
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="flex max-h-[60dvh] w-80 max-w-[calc(100vw-2rem)] flex-row flex-wrap items-center gap-3 overflow-auto rounded-lg border border-neutral-200 bg-white p-4 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
                  {currentMpInfo ? (
                    <div className="mr-4 flex items-center gap-4">
                      <div className="hidden whitespace-nowrap text-[14px] font-light text-neutral-400 lg:block">
                        更新通道：{collectionChannelLabel}
                      </div>

                      <Tooltip
                        content={
                          collectionChannel === 'wechat2rss'
                            ? '定时使用同一后台来源；全局定时任务仍需在服务端启用。'
                            : collectionChannel === 'public-album'
                              ? '定时在线刷新已绑定公开合集；不代表公众号全量采集'
                              : '尚无可用的后台来源；定时任务会记录阻塞状态'
                        }
                      >
                        <div className="flex items-center">
                          <Switch
                            size="sm"
                            onValueChange={async (value) => {
                              await updateMpInfo({
                                id: currentMpInfo.id,
                                data: { status: value ? 1 : 0 },
                              });
                              await refetchFeedList();
                            }}
                            isSelected={currentMpInfo?.status === 1}
                          />
                        </div>
                      </Tooltip>

                      {currentMpInfo.hasHistory === 1 && (
                        <Tooltip
                          content={
                            inProgressHistoryMp?.id === currentMpInfo.id
                              ? '停止获取'
                              : '获取历史文章'
                          }
                        >
                          <Button
                            isIconOnly
                            size="sm"
                            variant="light"
                            className="h-8 w-8 min-w-0"
                            isLoading={isGetHistoryArticlesLoading}
                            onPress={async () => {
                              if (
                                inProgressHistoryMp?.id === currentMpInfo.id
                              ) {
                                await getHistoryArticles({ mpId: '' });
                              } else {
                                try {
                                  const result = await getHistoryArticles({
                                    mpId: currentMpInfo.id,
                                  });
                                  rememberUpdate(
                                    currentMpInfo.id,
                                    result.source,
                                    result.message,
                                    result.status,
                                  );
                                  if (result.status === 'blocked')
                                    toast.error(result.message);
                                  else toast.warning(result.message);
                                } catch (error) {
                                  rememberUpdate(
                                    currentMpInfo.id,
                                    'error',
                                    error instanceof Error
                                      ? error.message
                                      : '历史采集失败',
                                  );
                                  toast.error(
                                    error instanceof Error
                                      ? error.message
                                      : '历史采集失败',
                                  );
                                } finally {
                                  await refetchFeedList();
                                  await queryUtils.article.list.reset();
                                  await queryUtils.article.summary.invalidate();
                                }
                              }
                              await refetchInProgressHistoryMp();
                            }}
                          >
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              width="16"
                              height="16"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M12 8v4l3 3" />
                              <circle cx="12" cy="12" r="10" />
                            </svg>
                          </Button>
                        </Tooltip>
                      )}

                      <Tooltip content="删除此订阅 (保留文章)">
                        <Button
                          isIconOnly
                          size="sm"
                          variant="light"
                          color="danger"
                          className="h-8 w-8 min-w-0 opacity-40 hover:opacity-100"
                          isLoading={isDeleteFeedLoading}
                          onPress={async () => {
                            if (window.confirm('确定删除吗？')) {
                              await deleteFeed(currentMpInfo.id);
                              navigate('/dash/feeds');
                              await refetchFeedList();
                            }
                          }}
                        >
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M3 6h18" />
                            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                            <line x1="10" y1="11" x2="10" y2="17" />
                            <line x1="14" y1="11" x2="14" y2="17" />
                          </svg>
                        </Button>
                      </Tooltip>
                    </div>
                  ) : null}
                  {currentMpInfo && !acceptanceMode && (
                    <Tooltip content="补采成功后，将保存公开合集为后续普通更新和定时任务使用的通道；失败保留原通道。">
                      <span className="inline-flex">
                        <PublicAlbums
                          mpId={currentMpInfo.id}
                          name={currentMpInfo.mpName}
                          albumIds={currentAlbumIds}
                          hasLocalDirectory={!!currentMpInfo.localDirectory}
                          isDisabled={
                            isGetArticlesLoading ||
                            !!isRefreshAllMpArticlesRunning ||
                            isCollectingAlbums
                          }
                          onBusyChange={setIsCollectingAlbums}
                          onResult={(source, message) =>
                            rememberUpdate(currentMpInfo.id, source, message)
                          }
                        />
                      </span>
                    </Tooltip>
                  )}
                  {!privateOnlineMode && (
                    <LocalCollection
                      showMetricsExport={
                        currentMpInfo
                          ? collectionChannel !== 'wechat2rss'
                          : !(feedData?.items || []).some(
                              (feed) =>
                                feed.collectionRoute.channel === 'wechat2rss',
                            )
                      }
                      mpId={currentMpInfo?.id}
                      directory={currentMpInfo?.localDirectory}
                      name={currentMpInfo?.mpName}
                      search={search}
                      selectedIds={articleSelectedIds}
                      onImported={(message) => {
                        if (currentMpInfo)
                          rememberUpdate(currentMpInfo.id, 'local', message);
                      }}
                    />
                  )}
                  {currentMpInfo ? (
                    <>
                      {currentMpInfo.status === 1 &&
                        (!currentMpInfo.collectionChannel ||
                          currentMpInfo.collectionChannel ===
                            'unavailable') && (
                          <Button
                            size="sm"
                            className="mac-btn-outline"
                            isDisabled={
                              isAddFeedLoading ||
                              isGetArticlesLoading ||
                              !!isRefreshAllMpArticlesRunning ||
                              isCollectingAlbums
                            }
                            onPress={() => handleOpenRepair(currentMpInfo)}
                          >
                            修复本号来源
                          </Button>
                        )}
                      <a
                        target="_blank"
                        rel="noopener noreferrer"
                        href={`${serverOriginUrl}/feeds/${currentMpInfo.id}.atom`}
                        className="mac-action-link ml-1 flex h-8 items-center px-2 text-[14px]"
                      >
                        RSS
                      </a>
                    </>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        className="mac-btn-outline h-8"
                        onPress={handleExportOpml}
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                          <polyline points="7 10 12 15 17 10" />
                          <line x1="12" y1="15" x2="12" y2="3" />
                        </svg>
                        <span className="text-[14px]">导出 OPML</span>
                      </Button>
                      <a
                        target="_blank"
                        rel="noopener noreferrer"
                        href={`${serverOriginUrl}/feeds/all.atom`}
                        className="mac-action-link ml-1 flex h-8 items-center px-2 text-[14px]"
                      >
                        RSS
                      </a>
                    </>
                  )}
                </PopoverContent>
              </Popover>
            </div>
          </div>
          {currentMpInfo && (
            <details
              key={currentMpId}
              className="feed-reading-details shrink-0 border-b border-neutral-200 text-xs dark:border-neutral-700"
            >
              <summary className="cursor-pointer px-3 py-1 text-neutral-500">
                来源与更新详情
              </summary>
              {currentMpInfo && (
                <div
                  role={updateFailed ? 'alert' : 'status'}
                  className="border-b border-neutral-200 bg-neutral-50 px-4 py-3 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                >
                  <p
                    className={
                      collectionChannel === 'public-album' ||
                      collectionChannel === 'unavailable'
                        ? 'font-medium text-orange-700 dark:text-orange-300'
                        : 'font-medium'
                    }
                  >
                    普通更新通道：{collectionChannelLabel}
                    {collectionSelectionLabel
                      ? ` · ${collectionSelectionLabel}`
                      : ''}
                  </p>
                  <p className="mt-1 text-neutral-500">
                    {collectionDescription}
                  </p>
                  {currentUpdate && (
                    <p
                      className={
                        updateFailed
                          ? 'mt-1 text-red-600'
                          : currentUpdate.source === 'public-album'
                            ? 'mt-1 text-orange-700 dark:text-orange-300'
                            : 'mt-1 text-neutral-500'
                      }
                    >
                      最近操作{' '}
                      {dayjs(currentUpdate.time).format('YYYY-MM-DD HH:mm:ss')}
                      ：{currentUpdate.message}
                    </p>
                  )}
                </div>
              )}
              {currentMpInfo && (searchCandidates || searchCandidatesError) && (
                <details
                  key={currentMpId}
                  className="border-b border-neutral-200 bg-amber-50/50 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                >
                  <summary className="cursor-pointer px-4 py-3 font-medium">
                    待核验搜索候选
                    {searchCandidates
                      ? ` · ${searchCandidates.candidates.length} 条 · 列表不完整`
                      : ' · 快照不可用'}
                  </summary>
                  <div className="px-4 pb-3">
                    {searchCandidatesError ? (
                      <p role="alert" className="text-red-600">
                        {searchCandidatesError.message}
                      </p>
                    ) : searchCandidates ? (
                      <>
                        <p className="text-neutral-600 dark:text-neutral-400">
                          搜索快照 · 采集于{' '}
                          {dayjs(searchCandidates.capturedAt).format(
                            'YYYY-MM-DD HH:mm:ss',
                          )}
                          {' · '}
                          {searchCandidates.pages} 页
                          {searchCandidates.truncated ? ' · 已截断' : ''}
                        </p>
                        <p className="mt-1 text-amber-800 dark:text-amber-300">
                          搜索索引时间不是发表时间。正文与真实发表时间待核验，本快照未作为文章入库；搜索结果不能保证本号文章齐全。
                        </p>
                        <ul className="mt-2 max-h-72 divide-y divide-neutral-200 overflow-auto dark:divide-neutral-700">
                          {searchCandidates.candidates.map((candidate) => (
                            <li key={candidate.id} className="py-2">
                              <a
                                href={candidate.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="break-words text-blue-700 hover:underline dark:text-blue-300"
                              >
                                {candidate.title}
                              </a>
                              <p className="mt-1 text-xs text-neutral-500">
                                搜索索引时间：
                                {candidate.indexTimestamp
                                  ? dayjs(
                                      candidate.indexTimestamp * 1000,
                                    ).format('YYYY-MM-DD HH:mm:ss')
                                  : '未提供'}
                                {' · '}待核验
                              </p>
                            </li>
                          ))}
                        </ul>
                        {!searchCandidates.candidates.length && (
                          <p className="mt-2 text-neutral-500">
                            快照中没有候选。
                          </p>
                        )}
                      </>
                    ) : null}
                    <Button
                      size="sm"
                      variant="light"
                      className="mt-2"
                      isLoading={isReadingSearchCandidates}
                      onPress={() => refetchSearchCandidates()}
                    >
                      重新读取快照
                    </Button>
                    <Button
                      size="sm"
                      variant="light"
                      className="ml-2 mt-2"
                      isLoading={isScanningCandidates}
                      onPress={async () => {
                        try {
                          await scanCandidates({ mpId: currentMpId });
                          await refetchSearchCandidates();
                        } catch {
                          // The protected mutation shows a safe error below.
                        }
                      }}
                    >
                      扫描新候选
                    </Button>
                    {candidateScanResult && (
                      <p className="mt-2 text-neutral-600 dark:text-neutral-400">
                        扫描完成：{candidateScanResult.candidates}{' '}
                        条候选。文章正文和发表时间仍需核验。
                      </p>
                    )}
                    {candidateScanError && (
                      <p role="alert" className="mt-2 text-red-600">
                        {candidateScanError.message}
                      </p>
                    )}
                  </div>
                </details>
              )}
            </details>
          )}
          {isSearchOpen && (
            <div className="animate-in slide-in-from-top border-b-[0.5px] border-neutral-200 bg-neutral-50/80 px-4 py-3 backdrop-blur-md duration-200 dark:border-neutral-700 dark:bg-neutral-900/80">
              <Input
                autoFocus
                placeholder="搜索标题或内容..."
                size="sm"
                variant="flat"
                value={search}
                onValueChange={setSearch}
                isClearable
                onClear={() => setSearch('')}
                classNames={{
                  inputWrapper:
                    'h-8 px-3 bg-white dark:bg-neutral-800 rounded-lg shadow-sm',
                  input: 'text-[15px]',
                }}
                startContent={
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="text-neutral-400"
                  >
                    <circle cx="11" cy="11" r="8" />
                    <path d="m21 21-4.3-4.3" />
                  </svg>
                }
              />
            </div>
          )}

          <div className="feed-article-scroll flex-1 overflow-auto">
            <ArticleList
              collectionChannels={Object.fromEntries(
                (feedData?.items || []).map((feed) => [
                  feed.id,
                  feed.collectionRoute.channel,
                ]),
              )}
              search={search}
              selectedIds={articleSelectedIds}
              onSelectionChange={setArticleSelectedIds}
            />
          </div>
        </div>
      </div>
      <Modal
        isOpen={!!repairTarget}
        onOpenChange={(open) => {
          if (!open) handleCancelRepair();
        }}
      >
        <ModalContent>
          <ModalHeader>修复已有订阅来源</ModalHeader>
          <ModalBody>
            <p>本次公众号：{repairTarget?.mpName}</p>
            <p className="text-default-600 text-sm">
              使用已有订阅身份验证目录，无需重新提供单篇原文。所选账号验证成功后更新最近10篇正文和图片，后续使用原更新本号入口；失败保留历史数据和停止记录，不自动重试或切换账号。
            </p>
            {!defaultAddCapability?.existingRepairAvailable && (
              <p role="status">
                {addCapabilityError
                  ? '来源状态读取失败，本次未发目录请求。'
                  : '正在核对来源；不可用时不能开始修复。'}
              </p>
            )}
            <label className="flex flex-col gap-2 text-sm">
              用于本号来源修复的正常Web账号
              <select
                aria-label="用于本号来源修复的正常Web账号"
                value={addAccountId}
                onChange={(event) => {
                  if (!addingSubscriptions.current)
                    setAddAccountId(event.target.value);
                }}
                disabled={isAddFeedLoading}
                className="bg-content1 rounded-md border p-2"
              >
                <option value="">请选择正常Web登录账号</option>
                {addAccounts?.items.map((account) => (
                  <option
                    key={account.id}
                    value={account.id}
                    disabled={account.status !== 1 || !account.nativeLoginAt}
                  >
                    {account.platformName || account.name}
                    {!account.nativeLoginAt ? '（需正常Web登录）' : ''}
                  </option>
                ))}
              </select>
            </label>
            {addAccountsError && (
              <p role="alert">账号列表读取失败，请在账号页核对正常登录。</p>
            )}
            {repairMessages.map((message, index) => (
              <p key={index} role="status">
                {message}
              </p>
            ))}
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={handleCancelRepair}>
              {isAddingSubscriptions ? '关闭（请求已发送）' : '取消'}
            </Button>
            <Button
              color="primary"
              isDisabled={
                isAddFeedLoading ||
                !defaultAddCapability?.existingRepairAvailable ||
                !addAccountId
              }
              isLoading={isAddingSubscriptions}
              onPress={handleRepairConfirm}
            >
              确认修复并更新最近10篇
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
      <Modal
        isOpen={isOpen}
        onOpenChange={(open) => (open ? handleOpenAdd() : handleCancelAdd())}
      >
        <ModalContent>
          {() => (
            <>
              <ModalHeader>添加公众号</ModalHeader>
              <ModalBody>
                {isOpen && (
                  <SubscriptionTasks
                    feeds={feedData?.items || []}
                    adding={isAddingSubscriptions}
                    onSaved={refreshSavedSubscriptions}
                  />
                )}
                <Textarea
                  value={wxsLink}
                  onValueChange={(value) => {
                    if (!addingSubscriptions.current) setWxsLink(value);
                  }}
                  isDisabled={isAddFeedLoading}
                  autoFocus
                  label="文章链接"
                  placeholder="https://mp.weixin.qq.com/s/…"
                  description="多个公众号请每行粘贴一个文章链接，每次最多20条。"
                  variant="bordered"
                />
                {!addCapability?.available && (
                  <p className="text-default-600 text-sm" role="status">
                    {addCapabilityError
                      ? '服务状态读取失败，请刷新页面后重试。'
                      : defaultAddCapability
                        ? 'Wechat2RSS 暂不可用，请先检查实例配置与账号登录。'
                        : '正在检查订阅服务…'}
                  </p>
                )}
                {addMessages.length > 0 && (
                  <ul
                    role="status"
                    aria-live="polite"
                    aria-label="新增订阅处理结果"
                    className="text-default-600 space-y-2 text-sm"
                  >
                    {addMessages.map((message, index) => (
                      <li key={index}>{message}</li>
                    ))}
                  </ul>
                )}
                {isAddingSubscriptions && (
                  <p className="text-default-500 text-xs" role="status">
                    正在保存添加队列。关闭窗口后仍会继续处理。
                  </p>
                )}
              </ModalBody>
              <ModalFooter>
                <Button variant="flat" onPress={handleCancelAdd}>
                  取消
                </Button>
                <Button
                  color="primary"
                  isDisabled={
                    isAddFeedLoading ||
                    !addCapability?.available ||
                    !wxsLink.trim().startsWith('https://mp.weixin.qq.com/s')
                  }
                  onPress={handleConfirm}
                  isLoading={isAddFeedLoading}
                >
                  添加订阅
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </>
  );
};

export default Feeds;
