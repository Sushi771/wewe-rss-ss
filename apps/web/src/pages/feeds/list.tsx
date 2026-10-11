import { FC, useEffect, useLayoutEffect, useMemo, useState } from 'react';
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
import { getLoadedSelection } from '@web/utils/feed-selection';
import dayjs from 'dayjs';
import { useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArticleFilter, formatShanghaiPublicationTime } from '@wewe-rss/shared';

interface ArticleListProps {
  search: string;
  articleFilter?: ArticleFilter;
  filterInvalid?: boolean;
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
  const reading = trpc.article.byId.useQuery(readingId || '', {
    enabled: Boolean(readingId),
  });
  const queryUtils = trpc.useUtils();
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
  const [sort, setSort] = useState<'publishTime' | 'readCount' | 'likeCount'>(
    'publishTime',
  );

  const summary = trpc.article.summary.useQuery(
    {
      ...articleFilter,
      mpId,
      search: search || undefined,
    },
    { enabled: !filterInvalid, cacheTime: 0 },
  );

  useEffect(() => {
    setSort('publishTime');
    onSelectionChange(new Set());
  }, [mpId, search, onSelectionChange]);

  const { data, fetchNextPage, isLoading, hasNextPage, isError, refetch } =
    trpc.article.list.useInfiniteQuery(
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
        cacheTime: 0,
        keepPreviousData: false,
      },
    );

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
    if (
      (sort === 'readCount' && !readSortingAvailable) ||
      (sort === 'likeCount' && !likeSortingAvailable)
    )
      setSort('publishTime');
  }, [readSortingAvailable, likeSortingAvailable, sort]);

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
    <div className="flex h-full flex-col">
      {
        <label className="text-default-500 flex flex-wrap items-center gap-2 px-3 py-1 text-xs">
          排序
          {
            <select
              aria-label="文章排序"
              className="bg-background rounded border px-2 py-1"
              value={sort}
              onChange={(e) => {
                setSort(e.target.value as typeof sort);
                onSelectionChange(new Set());
              }}
            >
              <option value="publishTime">发布时间</option>
              {readSortingAvailable && (
                <option value="readCount">阅读量从高到低</option>
              )}
              {likeSortingAvailable && (
                <option value="likeCount">点赞量从高到低</option>
              )}
            </select>
          }
          {sort === 'publishTime' && (
            <select
              aria-label="发布时间顺序"
              className="bg-background rounded border px-2 py-1"
              value={direction}
              onChange={(event) => {
                onDirectionChange(event.target.value as 'asc' | 'desc');
                onSelectionChange(new Set());
              }}
            >
              <option value="desc">最新在前</option>
              <option value="asc">最早在前</option>
            </select>
          )}
          {!hasWechat2Rss && (readSortingAvailable || likeSortingAvailable) && (
            <span>带“+”为下限。收藏仅显示源数据，不以分享或在看代替。</span>
          )}
        </label>
      }
      {isError && (
        <div role="alert" className="px-3 py-2 text-sm text-red-600">
          文章列表读取失败，请重试。
          {items.length ? '下方为此前已读取的存量。' : ''}
          <Button size="sm" variant="light" onPress={() => refetch()}>
            重试
          </Button>
        </div>
      )}
      <div className="mt-2 flex-1 overflow-y-auto">
        <div className="compact-list">
          <div className="compact-list-header">
            <div className="compact-col-check">
              <Checkbox
                aria-label="全选已加载"
                size="sm"
                isSelected={selection.allSelected}
                isIndeterminate={selection.isIndeterminate}
                isDisabled={isSelectionDisabled || items.length === 0}
                onValueChange={handleSelectAll}
              />
            </div>
            <div className="compact-col-title min-w-0 whitespace-nowrap">
              <span className="mr-2 text-xs">全选已加载</span>
              文章标题
              {!filterInvalid &&
                summary.data &&
                ` · ${summary.data.articles} 篇`}
            </div>
            <div className="compact-col-metadata !hidden md:!flex">信息</div>
          </div>

          {items?.map((item) => (
            <div
              key={item.id}
              className="compact-row article-row !grid grid-cols-[24px_minmax(0,1fr)] !items-start md:!flex md:!items-center"
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
                    ? '点击标题阅读缓存正文'
                    : '打开原文；本地正文未缓存'
                }
                aria-label={`${item.bodyCached ? '阅读缓存正文' : '打开原文'}：${item.title}`}
                onClick={(event) => {
                  if (item.bodyCached) {
                    event.preventDefault();
                    setReadingId(item.id);
                  }
                }}
                href={item.sourceUrl || `https://mp.weixin.qq.com/s/${item.id}`}
              >
                {item.title}
              </a>
              <div className="col-start-2 flex w-auto min-w-0 shrink-0 flex-col items-start gap-0.5 text-neutral-500 md:w-[300px] md:items-end">
                <div
                  className="flex flex-wrap items-center gap-2 text-xs md:flex-nowrap"
                  aria-live="polite"
                >
                  {!item.bodyCached && <span>正文未缓存</span>}
                  {(!item.bodyCached ||
                    item.lastBodyStatus === 'unavailable' ||
                    item.bodyRetryResult?.status === 'failed') && (
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
                {item.bodyRetryResult && (
                  <span
                    className="text-left text-xs md:text-right"
                    title={`${dayjs(item.bodyRetryResult.attemptedAt * 1e3).format('YYYY-MM-DD HH:mm:ss')} ${item.bodyRetryResult.message}`}
                  >
                    最近重试：
                    {item.bodyRetryResult.status === 'available'
                      ? '正文可用'
                      : item.bodyRetryResult.status === 'unavailable'
                        ? '未取得正文'
                        : '失败'}
                    {item.bodyRetryResult.filled
                      ? '，已补入正文'
                      : item.bodyRetryResult.cached
                        ? '，已有缓存保留'
                        : ''}
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

          {hasNextPage && !isLoading && !filterInvalid && (
            <div className="flex justify-center p-4">
              <Button size="sm" variant="light" onPress={() => fetchNextPage()}>
                加载更多
              </Button>
            </div>
          )}

          {!isLoading && !isError && items?.length === 0 && (
            <div className="p-10 text-center text-sm text-neutral-400">
              {filterInvalid ? '请修正日期范围' : '当前筛选暂无文章'}
            </div>
          )}
        </div>
      </div>
      <Modal
        isOpen={Boolean(readingId)}
        onClose={() => setReadingId(null)}
        size="4xl"
        scrollBehavior="inside"
        classNames={{ wrapper: 'z-[200]', backdrop: 'z-[190]' }}
      >
        <ModalContent>
          <ModalHeader>{reading.data?.title || '读取已保存正文'}</ModalHeader>
          <ModalBody>
            <p className="text-sm text-neutral-500">
              读取本地已保存正文与图片；本次没有联网取文。
            </p>
            {reading.isLoading ? (
              <Spinner />
            ) : reading.error ? (
              <p role="alert">正文读取失败：{reading.error.message}</p>
            ) : reading.data?.contentHtml ? (
              <iframe
                title="已保存文章正文"
                sandbox=""
                className="h-[65vh] w-full rounded border bg-white"
                srcDoc={`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>body{font:17px/1.8 sans-serif;padding:16px;color:#222;overflow-wrap:anywhere}img{max-width:100%;height:auto}p{margin:1em 0}</style></head><body>${reading.data.contentHtml}</body></html>`}
              />
            ) : (
              <p role="alert">尚无已保存正文；没有自动请求腾讯原文。</p>
            )}
          </ModalBody>
        </ModalContent>
      </Modal>
    </div>
  );
};

export default ArticleList;
