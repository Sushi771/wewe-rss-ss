import { FC, useEffect, useMemo, useState } from 'react';
import { Button, Spinner, Checkbox } from '@nextui-org/react';
import { trpc } from '@web/utils/trpc';
import dayjs from 'dayjs';
import { useParams } from 'react-router-dom';
import { toast } from 'sonner';

interface ArticleListProps {
  search: string;
  selectedIds: Set<string>;
  onSelectionChange: (selectedIds: Set<string>) => void;
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
}) => {
  const { id } = useParams();

  const mpId = id || '';
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

  useEffect(() => {
    if (
      summary.data &&
      ((sort === 'readCount' && !summary.data.readAvailable) ||
        (sort === 'likeCount' && !summary.data.likeAvailable))
    ) {
      setSort('publishTime');
    }
  }, [summary.data, sort]);

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
      sort,
    },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    },
  );

  const items = useMemo(() => {
    return data?.pages.flatMap((page) => page.items) || [];
  }, [data]);

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
      <label className="text-default-500 flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
        排序
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
          <option value="readCount" disabled={!summary.data?.readAvailable}>
            阅读量从高到低{summary.data?.readAvailable ? '' : '（未获取）'}
          </option>
          <option value="likeCount" disabled={!summary.data?.likeAvailable}>
            点赞量从高到低{summary.data?.likeAvailable ? '' : '（未获取）'}
          </option>
        </select>
        <span>
          缺失指标不等于 0；带“+”为下限。收藏仅显示源数据，不以分享或在看代替。
        </span>
      </label>
      <div className="text-default-500 px-3 pb-2 text-xs" aria-live="polite">
        {summary.data ? (
          <>
            当前{search ? '筛选' : '订阅'}存量 {summary.data.articles}{' '}
            篇；阅读已获取 {summary.data.readAvailable} 篇，点赞已获取{' '}
            {summary.data.likeAvailable} 篇， 已缓存正文{' '}
            {summary.data.cachedBodies} 篇。
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
            {!summary.data.readAvailable &&
              !summary.data.likeAvailable &&
              ' 尚未获取阅读和点赞，热度排序已禁用。'}
          </>
        ) : summary.isError ? (
          '指标覆盖情况查询失败，暂不可按热度排序。'
        ) : (
          '正在读取存量与指标覆盖情况…'
        )}
      </div>
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
            <div className="compact-col-title">文章标题</div>
            <div className="compact-col-metadata">信息</div>
          </div>

          {items?.map((item) => (
            <div key={item.id} className="compact-row article-row">
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
                className="compact-title text-[15px] hover:text-[#007AFF] dark:hover:text-[#0A84FF]"
                target="_blank"
                rel="noopener noreferrer"
                href={item.sourceUrl || `https://mp.weixin.qq.com/s/${item.id}`}
              >
                {item.title}
              </a>
              <div className="flex w-[300px] shrink-0 flex-col items-end gap-0.5 text-neutral-500">
                <div
                  className="flex items-center gap-2 text-xs"
                  aria-live="polite"
                >
                  <span>{item.bodyCached ? '正文已缓存' : '正文未缓存'}</span>
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
                  <span className="text-right text-xs">
                    {item.bodyRetry.reason}
                  </span>
                )}
                {item.bodyRetryResult && (
                  <span
                    className="text-right text-xs"
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
                <span
                  className="whitespace-nowrap text-xs"
                  title="指标来自采集源数据，可能不是实时值；未获取不代表 0"
                >
                  阅读 {metricDisplay(item.metrics, 'read')} · 点赞{' '}
                  {metricDisplay(item.metrics, 'like')} · 收藏{' '}
                  {metricDisplay(item.metrics, 'favorite')}
                </span>
                <div className="flex w-full items-center justify-end gap-2 text-xs">
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
    </div>
  );
};

export default ArticleList;
