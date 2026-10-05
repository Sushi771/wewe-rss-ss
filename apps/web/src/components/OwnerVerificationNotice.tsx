import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { trpc } from '../utils/trpc';

/** This shared layout polls local saved state, never Tencent or a collection.
 * A browser popup or human acknowledgement cannot unblock a stopped request.
 */
export default function OwnerVerificationNotice() {
  const [expanded, setExpanded] = useState(false);
  const [checked, setChecked] = useState(false);
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
      aria-label="微信读书订阅验证状态"
      className="border-warning-300 bg-background fixed bottom-3 left-3 right-3 z-40 mx-auto max-w-xl rounded-xl border p-3 text-sm shadow-lg"
    >
      <div className="flex items-center justify-between gap-3">
        <strong>微信读书订阅验证待处理 · 更新已停止</strong>
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
                此入口只打开微信读书官网。官网中的验证由官网完成，目前不会
                自动传回本应用；官方网页可以继续阅读，本机更新仍已停止。
                旧文章和图片已保留。
              </p>
              {checked && (
                <p className="text-warning-600">
                  检查结果：本机仍未接通同一会话的验证接续，暂不能继续更新。
                  本次检查只读取本机状态，没有重新取文或验证。
                </p>
              )}
              <div className="flex flex-wrap gap-3">
                <a
                  href={notice.officialUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline"
                >
                  打开微信读书官网（不会回传）
                </a>
                <Link to="/accounts" className="text-primary underline">
                  查看已绑定账号
                </Link>
                <button
                  type="button"
                  className="text-primary underline"
                  disabled={status.isFetching}
                  onClick={async () => {
                    await status.refetch();
                    setChecked(true);
                  }}
                >
                  检查能否继续（只读）
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
