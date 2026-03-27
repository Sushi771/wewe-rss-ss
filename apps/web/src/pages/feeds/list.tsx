import { FC, useMemo } from 'react';
import { Button, Spinner, Link, Checkbox } from '@nextui-org/react';
import { trpc } from '@web/utils/trpc';
import dayjs from 'dayjs';
import { useParams } from 'react-router-dom';
import { toast } from 'sonner';

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
            <div className="compact-col-source">公众号</div>
            <div className="compact-col-time">发布时间</div>
            <div className="compact-col-action">操作</div>
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
              <Link
                className="compact-title"
                target="_blank"
                href={`https://mp.weixin.qq.com/s/${item.id}`}
              >
                {item.title}
              </Link>
              <div className="compact-source">{item.feed?.mpName || '-'}</div>
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
                      await trpcUtils.client.article.saveToObsidian.mutate(
                        item.id,
                      );
                      toast.success('已导出');
                    } catch (err: unknown) {
                      toast.error('失败', {
                        description:
                          err instanceof Error ? err.message : String(err),
                      });
                    }
                  }}
                >
                  导出 Obsidian
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
