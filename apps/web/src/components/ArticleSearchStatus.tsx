import { Button } from '@nextui-org/react';
import { FailureNotice } from './OperationNotice';

export default function ArticleSearchStatus({
  data,
  error,
  preparing,
  onPause,
  onContinue,
}: {
  data?: { total: number; uncached: number; pending: number };
  error?: unknown;
  preparing: boolean;
  onPause: () => void;
  onContinue: () => void;
}) {
  return (
    <div className="shrink-0 border-b px-3 py-2 text-xs" role="status">
      {error ? (
        <FailureNotice
          error={error}
          fallback="搜索范围暂时无法确认，请稍后重试。"
        />
      ) : !data ? (
        '正在确认搜索范围…'
      ) : (
        <p>
          {preparing ? '正在准备正文搜索…' : '搜索已保存的文章。'}
          {data.pending > 0 && '部分正文暂未纳入结果。'}
          {data.uncached > 0 && '未保存的正文无法搜索。'}
        </p>
      )}
      {data && (
        <details>
          <summary className="cursor-pointer">查看搜索范围</summary>
          <p>
            搜索标题、公众号名称和已准备的正文，按输入文字匹配，不会联网获取文章。
          </p>
          <p>
            全部订阅共 {data.total} 篇；正文尚未保存 {data.uncached}{' '}
            篇，搜索准备中 {data.pending} 篇。
          </p>
        </details>
      )}
      {preparing ? (
        <Button size="sm" onPress={onPause}>
          暂停准备
        </Button>
      ) : (
        Boolean(data?.pending) && (
          <Button size="sm" onPress={onContinue}>
            继续准备正文搜索
          </Button>
        )
      )}
    </div>
  );
}
