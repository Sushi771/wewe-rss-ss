import {
  ContentLoadMore,
  ContentSortControls,
  ContentSelectionHeader,
} from '@web/components/SubscriptionPrimitives';
import { FailureNotice } from '@web/components/OperationNotice';
import { READING_CACHE_TIME } from '@web/utils/reading-query-cache';
import {
  FC,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Button,
  Spinner,
  Checkbox,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
} from '@nextui-org/react';
import { trpc } from '@web/utils/trpc';
import { ArticleSort } from '@web/utils/feed-browse-state';
import { useArticleListPosition } from '@web/utils/use-article-list-position';
import { getLoadedSelection } from '@web/utils/feed-selection';
import { articleBodyState } from '@web/utils/article-body-state';
import ArticleReader from '@web/components/ArticleReader';
import { useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArticleFilter, formatShanghaiPublicationTime } from '@wewe-rss/shared';

interface ArticleListProps {
  search: string;
  articleFilter?: ArticleFilter;
  filterInvalid?: boolean;
  sort: ArticleSort;
  onSortChange: (sort: ArticleSort) => void;
  direction: 'asc' | 'desc';
  onDirectionChange: (direction: 'asc' | 'desc') => void;
  selectedIds: Set<string>;
  onSelectionChange: (selectedIds: Set<string>) => void;
  isSelectionDisabled?: boolean;
  collectionChannels?: Record<string, string>;
}

function metricDisplay(raw: string | null, key: 'read' | 'like' | 'favorite') {
  try {
    const metric = JSON.parse(raw || '{}')[key];
    return metric?.display ?? '未获取';
  } catch {
    return '未获取';
  }
}

const ArticleList: FC<ArticleListProps> = ({
  search,
  articleFilter = {},
  filterInvalid = false,
  sort,
  onSortChange: setSort,
  direction,
  onDirectionChange,
  selectedIds,
  onSelectionChange,
  isSelectionDisabled = false,
  collectionChannels = {},
}) => {
  const { id } = useParams();

  const mpId = id || '';
  const [readingId, setReadingId] = useState<string | null>(null);
  const [readerFindOpen, setReaderFindOpen] = useState(false);
  useEffect(() => setReaderFindOpen(false), [readingId]);
  const reading = trpc.article.byId.useQuery(readingId || '', {
    enabled: Boolean(readingId),
    cacheTime: READING_CACHE_TIME,
  });
  const queryUtils = trpc.useUtils();
  const searchStatus = trpc.article.searchStatus.useQuery(undefined, {
    enabled: Boolean(search.trim()),
    retry: false,
    refetchInterval: search.trim() ? 5000 : false,
  });
  const { mutateAsync: prepareSearchBatch } =
    trpc.article.prepareSearch.useMutation();
  const [preparingSearch, setPreparingSearch] = useState(false);
  const [searchPaused, setSearchPaused] = useState(false);
  const searchActive = useRef(false);
  useEffect(
    () => () => {
      searchActive.current = false;
    },
    [],
  );
  const buildSearch = useCallback(async () => {
    if (searchActive.current) return;
    searchActive.current = true;
    setPreparingSearch(true);
    try {
      while (searchActive.current) {
        const status = await prepareSearchBatch();
        queryUtils.article.searchStatus.setData(undefined, status);
        if (!status.pending) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await Promise.all([
        queryUtils.article.list.invalidate(),
        queryUtils.article.summary.invalidate(),
      ]);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : '正文搜索整理失败，可以稍后继续',
      );
    } finally {
      searchActive.current = false;
      setPreparingSearch(false);
    }
  }, [prepareSearchBatch, queryUtils]);
  useEffect(() => {
    setSearchPaused(false);
    if (!search.trim()) searchActive.current = false;
  }, [search]);
  useEffect(() => {
    if (
      search.trim() &&
      searchStatus.data?.pending &&
      !searchPaused &&
      !searchActive.current
    )
      void buildSearch();
  }, [search, searchStatus.data?.pending, searchPaused, buildSearch]);

  const bodyRetry = trpc.article.retryBody.useMutation();
  const retryBody = async (articleId: string, title: string) => {
    try {
      const result = await bodyRetry.mutateAsync(articleId);
      if (result.status === 'available') toast.success(`${title}：正文可用`);
      else if (result.status === 'failed')
        toast.error(`${title}：正文重试失败`);
      else toast.warning(`${title}：正文暂不可用`);
    } catch {
      toast.error('正文重试失败，请稍后重试。');
    } finally {
      await Promise.all([
        queryUtils.article.list.invalidate(),
        queryUtils.article.summary.invalidate(),
        queryUtils.article.byId.invalidate(articleId),
      ]);
    }
  };
  const summary = trpc.article.summary.useQuery(
    {
      ...articleFilter,
      mpId,
      search: search || undefined,
    },
    { enabled: !filterInvalid, cacheTime: READING_CACHE_TIME },
  );

  useEffect(() => {
    onSelectionChange(new Set());
  }, [mpId, search, onSelectionChange]);

  const {
    data,
    fetchNextPage,
    isLoading,
    hasNextPage,
    isError,
    refetch,
    isFetching,
    isFetchingNextPage,
  } = trpc.article.list.useInfiniteQuery(
    {
      limit: 20,
      ...articleFilter,
      mpId: mpId,
      search: search || undefined,
      sort: collectionChannels[mpId] === 'wechat2rss' ? 'publishTime' : sort,
      direction,
    },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      enabled: !filterInvalid,
      cacheTime: READING_CACHE_TIME,
      keepPreviousData: false,
      retry: false,
    },
  );
  const listViewKey = JSON.stringify([
    mpId,
    search,
    articleFilter,
    sort,
    direction,
  ]);
  const activeView = useRef(listViewKey);
  activeView.current = listViewKey;
  const [nextPageFailed, setNextPageFailed] = useState(false);
  useEffect(() => {
    activeView.current = listViewKey;
    setNextPageFailed(false);
    return () => {
      activeView.current = '';
    };
  }, [listViewKey]);
  const loadNext = useCallback(async () => {
    try {
      const result = await fetchNextPage({ cancelRefetch: false });
      if (activeView.current === listViewKey) setNextPageFailed(result.isError);
      return result;
    } catch {
      if (activeView.current === listViewKey) setNextPageFailed(true);
    }
  }, [fetchNextPage, listViewKey]);

  const items = useMemo(() => {
    return filterInvalid ? [] : data?.pages.flatMap((page) => page.items) || [];
  }, [data, filterInvalid]);
  const hasWechat2Rss =
    collectionChannels[mpId] === 'wechat2rss' ||
    (!mpId && Object.values(collectionChannels).includes('wechat2rss')) ||
    items.some(
      (item) =>
        (collectionChannels[item.mpId] || item.feed?.collectionChannel) ===
        'wechat2rss',
    );
  const readSortingAvailable = !hasWechat2Rss && !!summary.data?.readAvailable;
  const likeSortingAvailable = !hasWechat2Rss && !!summary.data?.likeAvailable;

  useEffect(() => {
    if (!summary.isSuccess) return;
    if (
      (sort === 'readCount' && !readSortingAvailable) ||
      (sort === 'likeCount' && !likeSortingAvailable)
    )
      setSort('publishTime');
  }, [
    readSortingAvailable,
    likeSortingAvailable,
    sort,
    summary.isSuccess,
    setSort,
  ]);

  const position = useArticleListPosition({
    viewKey: listViewKey,
    pageCount: data?.pages.length || 0,
    itemCount: items.length,
    loading: isLoading && !filterInvalid,
    fetching: isFetching,
    hasNext: Boolean(hasNextPage),
    failed: isError || filterInvalid,
    loadNext,
    paused: Boolean(readingId),
  });

  const handleSelectAll = (isSelected: boolean) => {
    if (isSelectionDisabled) return;
    if (isSelected) {
      onSelectionChange(new Set(items.map((item) => item.id)));
    } else {
      onSelectionChange(new Set());
    }
  };

  // Batch export moved to parent component for toolbar integration

  const selection = useMemo(
    () => getLoadedSelection(items, selectedIds),
    [items, selectedIds],
  );
  // Prune disappeared IDs before paint, so toolbar/export cannot imply hidden
  // rows are selected. Loading another page only adds loaded IDs, never selection.
  useLayoutEffect(() => {
    if (selection.visibleSelectedIds.size !== selectedIds.size)
      onSelectionChange(selection.visibleSelectedIds);
  }, [selection, selectedIds, onSelectionChange]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {search.trim() && (
        <div className="shrink-0 border-b px-3 py-2 text-xs" role="status">
          本地字面搜索：标题、公众号及已整理的缓存正文；不联网取文。
          {searchStatus.data ? (
            <>
              全库 {searchStatus.data.total} 篇，未缓存正文{' '}
              {searchStatus.data.uncached} 篇，待整理{' '}
              {searchStatus.data.pending} 篇。
              {searchStatus.data.pending > 0 && '结果尚未覆盖全部缓存正文。'}
            </>
          ) : (
            '正文覆盖范围读取中。'
          )}
          {searchStatus.error && (
            <span role="alert">
              覆盖范围读取失败：{searchStatus.error.message}
            </span>
          )}
          {preparingSearch ? (
            <Button
              size="sm"
              onPress={() => {
                searchActive.current = false;
                setSearchPaused(true);
              }}
            >
              停止整理
            </Button>
          ) : (
            <Button
              size="sm"
              onPress={() => {
                setSearchPaused(false);
                void buildSearch();
              }}
            >
              整理本地正文搜索
            </Button>
          )}
        </div>
      )}

      {
        <ContentSortControls
          sort={sort}
          onSortChange={(next) => {
            setSort(next as typeof sort);
            onSelectionChange(new Set());
          }}
          direction={direction}
          onDirectionChange={(next) => {
            onDirectionChange(next);
            onSelectionChange(new Set());
          }}
          options={[
            { value: 'publishTime', label: '发布时间' },
            ...(readSortingAvailable
              ? [{ value: 'readCount', label: '阅读量从高到低' }]
              : []),
            ...(likeSortingAvailable
              ? [{ value: 'likeCount', label: '点赞量从高到低' }]
              : []),
          ]}
        >
          {!hasWechat2Rss && (readSortingAvailable || likeSortingAvailable) && (
            <span>带“+”为下限。收藏仅显示源数据，不以分享或在看代替。</span>
          )}
        </ContentSortControls>
      }
      <p className="px-3 py-1 text-xs text-neutral-500">
        全选仅勾选已加载的 {items.length} 篇；新增行需另行勾选。
      </p>

      {isError && (
        <div role="alert" className="px-3 py-2 text-sm text-red-600">
          文章列表读取失败，请重试。
          {items.length ? '下方为此前已读取的存量。' : ''}
          <Button size="sm" variant="light" onPress={() => refetch()}>
            重试
          </Button>
        </div>
      )}
      <div
        ref={position.scrollRef}
        onScroll={position.capturePosition}
        role="region"
        aria-label="文章列表"
        tabIndex={0}
        className="mt-2 min-h-0 flex-1 overflow-y-auto"
      >
        <div className="compact-list">
          <ContentSelectionHeader
            selected={selection.allSelected}
            indeterminate={selection.isIndeterminate}
            disabled={isSelectionDisabled || items.length === 0}
            onChange={handleSelectAll}
            title={
              <>
                文章标题
                {!filterInvalid &&
                  summary.data &&
                  ` · ${summary.data.articles} 篇`}
              </>
            }
          />

          {items?.map((item) => (
            <div
              key={item.id}
              data-article-id={item.id}
              className={`compact-row article-row ${
                item.bodyCached ? 'article-row-ready' : ''
              } !grid grid-cols-[24px_minmax(0,1fr)] !items-start md:!flex md:!items-center`}
            >
              <div className="compact-col-check">
                <Checkbox
                  aria-label={`选择文章：${item.title}`}
                  size="sm"
                  isDisabled={isSelectionDisabled}
                  isSelected={selectedIds.has(item.id)}
                  onValueChange={(isSelected) => {
                    if (isSelectionDisabled) return;
                    const next = new Set(selectedIds);
                    if (isSelected) next.add(item.id);
                    else next.delete(item.id);
                    onSelectionChange(next);
                  }}
                />
              </div>
              <a
                className="compact-title min-w-0 !whitespace-normal break-words text-[15px] hover:text-[#007AFF] md:!whitespace-nowrap dark:hover:text-[#0A84FF]"
                target="_blank"
                rel="noopener noreferrer"
                title={
                  item.bodyCached
                    ? '点击标题阅读已保存正文'
                    : '正文尚未保存，点击打开原文'
                }
                aria-label={`${item.bodyCached ? '阅读已保存正文' : '打开原文'}：${item.title}`}
                onClick={(event) => {
                  position.rememberForReader();
                  if (item.bodyCached) {
                    event.preventDefault();
                    setReadingId(item.id);
                  }
                }}
                href={item.sourceUrl || `https://mp.weixin.qq.com/s/${item.id}`}
              >
                {item.title}
                {item.searchSnippet && (
                  <span
                    className="mt-1 block whitespace-normal break-words text-xs font-normal text-neutral-500"
                    data-search-snippet
                  >
                    正文：{item.searchSnippet.before}
                    <mark>{item.searchSnippet.match}</mark>
                    {item.searchSnippet.after}
                  </span>
                )}
              </a>
              <div className="col-start-2 flex w-auto min-w-0 shrink-0 flex-col items-start gap-0.5 text-neutral-500 md:w-[300px] md:items-end">
                <div
                  className="flex flex-wrap items-center gap-2 text-xs md:flex-nowrap"
                  aria-live="polite"
                >
                  <span>{articleBodyState(item.bodyCached).current}</span>
                  {!item.bodyCached && (
                    <Button
                      size="sm"
                      variant="light"
                      aria-label={`重试正文：${item.title}`}
                      title={
                        item.bodyRetry.allowed
                          ? '仅请求本篇官方原文，不操作微信窗口；保留已有正文。'
                          : item.bodyRetry.reason
                      }
                      isDisabled={
                        !item.bodyRetry.allowed || bodyRetry.isLoading
                      }
                      isLoading={
                        bodyRetry.isLoading && bodyRetry.variables === item.id
                      }
                      onPress={() => retryBody(item.id, item.title)}
                    >
                      重试正文
                    </Button>
                  )}
                </div>
                {!item.bodyCached && !item.bodyRetry.allowed && (
                  <span className="text-left text-xs md:text-right">
                    正文暂不可重试
                  </span>
                )}
                {(collectionChannels[item.mpId] ||
                  item.feed?.collectionChannel) !== 'wechat2rss' && (
                  <span
                    className="whitespace-normal break-words text-xs md:whitespace-nowrap"
                    title="指标来自采集源数据，可能不是实时值；未获取不代表 0"
                  >
                    阅读 {metricDisplay(item.metrics, 'read')} · 点赞{' '}
                    {metricDisplay(item.metrics, 'like')} · 收藏{' '}
                    {metricDisplay(item.metrics, 'favorite')}
                  </span>
                )}
                <div className="flex w-full min-w-0 flex-wrap items-center justify-start gap-2 text-xs md:flex-nowrap md:justify-end">
                  <span className="truncate">
                    {item.feed?.mpName || '未知'}
                  </span>
                  <span className="opacity-30">|</span>
                  <span
                    className="shrink-0"
                    title="库内记录的发布时间；存量日期需与原文核对"
                  >
                    {item.publishTime > 0
                      ? formatShanghaiPublicationTime(item.publishTime)
                      : '发布时间未知'}
                  </span>
                </div>
              </div>
            </div>
          ))}

          {isLoading && !filterInvalid && (
            <div className="flex justify-center p-4">
              <Spinner size="sm" />
            </div>
          )}

          {!isLoading &&
            !filterInvalid &&
            (hasNextPage || (isError && items.length > 0)) && (
              <ContentLoadMore
                loading={isFetchingNextPage}
                disabled={isFetching}
                error={isError}
                onLoad={() =>
                  void (isError && !nextPageFailed
                    ? refetch({ cancelRefetch: false })
                    : loadNext())
                }
              />
            )}

          {!isLoading &&
          !isFetching &&
          !isError &&
          !filterInvalid &&
          data?.pages.length &&
          hasNextPage === false &&
          items.length > 0 ? (
            <p
              data-article-pagination
              role="status"
              className="p-4 text-center text-xs text-neutral-500"
            >
              已显示当前筛选的全部 {items.length} 篇文章
            </p>
          ) : null}

          {!isLoading && !isError && items?.length === 0 && (
            <div className="p-10 text-center text-sm text-neutral-400">
              {filterInvalid ? '请修正日期范围' : '当前筛选暂无文章'}
            </div>
          )}
        </div>
      </div>
      <Modal
        isOpen={Boolean(readingId)}
        onClose={() => {
          position.restoreAfterReader();
          setReaderFindOpen(false);
          setReadingId(null);
        }}
        isKeyboardDismissDisabled={readerFindOpen}
        size="4xl"
        scrollBehavior="inside"
        classNames={{ wrapper: 'z-[200]', backdrop: 'z-[190]' }}
      >
        <ModalContent>
          <ModalHeader>{reading.data?.title || '读取已保存正文'}</ModalHeader>
          <ModalBody>
            <p className="text-sm text-neutral-500">阅读已保存的正文和图片。</p>
            {reading.isLoading ? (
              <Spinner />
            ) : reading.error ? (
              <div role="alert">
                <FailureNotice
                  error={reading.error}
                  fallback="正文读取失败，请稍后重试或打开原文。"
                />
              </div>
            ) : reading.data?.contentHtml ? (
              <ArticleReader
                key={readingId}
                contentHtml={reading.data.contentHtml}
                findOpen={readerFindOpen}
                onFindOpenChange={setReaderFindOpen}
              />
            ) : (
              <p role="alert">正文尚未保存，可打开原文阅读。</p>
            )}
          </ModalBody>
        </ModalContent>
      </Modal>
    </div>
  );
};

export default ArticleList;
