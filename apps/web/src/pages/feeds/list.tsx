import { FC, useMemo, useState } from 'react';
import {
  Button,
  Spinner,
  Link,
  Checkbox,
} from '@nextui-org/react';
import { trpc } from '@web/utils/trpc';
import dayjs from 'dayjs';
import { useParams } from 'react-router-dom';
import { toast } from 'sonner';

interface ArticleListProps {
  search: string;
  selectedIds: Set<string>;
  onSelectionChange: (selectedIds: Set<string>) => void;
}

const ArticleList: FC<ArticleListProps> = ({ search, selectedIds, onSelectionChange }) => {
  const { id } = useParams();
  const trpcUtils = trpc.useUtils();

  const mpId = id || '';

  const { data, fetchNextPage, isLoading, hasNextPage } =
    trpc.article.list.useInfiniteQuery(
      {
        limit: 20,
        mpId: mpId,
        search: search || undefined,
      },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        keepPreviousData: true,
      },
    );

  const items = useMemo(() => {
    const items = data
      ? data.pages.reduce((acc, page) => [...acc, ...page.items], [] as any[])
      : [];

    return items;
  }, [data]);

  const handleSelectAll = (isSelected: boolean) => {
    if (isSelected) {
      onSelectionChange(new Set(items.map((item: any) => item.id)));
    } else {
      onSelectionChange(new Set());
    }
  };

  // Batch export moved to parent component for toolbar integration



  const allSelected = items.length > 0 && selectedIds.size === items.length;

  return (
    <div className="flex flex-col h-full">


      <div className="flex-1 overflow-y-auto mt-2">
        <div className="compact-list">
          <div className="compact-list-header border-b-[0.5px] border-neutral-200 dark:border-neutral-700 pb-2 mb-2">
            <div className="compact-col-check">
              <Checkbox 
                size="sm" 
                isSelected={allSelected}
                onValueChange={handleSelectAll}
              />
            </div>
            <div className="compact-col-title text-[#888] font-medium text-[13px]">文章标题</div>
            <div className="compact-col-source text-[#888] font-medium text-[13px]">公众号</div>
            <div className="compact-col-time text-[#888] font-medium text-[13px] text-right">发布时间</div>
            <div className="compact-col-action text-[#888] font-medium text-[13px] text-right">操作</div>
          </div>

          {items?.map((item: any) => (
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
              <Link
                className="compact-title visited:text-neutral-400 text-[15px]"
                target="_blank"
                href={`https://mp.weixin.qq.com/s/${item.id}`}
              >
                {item.title}
              </Link>
              <div className="compact-source">
                {item.feed?.mpName || '-'}
              </div>
              <div className="compact-time">
                {dayjs(item.publishTime * 1e3).format('YYYY-MM-DD HH:mm')}
              </div>
              <div className="compact-action">
                <span
                  className="compact-action-link"
                  onClick={async (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    try {
                      await trpcUtils.client.article.saveToObsidian.mutate(item.id);
                      toast.success('已导出');
                    } catch (err: any) {
                      toast.error('失败', { description: err.message });
                    }
                  }}
                >
                  导出 Obsidian
                </span>
              </div>
            </div>
          ))}
          
          {isLoading && (
            <div className="p-4 flex justify-center">
              <Spinner size="sm" />
            </div>
          )}

          {hasNextPage && !isLoading && (
            <div className="p-4 flex justify-center">
              <Button
                size="sm"
                variant="light"
                onPress={() => fetchNextPage()}
              >
                加载更多
              </Button>
            </div>
          )}

          {!isLoading && items?.length === 0 && (
            <div className="p-10 text-center text-neutral-400 text-sm">
              暂无数据
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ArticleList;
