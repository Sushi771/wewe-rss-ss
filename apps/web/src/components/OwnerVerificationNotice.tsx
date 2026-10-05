import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { trpc } from '../utils/trpc';

/** This shared layout polls local saved state, never Tencent or a collection.
 * A browser popup or human acknowledgement cannot unblock a stopped request.
 */
export default function OwnerVerificationNotice() {
  const [expanded, setExpanded] = useState(false);
  const location = useLocation();
  const status = trpc.collection.verificationStatus.useQuery(undefined, {
    enabled:
      location.pathname !== '/login' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname),
    retry: false,
    refetchInterval: 10000,
    refetchOnWindowFocus: true,
  });
  const notices = status.data?.notices || [];
  if (!notices.length) return null;
  return (
    <aside
      role="status"
      aria-label="腾讯官方验证待处理"
      className="border-warning-300 bg-background fixed bottom-3 left-3 right-3 z-40 mx-auto max-w-xl rounded-xl border p-3 text-sm shadow-lg"
    >
      <div className="flex items-center justify-between gap-3">
        <strong>腾讯官方验证待处理 · 更新已停止</strong>
        <button
          type="button"
          className="text-primary shrink-0 underline"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? '收起' : '查看处理说明'}
        </button>
      </div>
      {expanded && (
        <div className="mt-2 max-h-[45vh] overflow-y-auto">
          {notices.map((notice) => (
            <div key={notice.feedId} className="mb-3 space-y-2">
              <p>
                {notice.feedName}：{notice.stage}
                需要官方验证。请确认官方页面使用
                {notice.accountName || '已绑定账号'}（尾号 {notice.accountTail}
                ）。
              </p>
              <p>
                请在官方页面人工处理。本应用尚未取得可用于恢复更新的验证结果；
                打开页面或完成网页验证后，后台仍须实际取文成功才能确认恢复。
                旧文章和图片已保留。
              </p>
              <div className="flex flex-wrap gap-3">
                <a
                  href={notice.officialUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline"
                >
                  打开官方微信读书
                </a>
                <Link to="/accounts" className="text-primary underline">
                  查看已绑定账号
                </Link>
                <button
                  type="button"
                  className="text-primary underline"
                  disabled={status.isFetching}
                  onClick={() => void status.refetch()}
                >
                  查看本应用状态
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
