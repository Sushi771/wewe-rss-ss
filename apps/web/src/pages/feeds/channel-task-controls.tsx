import { useState } from 'react';
import { trpc } from '@web/utils/trpc';

/** Explicit local administration. Loading this panel never submits source work. */
export function ChannelTaskControls({
  channel,
}: {
  channel: 'wechat' | 'xiaohongshu';
}) {
  const utils = trpc.useUtils();
  const status = trpc.channelTasks.status.useQuery(
    { channel },
    { retry: false, refetchOnWindowFocus: false },
  );
  const confirm = trpc.channelTasks.confirm.useMutation({ retry: false });
  const [preview, setPreview] =
    useState<Awaited<ReturnType<typeof utils.channelTasks.preview.fetch>>>();
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const name = channel === 'wechat' ? '公众号' : '小红书';
  async function review(action: 'archive' | 'pause' | 'resume') {
    setError('');
    setPreview(undefined);
    setChecking(true);
    try {
      setPreview(await utils.channelTasks.preview.fetch({ channel, action }));
    } catch {
      setError('本地任务状态无法确认，操作已停止。');
    } finally {
      setChecking(false);
    }
  }
  async function apply() {
    if (!preview) return;
    setError('');
    try {
      await confirm.mutateAsync({
        channel,
        action: preview.action,
        digest: preview.digest,
        acknowledged: true,
      });
    } catch {
      setError('操作未确认完成。请重新预览核对，不要重复提交旧预览。');
      setPreview(undefined);
      return;
    }
    setPreview(undefined);
    // Reload only after the server receipt so retained client task identities
    // are inspected again. The normal page never advances a batch on reload.
    window.location.reload();
  }
  return (
    <section className="border-b p-2 text-xs" aria-label={`${name}任务管理`}>
      <span>
        {name}：
        {status.data
          ? status.data.paused
            ? '已暂停'
            : '渠道准入开启'
          : '状态待核实'}
      </span>
      {status.data?.globalRecoveryHeld && <span> · 全局维护暂停仍生效</span>}
      <div className="flex flex-wrap gap-3 py-1">
        <button
          disabled={checking || confirm.isLoading}
          onClick={() => void review('pause')}
        >
          暂停本渠道
        </button>
        <button
          disabled={
            checking ||
            confirm.isLoading ||
            !status.data ||
            status.data.globalRecoveryHeld
          }
          onClick={() => void review('resume')}
        >
          恢复本渠道新任务
        </button>
        <button
          disabled={checking || confirm.isLoading}
          onClick={() => void review('archive')}
        >
          预览清空任务清单
        </button>
      </div>
      {preview && (
        <div
          role="region"
          aria-label="确认任务管理操作"
          className="rounded border p-2"
        >
          <p>
            本次：
            {preview.action === 'archive'
              ? '归档并隔离旧任务，同时暂停本渠道'
              : preview.action === 'pause'
                ? '暂停本渠道'
                : '允许本渠道新任务准入'}
            。
          </p>
          <p>
            清单记录 {preview.visibleCount} 项；已有归档 {preview.archiveCount}{' '}
            项。保留原始记录、防重复证据和全部内容，不重放旧任务。
          </p>
          <p>
            另有 {preview.retainedUnknownCount}{' '}
            条请求结果未知的保护记录继续保留。
          </p>
          {preview.action === 'archive' && (
            <details>
              <summary>查看精确任务清单</summary>
              <ul className="max-h-40 overflow-auto">
                {preview.records.map((r) => (
                  <li key={r.kind + r.id}>
                    {r.kind} · {r.id}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <p>确认时必须通过写前备份和状态复核；此操作不发送来源请求。</p>
          <button disabled={confirm.isLoading} onClick={() => void apply()}>
            确认本次操作
          </button>{' '}
          <button
            disabled={confirm.isLoading}
            onClick={() => setPreview(undefined)}
          >
            返回
          </button>
        </div>
      )}
      {(error || status.error) && (
        <p role="alert">
          {error || '任务管理状态读取失败，当前渠道保护保持。'}
        </p>
      )}
    </section>
  );
}
