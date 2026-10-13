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
  if (!notices.length && !status.data?.unavailable && !status.error)
    return null;
  return (
    <aside
      role="status"
      aria-label="微信读书订阅验证状态"
      className="border-warning-300 bg-background fixed bottom-3 left-3 right-3 z-40 mx-auto max-w-xl rounded-xl border p-3 text-sm shadow-lg"
    >
      <div className="flex items-center justify-between gap-3">
        <strong>微信读书账号或验证待处理 · 更新未恢复</strong>
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
          {(status.data?.unavailable || status.error) && (
            <p>本机账号或验证状态暂不可读，请刷新本机状态；未重新取文。</p>
          )}
          {notices.map((notice) => (
            <div key={notice.feedId} className="mb-3 space-y-2">
              <p>
                {notice.feedName}：{notice.stage}
                {notice.state === 'expired'
                  ? '登录已过期，请重新扫码登录。'
                  : '需官方验证。'}
                已绑定 {notice.accountName || '读书账号'}（尾号{' '}
                {notice.accountTail}）。
              </p>
              <p>
                {notice.state === 'expired'
                  ? '请在账号管理中对原账号重新登录。登录成功不代表官方挑战解除或公众号更新恢复。'
                  : '此次响应未提供可核验的官方验证地址。官网首页只是普通入口；网页验证目前不会自动传回本应用。'}
                本机更新仍已停止，旧文章和图片已保留。
              </p>
              {checked && (
                <p className="text-warning-600">
                  本机更新仍停止。本次只读取保存状态，没有重新取文或验证；
                  重新登录或打开官网不代表取文已恢复。
                </p>
              )}
              <div className="flex flex-wrap gap-3">
                <a
                  href={notice.officialUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline"
                >
                  打开官网首页（普通入口，非验证地址）
                </a>
                <Link to="/accounts" className="text-primary underline">
                  {notice.state === 'expired'
                    ? '前往账号管理重新扫码'
                    : '查看已绑定账号'}
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
                  刷新本机状态（只读）
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
