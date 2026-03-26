import { FC, useMemo, useState } from 'react';
import {
  Table,
  TableHeader,
  TableColumn,
  TableBody,
  TableRow,
  TableCell,
  getKeyValue,
  Button,
  Spinner,
  Link,
  Input,
  Chip,
  Selection,
} from '@nextui-org/react';
import { trpc } from '@web/utils/trpc';
import dayjs from 'dayjs';
import { useParams } from 'react-router-dom';
import { toast } from 'sonner';

const ArticleList: FC = () => {
  const { id } = useParams();
  const trpcUtils = trpc.useUtils();
  const [selectedKeys, setSelectedKeys] = useState<Selection>(new Set([]));
  const [search, setSearch] = useState('');

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

  const hotKeywords = useMemo(() => {
    if (!items.length) return [];
    const wordCount: Record<string, number> = {};
    // Simple Chinese word extraction (heuristic: 2-4 chars, excluding some common stop words)
    const stopWords = new Set(['可以', '如何', '怎么', '什么', '为什么', '还是', '一个', '这些', '因为', '所以', '但是', '如果']);
    
    items.forEach((item: any) => {
      // Regex to find Chinese character sequences
      const matches = item.title.match(/[\u4e00-\u9fa5]{2,4}/g);
      if (matches) {
        matches.forEach((word: string) => {
          if (!stopWords.has(word)) {
            wordCount[word] = (wordCount[word] || 0) + 1;
          }
        });
      }
    });

    return Object.entries(wordCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word]) => word);
  }, [items]);

  return (
    <div className="flex flex-col gap-4 h-full">
      <div className="flex flex-col gap-2">
        <div className="flex justify-between items-center gap-4">
          <Input
            className="max-w-xs"
            placeholder="搜索文章标题..."
            size="sm"
            value={search}
            onValueChange={setSearch}
            isClearable
            onClear={() => setSearch('')}
          />
          <div className="flex justify-end gap-2">
            {(selectedKeys === 'all' || selectedKeys.size > 0) && (
              <div className="flex gap-2">
                <Button
                  color="primary"
                  variant="flat"
                  onPress={async () => {
                    let idsToExport: string[] = [];
                    if (selectedKeys === 'all') {
                      idsToExport = items.map((i) => i.id);
                    } else {
                      idsToExport = Array.from(selectedKeys) as string[];
                    }
                    
                    toast.info(`正在保存 ${idsToExport.length} 篇文章到 Obsidian...`);
                    let successCount = 0;
                    for (const exportId of idsToExport) {
                      try {
                        await trpcUtils.client.article.saveToObsidian.mutate(exportId);
                        successCount++;
                      } catch (err: any) {
                        toast.error(`保存失败: ${err.message}`);
                      }
                    }
                    if (successCount > 0) {
                      toast.success(`成功保存 ${successCount} 篇文章到 Obsidian`);
                    }
                    setSelectedKeys(new Set([]));
                  }}
                >
                  批量导出到 Obsidian ({selectedKeys === 'all' ? items.length : selectedKeys.size})
                </Button>
              </div>
            )}
          </div>
        </div>
        {hotKeywords.length > 0 && (
          <div className="flex flex-wrap gap-2 items-center">
            <span className="text-xs text-neutral-400">热词反馈:</span>
            {hotKeywords.map((word) => (
              <Chip
                key={word}
                size="sm"
                variant="flat"
                color="secondary"
                className="cursor-pointer hover:scale-105 keyword-chip transition-all"
                onClick={() => setSearch(word)}
              >
                {word}
              </Chip>
            ))}
          </div>
        )}
      </div>
      <Table
        selectionMode="multiple"
        selectedKeys={selectedKeys}
        onSelectionChange={setSelectedKeys}
        classNames={{
          base: 'h-full',
          table: 'min-h-[420px]',
        }}
        aria-label="文章列表"
        bottomContent={
          hasNextPage && !isLoading ? (
            <div className="flex w-full justify-center">
              <Button
                isDisabled={isLoading}
                variant="flat"
                onPress={() => {
                  fetchNextPage();
                }}
              >
                {isLoading && <Spinner color="white" size="sm" />}
                加载更多
              </Button>
            </div>
          ) : null
        }
      >
        <TableHeader>
          <TableColumn key="title">标题</TableColumn>
          <TableColumn width={120} key="mpName">
            公众号
          </TableColumn>
          <TableColumn width={180} key="publishTime">
            发布时间
          </TableColumn>
          <TableColumn width={100} key="action">
            操作
          </TableColumn>
        </TableHeader>
        <TableBody
          isLoading={isLoading}
          emptyContent={'暂无数据'}
          items={items || []}
          loadingContent={
            <div className="w-full flex flex-col gap-2">
              {[...Array(6)].map((_, i) => (
                <div key={i} className="skeleton-row">
                  <div className="skel w-4 h-4" />
                  <div className="flex-1 flex flex-col gap-2">
                    <div className="skel h-3 w-3/4" />
                    <div className="skel h-2 w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          }
        >
          {(item) => (
            <TableRow key={item.id} className="article-row">
              {(columnKey) => {
                let value = getKeyValue(item, columnKey);

                if (columnKey === 'publishTime') {
                  value = dayjs(value * 1e3).format('YYYY-MM-DD HH:mm:ss');
                  return <TableCell className="text-neutral-400 group-hover:text-neutral-600 transition-colors">{value}</TableCell>;
                }

                if (columnKey === 'title') {
                  return (
                    <TableCell>
                      <Link
                        className="visited:text-neutral-400 font-medium"
                        isBlock
                        showAnchorIcon
                        color="foreground"
                        target="_blank"
                        href={`https://mp.weixin.qq.com/s/${item.id}`}
                      >
                        {value}
                      </Link>
                    </TableCell>
                  );
                }

                if (columnKey === 'mpName') {
                  return (
                    <TableCell className="text-neutral-500 whitespace-nowrap overflow-hidden text-ellipsis">
                      {item.feed?.mpName || '-'}
                    </TableCell>
                  );
                }

                if (columnKey === 'action') {
                  return (
                    <TableCell className="text-right">
                      <Link
                        className="cursor-pointer font-medium"
                        size="sm"
                        color="primary"
                        onClick={async (ev) => {
                          ev.preventDefault();
                          ev.stopPropagation();
                          try {
                            await trpcUtils.client.article.saveToObsidian.mutate(item.id);
                            toast.success('已导出到 Obsidian');
                          } catch (err: any) {
                            toast.error('导出失败', { description: err.message });
                          }
                        }}
                      >
                        导出到 Obsidian
                      </Link>
                    </TableCell>
                  );
                }
                
                return <TableCell>{value}</TableCell>;
              }}
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
};

export default ArticleList;
