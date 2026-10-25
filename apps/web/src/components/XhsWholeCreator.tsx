import { useState } from 'react';
import { trpc } from '@web/utils/trpc';
export default function XhsWholeCreator({ creatorId }: { creatorId: string }) {
  const [page, setPage] = useState(0);
  const [limit, setLimit] = useState(100),
    [error, setError] = useState('');
  const jobs = trpc.xiaohongshu.wholeCreatorJobs.useQuery(
    { creatorId },
    { enabled: !!creatorId, retry: false, refetchInterval: 3000 },
  );
  const start = trpc.xiaohongshu.startWholeCreator.useMutation({
    retry: false,
  });
  const resume = trpc.xiaohongshu.resumeWholeCreator.useMutation({
    retry: false,
  });
  const extend = trpc.xiaohongshu.extendWholeCreatorBudget.useMutation({
    retry: false,
  });
  const cancel = trpc.xiaohongshu.cancelWholeCreator.useMutation({
    retry: false,
  });
  if (!creatorId) return null;
  const execute = async (work: () => Promise<unknown>) => {
    setError('');
    try {
      await work();
      await jobs.refetch();
    } catch {
      setError('操作未确认，请读取任务状态后再继续。');
    }
  };
  return (
    <details className="min-w-0 rounded border p-3">
      <summary>整号互动覆盖与待补清单</summary>
      <p>
        发现所有可返回笔记，逐篇更新指标、主评论及逐根回复。私密、删除、平台未返回内容未知，不显示全平台完成比例。正文媒体与目录附页另行保存。
      </p>
      <label>
        本轮请求上限{' '}
        <input
          aria-label="整号请求上限"
          type="number"
          min={1}
          max={100000}
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
        />
      </label>
      <button
        disabled={start.isLoading || !Number.isInteger(limit) || limit < 1}
        onClick={() =>
          void execute(() =>
            start.mutateAsync({
              creatorId,
              requestLimit: limit,
              intervalMs: 1000,
            }),
          )
        }
      >
        开始整号互动同步
      </button>
      {error && <p role="alert">{error}</p>}
      {jobs.error && <p role="alert">覆盖状态读取失败，未开始新请求。</p>}
      {(jobs.data ?? []).map((job) => (
        <section key={job.id} className="my-2 min-w-0 border-t">
          <p className="break-all">
            状态：{job.state}；发现：{job.items.length}；列表结束：
            {job.listEnd ? '已返回结束' : '待补'}；请求：
            {job.budget?.used ?? '未知'}/{job.budget?.limit ?? '未知'}；
            {job.code}
          </p>
          <p>
            指标 {job.items.filter((i) => i.metrics).length}；主评论{' '}
            {job.items.filter((i) => i.top).length}；已知根回复{' '}
            {job.items.filter((i) => i.replies).length}；附页已保存{' '}
            {job.items.filter((i) => i.supplement === 'saved').length} / 待补{' '}
            {job.items.filter((i) => i.supplement !== 'saved').length}
          </p>
          <p>
            更新于 {new Date(job.updatedAt).toLocaleString()}
            。仅表示已发现可访问范围的互动阶段。
          </p>
          {job.code === 'XHS_REQUEST_BUDGET_EXHAUSTED' && (
            <button
              onClick={() =>
                void execute(() =>
                  extend.mutateAsync({ id: job.id, additional: limit }),
                )
              }
            >
              明确追加 {limit} 次请求并继续
            </button>
          )}
          {['paused', 'partial', 'failed', 'cancelled'].includes(job.state) && (
            <button
              disabled={!job.resumable}
              onClick={() =>
                void execute(() => resume.mutateAsync({ id: job.id }))
              }
            >
              按原预算续补
            </button>
          )}
          {['queued', 'running'].includes(job.state) && (
            <button
              onClick={() =>
                void execute(() => cancel.mutateAsync({ id: job.id }))
              }
            >
              取消
            </button>
          )}
          <details>
            <summary>逐篇事实与缺口</summary>
            <ul>
              {job.items.slice(page * 50, (page + 1) * 50).map((item) => (
                <li key={item.noteId} className="break-all">
                  {item.title || item.noteId}：{item.status} {item.stage}{' '}
                  {item.reason}；指标{' '}
                  {item.metrics
                    ? new Date(item.metrics).toLocaleString()
                    : '待补'}
                  ；主评 {item.top ? '已返回结束' : '待补'}；根回复{' '}
                  {item.replies ? '已返回结束' : '待补'}；附页
                  {item.supplement === 'saved' ? '已保存' : '待补'}
                  ；删除状态未知
                </li>
              ))}
            </ul>
            <button disabled={page === 0} onClick={() => setPage(page - 1)}>
              上一页
            </button>
            <span>清单第 {page + 1} 页，每页50篇</span>
            <button
              disabled={(page + 1) * 50 >= job.items.length}
              onClick={() => setPage(page + 1)}
            >
              下一页
            </button>
          </details>
        </section>
      ))}
    </details>
  );
}
