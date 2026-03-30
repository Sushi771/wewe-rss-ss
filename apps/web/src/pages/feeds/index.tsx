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
} from '@nextui-org/react';
import { trpc } from '@web/utils/trpc';
import { useMemo, useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import dayjs from 'dayjs';
import { serverOriginUrl } from '@web/utils/env';
import ArticleList from './list';

const Feeds = () => {
  const { id } = useParams();

  const { isOpen, onOpen, onOpenChange, onClose } = useDisclosure();
  const { refetch: refetchFeedList, data: feedData } = trpc.feed.list.useQuery(
    {},
    {
      refetchOnWindowFocus: true,
    },
  );

  const navigate = useNavigate();

  const queryUtils = trpc.useUtils();

  const { mutateAsync: getMpInfo, isLoading: isGetMpInfoLoading } =
    trpc.platform.getMpInfo.useMutation({});
  const { mutateAsync: updateMpInfo } = trpc.feed.edit.useMutation({});

  const { mutateAsync: addFeed, isLoading: isAddFeedLoading } =
    trpc.feed.add.useMutation({});
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
  const [isManageMode, setIsManageMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [draggedItem, setDraggedItem] = useState<number | null>(null);
  const [orderedFeeds, setOrderedFeeds] = useState(feedData?.items || []);

  const [refreshedMpIds, setRefreshedMpIds] = useState<string[]>([]);
  const [isRefreshedAll, setIsRefreshedAll] = useState(false);

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
    setDraggedItem(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', index.toString());
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

  const handleConfirm = async () => {
    console.log('wxsLink', wxsLink);
    // TODO show operation in progress
    const wxsLinks = wxsLink.split('\n').filter((link) => link.trim() !== '');
    for (const link of wxsLinks) {
      console.log('add wxsLink', link);
      const res = await getMpInfo({ wxsLink: link });
      if (res[0]) {
        const item = res[0];
        await addFeed({
          id: item.id,
          mpName: item.name,
          mpCover: item.cover,
          mpIntro: item.intro,
          updateTime: item.updateTime,
          status: 1,
        });
        await refreshMpArticles({ mpId: item.id });
        toast.success('添加成功', {
          description: `公众号 ${item.name}`,
        });
        await queryUtils.article.list.reset();
      } else {
        toast.error('添加失败', { description: '请检查链接是否正确' });
      }
    }
    refetchFeedList();
    setWxsLink('');
    onClose();
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
      <div className="flex h-full">
        <div className="mac-sidebar">
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
                  onPress={() => {
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
                  onPress={onOpen}
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
                isSelected={selectedIds.length === feedData?.items?.length}
                onChange={() => {
                  if (selectedIds.length === feedData?.items?.length) {
                    setSelectedIds([]);
                  } else {
                    setSelectedIds(feedData?.items?.map((i) => i.id) || []);
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
                isDisabled={selectedIds.length === 0 || isBatchDeleteLoading}
                onPress={handleBatchDelete}
                isLoading={isBatchDeleteLoading}
              >
                删除 ({selectedIds.length})
              </Button>
            </div>
          )}

          {feedData?.items ? (
            <ul className="px-0 pb-0 pt-1">
              <li
                className={`mac-sidebar-item ${isActive('') && !isManageMode ? 'active' : ''}`}
                onClick={() => {
                  setCurrentMpId('');
                  navigate('/feeds');
                }}
              >
                <div className="flex h-6 w-6 items-center justify-center rounded-full bg-neutral-200/50 text-neutral-500 transition-colors group-[.active]:bg-white/20 group-[.active]:text-white dark:bg-neutral-800/50 dark:text-neutral-400">
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
                    <rect x="3" y="3" width="7" height="7" />
                    <rect x="14" y="3" width="7" height="7" />
                    <rect x="14" y="14" width="7" height="7" />
                    <rect x="3" y="14" width="7" height="7" />
                  </svg>
                </div>
                全部
              </li>
            </ul>
          ) : (
            ''
          )}
          {feedData?.items ? (
            <div className="flex-1 overflow-hidden px-0">
              <ul className="flex h-[calc(100vh-148px)] w-full flex-col overflow-y-auto pb-4">
                {orderedFeeds.map((item, index) => {
                  const isSelected = selectedIds.includes(item.id);
                  return (
                    <li
                      key={item.id}
                      draggable={isManageMode}
                      onDragStart={(e) =>
                        isManageMode && handleDragStart(e, index)
                      }
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
                        if (isManageMode) {
                          toggleSelect(item.id);
                        } else {
                          setCurrentMpId(item.id);
                          navigate(`/feeds/${item.id}`);
                        }
                      }}
                    >
                      {isManageMode && (
                        <div onClick={(e) => e.stopPropagation()}>
                          <Checkbox
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
                        {item.mpName}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>
        <div className="mac-content">
          <div className="mac-toolbar">
            <div className="flex flex-1 items-center gap-2 overflow-hidden">
              <span className="truncate text-[15px] font-semibold">
                {currentMpId ? currentMpInfo?.mpName || '加载中...' : '全部'} ·{' '}
                {queryUtils.article.list.getInfiniteData({
                  limit: 20,
                  mpId: currentMpId,
                  search: undefined,
                })?.pages[0]?.items?.length || 0}
              </span>
            </div>

            <div className="flex items-center gap-2">
              {currentMpInfo ? (
                <div className="mr-4 flex items-center gap-4">
                  <div className="hidden whitespace-nowrap text-[14px] font-light text-neutral-400 lg:block">
                    最后更新:{' '}
                    {dayjs(currentMpInfo.syncTime * 1e3).format('MM-DD HH:mm')}
                  </div>

                  <Tooltip content="自动同步">
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
                          if (inProgressHistoryMp?.id === currentMpInfo.id) {
                            await getHistoryArticles({ mpId: '' });
                          } else {
                            await getHistoryArticles({
                              mpId: currentMpInfo.id,
                            });
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

              <div className="flex items-center gap-2">
                {articleSelectedIds.size > 0 && (
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

                {currentMpInfo ? (
                  <>
                    <Tooltip content="更新此公众号文章">
                      <Button
                        size="sm"
                        className="mac-btn-outline"
                        isDisabled={isGetArticlesLoading}
                        onPress={async () => {
                          const mpId = currentMpInfo.id;
                          try {
                            await refreshMpArticles({ mpId });
                            await refetchFeedList();
                            await queryUtils.article.list.reset();
                            setRefreshedMpIds((prev) => [...prev, mpId]);
                            toast.success('更新完成');
                            setTimeout(() => {
                              setRefreshedMpIds((prev) =>
                                prev.filter((id) => id !== mpId),
                              );
                            }, 3000);
                          } catch (e) {
                            toast.error('更新失败');
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
                              ? '完成'
                              : '更新'}
                        </span>
                      </Button>
                    </Tooltip>

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
                      isDisabled={
                        isRefreshAllMpArticlesRunning || isGetArticlesLoading
                      }
                      onPress={async () => {
                        try {
                          await refreshMpArticles({});
                          await refetchFeedList();
                          await queryUtils.article.list.reset();
                          setIsRefreshedAll(true);
                          toast.success('全部更新完成');
                          setTimeout(() => setIsRefreshedAll(false), 3000);
                        } catch (e) {
                          toast.error('更新失败');
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
                            ? '完成'
                            : '更新全部'}
                      </span>
                    </Button>

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
              </div>
            </div>
          </div>
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
          <div className="flex-1 overflow-auto">
            <ArticleList
              search={search}
              selectedIds={articleSelectedIds}
              onSelectionChange={setArticleSelectedIds}
            />
          </div>
        </div>
      </div>
      <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader className="flex flex-col gap-1">
                添加公众号源
              </ModalHeader>
              <ModalBody>
                <Textarea
                  value={wxsLink}
                  onValueChange={setWxsLink}
                  autoFocus
                  label="分享链接"
                  placeholder="输入公众号文章分享链接，一行一条，如 https://mp.weixin.qq.com/s/xxxxxx https://mp.weixin.qq.com/s/xxxxxx"
                  variant="bordered"
                />
              </ModalBody>
              <ModalFooter>
                <Button color="danger" variant="flat" onPress={onClose}>
                  取消
                </Button>
                <Button
                  color="primary"
                  isDisabled={
                    !wxsLink.startsWith('https://mp.weixin.qq.com/s/')
                  }
                  onPress={handleConfirm}
                  isLoading={
                    isAddFeedLoading ||
                    isGetMpInfoLoading ||
                    isGetArticlesLoading
                  }
                >
                  确定
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
