import { FC, useEffect, useMemo, useState } from 'react';
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
import dayjs from 'dayjs';
import { useParams } from 'react-router-dom';
import { toast } from 'sonner';

interface ArticleListProps {
  search: string;
  selectedIds: Set<string>;
  onSelectionChange: (selectedIds: Set<string>) => void;
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
  selectedIds,
  onSelectionChange,
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
      if (result.status === 'available')
        toast.success(`${title}：${result.message}`);
      else if (result.status === 'failed')
        toast.error(`${title}：${result.message}`);
      else toast.warning(`${title}：${result.message}`);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : '正文重试失败，请重新读取文章状态。',
      );
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

  const summary = trpc.article.summary.useQuery({
    mpId,
    search: search || undefined,
  });

  useEffect(() => {
    setSort('publishTime');
    onSelectionChange(new Set());
  }, [mpId, search, onSelectionChange]);

  const {
    data,
    fetchNextPage,
    isLoading,
    hasNextPage,
    isError,
    error,
    refetch,
  } = trpc.article.list.useInfiniteQuery(
    {
      limit: 20,
      mpId: mpId,
      search: search || undefined,
      sort: collectionChannels[mpId] === 'wechat2rss' ? 'publishTime' : sort,
    },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    },
  );

  const items = useMemo(() => {
    return data?.pages.flatMap((page) => page.items) || [];
  }, [data]);
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
    if (isSelected) {
      onSelectionChange(new Set(items.map((item) => item.id)));
    } else {
      onSelectionChange(new Set());
    }
  };

  // Batch export moved to parent component for toolbar integration

  const allSelected = items.length > 0 && selectedIds.size === items.length;

  return (
    <div className="flex h-full flex-col">
      {(readSortingAvailable || likeSortingAvailable) && (
        <label className="text-default-500 flex flex-wrap items-center gap-2 px-3 py-1 text-xs">
          排序
          {readSortingAvailable || likeSortingAvailable ? (
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
          ) : (
            <span>按发布时间排列</span>
          )}
          {!hasWechat2Rss && (readSortingAvailable || likeSortingAvailable) && (
            <span>带“+”为下限。收藏仅显示源数据，不以分享或在看代替。</span>
          )}
        </label>
      )}
      <details className="feed-stock-details shrink-0 px-3 py-1 text-xs">
        <summary className="cursor-pointer text-neutral-500">
          存量详情
          {summary.data &&
            summary.data.cachedBodies < summary.data.articles && (
              <span
                role="status"
                className="text-amber-700 dark:text-amber-300"
              >
                {' '}
                · 部分正文未缓存
              </span>
            )}
        </summary>
        <div className="text-default-500 px-3 pb-2 text-xs" aria-live="polite">
          {summary.data ? (
            <>
              当前{search ? '筛选' : '订阅'}存量 {summary.data.articles} 篇；
              {!hasWechat2Rss && (
                <>
                  阅读已获取 {summary.data.readAvailable} 篇，点赞已获取{' '}
                  {summary.data.likeAvailable} 篇，
                </>
              )}
              已缓存正文 {summary.data.cachedBodies} 篇。
              {summary.data.oldestPublishTime &&
              summary.data.newestPublishTime ? (
                <>
                  {' '}
                  库内记录的发布时间范围：
                  {dayjs(summary.data.oldestPublishTime * 1e3).format(
                    'YYYY-MM-DD',
                  )}{' '}
                  至{' '}
                  {dayjs(summary.data.newestPublishTime * 1e3).format(
                    'YYYY-MM-DD',
                  )}
                  ，不代表期间无遗漏；存量日期尚需与原文核对。
                </>
              ) : null}
            </>
          ) : summary.isError ? (
            '存量信息读取失败。'
          ) : (
            '正在读取存量信息…'
          )}
        </div>
      </details>
      {isError && (
        <div role="alert" className="px-3 py-2 text-sm text-red-600">
          文章列表读取失败：{error.message}。
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
                size="sm"
                isSelected={allSelected}
                onValueChange={handleSelectAll}
              />
            </div>
            <div className="compact-col-title min-w-0 whitespace-nowrap">
              文章标题
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
                  size="sm"
                  isSelected={selectedIds.has(item.id)}
                  onValueChange={(isSelected) => {
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
                    {item.bodyRetry.reason}
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
                      ? dayjs(item.publishTime * 1e3).format('YYYY-MM-DD HH:mm')
                      : '发布时间未知'}
                  </span>
                </div>
              </div>
            </div>
          ))}

          {isLoading && (
            <div className="flex justify-center p-4">
              <Spinner size="sm" />
            </div>
          )}

          {hasNextPage && !isLoading && (
            <div className="flex justify-center p-4">
              <Button size="sm" variant="light" onPress={() => fetchNextPage()}>
                加载更多
              </Button>
            </div>
          )}

          {!isLoading && !isError && items?.length === 0 && (
            <div className="p-10 text-center text-sm text-neutral-400">
              暂无数据
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
