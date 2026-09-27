import { FC, useMemo, useState } from 'react';
import { Button, Spinner, Checkbox } from '@nextui-org/react';
import { trpc } from '@web/utils/trpc';
import dayjs from 'dayjs';
import { useParams } from 'react-router-dom';

interface ArticleListProps {
  search: string;
  selectedIds: Set<string>;
  onSelectionChange: (selectedIds: Set<string>) => void;
}

const ArticleList: FC<ArticleListProps> = ({
  search,
  selectedIds,
  onSelectionChange,
}) => {
  const { id } = useParams();

  const mpId = id || '';
  const [sort, setSort] = useState<'publishTime' | 'readCount' | 'likeCount'>(
    'publishTime',
  );

  const { data, fetchNextPage, isLoading, hasNextPage } =
    trpc.article.list.useInfiniteQuery(
      {
        limit: 20,
        mpId: mpId,
        search: search || undefined,
        sort,
      },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        keepPreviousData: true,
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
      <label className="text-default-500 flex items-center gap-2 px-3 py-2 text-sm">
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
          <option value="readCount">阅读量从高到低</option>
          <option value="likeCount">点赞量从高到低</option>
        </select>
        <span>热度未提供显示“—”；带“+”为下限</span>
      </label>
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
            <div key={item.id} className="compact-row">
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
              <div className="compact-metadata">
                <span
                  className="whitespace-nowrap text-xs"
                  title="指标来自导入的数据文件，可能不是实时值"
                >
                  阅读 {JSON.parse(item.metrics || '{}').read?.display ?? '—'} ·
                  点赞 {JSON.parse(item.metrics || '{}').like?.display ?? '—'}
                </span>
                <span className="flex-1 truncate text-right">
                  {item.feed?.mpName || '未知'}
                </span>
                <span className="text-[10px] opacity-20">|</span>
                <span className="text-[13px] font-medium opacity-50">
                  {dayjs(item.publishTime * 1e3).format('MM-DD HH:mm')}
                </span>
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

          {!isLoading && items?.length === 0 && (
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
