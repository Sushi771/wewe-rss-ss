import type { XhsEngagementView, XhsMetricSnapshot } from '@wewe-rss/shared';
import { trpc } from '@web/utils/trpc';
import { useState } from 'react';

export function XhsMetricLine({
  snapshot,
  creator = false,
}: {
  snapshot: XhsMetricSnapshot | null;
  creator?: boolean;
}) {
  if (!snapshot || !Object.values(snapshot.values).some((v) => v !== null))
    return null;
  const fields = creator
    ? { fans: '粉丝', following: '关注' }
    : { likes: '赞', collects: '收藏', shares: '分享', comments: '评论' };
  return (
    <span
      className="text-default-500 text-xs"
      title={`历史快照 · ${new Date(snapshot.collectedAt).toLocaleString()} · 真实响应待核实`}
    >
      {Object.entries(fields)
        .map(
          ([key, label]) =>
            `${label} ${snapshot.values[key] === null || snapshot.values[key] === undefined ? '未知' : new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(snapshot.values[key]!)}`,
        )
        .join(' · ')}
    </span>
  );
}
export function XhsEngagementPanel({
  creatorId,
  noteId,
  initial,
  canCollectComments = false,
  canRefreshMetrics = false,
}: {
  creatorId: string;
  noteId: string;
  initial: XhsEngagementView;
  canCollectComments?: boolean;
  canRefreshMetrics?: boolean;
}) {
  const utils = trpc.useUtils();
  const collect = trpc.xiaohongshu.collectComments.useMutation({
    retry: false,
  });
  const refresh = trpc.xiaohongshu.refreshMetrics.useMutation({ retry: false });
  const [maxPages, setMaxPages] = useState(1),
    [maxItems, setMaxItems] = useState(100);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false),
    [offset, setOffset] = useState(0);
  const saved = trpc.xiaohongshu.engagement.useQuery(
    { creatorId, noteId, offset, limit: 200 },
    { enabled: open, retry: false, refetchOnWindowFocus: false },
  );
  const view = saved.data ?? initial;
  const busy = collect.isLoading || refresh.isLoading;
  const collectWindow = async (rootId?: string, restart = false) => {
    setError('');
    try {
      await collect.mutateAsync({
        creatorId,
        noteId,
        rootId,
        maxPages,
        maxItems,
        restart,
      });
      await utils.xiaohongshu.engagement.invalidate({ creatorId, noteId });
      await utils.xiaohongshu.body.invalidate({ creatorId, noteId });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : '评论采集未完成，已保存范围保留。',
      );
    }
  };
  return (
    <section
      className="border-default-200 space-y-3 border-t py-4"
      aria-label="小红书保存的互动数据"
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button
          disabled={!canRefreshMetrics || busy}
          onClick={async () => {
            setError('');
            try {
              await refresh.mutateAsync({ creatorId, noteId });
              await Promise.all([
                utils.xiaohongshu.body.invalidate({ creatorId, noteId }),
                utils.xiaohongshu.engagement.invalidate({ creatorId, noteId }),
                utils.xiaohongshu.notes.invalidate(),
              ]);
            } catch (cause) {
              setError(
                cause instanceof Error
                  ? cause.message
                  : '快照刷新失败；原数据保留。',
              );
            }
          }}
        >
          更新互动快照
        </button>
        <label>
          本次最多{' '}
          <select
            aria-label="评论页数上限"
            value={maxPages}
            disabled={busy}
            onChange={(e) => setMaxPages(Number(e.target.value))}
          >
            {[1, 2, 5].map((n) => (
              <option key={n} value={n}>
                {n} 页
              </option>
            ))}
          </select>
        </label>
        <label>
          <select
            aria-label="评论条数上限"
            value={maxItems}
            disabled={busy}
            onChange={(e) => setMaxItems(Number(e.target.value))}
          >
            {[50, 100, 200].map((n) => (
              <option key={n} value={n}>
                {n} 条
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={!canCollectComments || busy}
          onClick={() =>
            void collectWindow(
              undefined,
              view.windows.some(
                (w) => w.scope === 'top' && w.state === 'returned-end',
              ),
            )
          }
        >
          {busy
            ? '处理中'
            : view.windows.some(
                  (w) => w.scope === 'top' && w.state === 'returned-end',
                )
              ? '从首更新顶层评论'
              : '保存/继续顶层评论'}
        </button>
      </div>
      <p className="text-default-500 text-xs">
        {canCollectComments
          ? '仅本次显式获取顶层范围；楼中回复需逐楼操作。响应契约尚待真实验证。'
          : '评论采集默认关闭；响应契约待真实验证。'}
        新增本地评论请再次保存；变化会生成“互动与评论”附页，已有正文保留。
      </p>
      {error && (
        <p role="alert" className="text-xs">
          {error}
        </p>
      )}
      {view.metrics &&
        Object.values(view.metrics.values).some((v) => v !== null) && (
          <div>
            <XhsMetricLine snapshot={view.metrics} />
            <p className="text-default-500 text-xs">
              历史快照 · 采集于{' '}
              {new Date(view.metrics.collectedAt).toLocaleString()} ·
              公开源码契约，真实响应待核实
            </p>
          </div>
        )}
      {view.creatorMetrics &&
        Object.values(view.creatorMetrics.values).some((v) => v !== null) && (
          <aside aria-label="博主资料快照">
            <XhsMetricLine snapshot={view.creatorMetrics} creator />
            <p className="text-default-500 text-xs">
              资料采集于{' '}
              {new Date(view.creatorMetrics.collectedAt).toLocaleString()}
            </p>
          </aside>
        )}
      {(view.totalSaved > 0 || view.windows.length > 0) && (
        <details onToggle={(event) => setOpen(event.currentTarget.open)}>
          <summary className="cursor-pointer text-sm">
            已保存评论 {view.totalSaved} 条
          </summary>
          <p className="text-default-500 py-2 text-xs">
            仅展示已返回范围；顶层返回结束不表示所有回复已获取。隐藏、删除的评论可能不可得。
          </p>
          {view.windows.map((w) => (
            <p key={w.scope} className="text-default-500 text-xs">
              {w.scope === 'top' ? '顶层' : `根评论 ${w.scope}`} · {w.pages} 页
              ·{' '}
              {w.state === 'returned-end'
                ? '该接口返回结束'
                : w.state === 'failed'
                  ? '失败，保留部分结果'
                  : '部分'}{' '}
              · {new Date(w.collectedAt).toLocaleString()}
              {w.code ? ` · ${w.code}` : ''}
            </p>
          ))}
          {saved.error && (
            <p role="alert">已保存评论读取失败，可重新展开重试。</p>
          )}
          <ol className="space-y-4 py-3">
            {view.comments.map((c) => (
              <li
                key={c.id}
                className={
                  c.rootId ? 'border-default-200 ml-4 border-l pl-3' : ''
                }
              >
                <p className="text-default-500 text-xs">
                  {c.authorName ?? '未知作者'} · 赞 {c.likes ?? '未知'} ·{' '}
                  {c.publishedAt === null
                    ? '发布时间未知'
                    : new Date(c.publishedAt).toLocaleString()}
                </p>
                {c.rootId && (
                  <p className="text-default-500 break-all text-xs">
                    所属根评论 {c.rootId}；精确回复对象{c.parentId ?? '未知'}
                  </p>
                )}
                <p className="whitespace-pre-wrap break-words text-sm">
                  {c.content}
                </p>
                {!c.rootId && (
                  <button
                    className="text-xs"
                    disabled={!canCollectComments || busy}
                    onClick={() =>
                      void collectWindow(
                        c.id,
                        view.windows.some(
                          (w) =>
                            w.scope === `root:${c.id}` &&
                            w.state === 'returned-end',
                        ),
                      )
                    }
                  >
                    保存/更新此楼回复（本次有界）
                  </button>
                )}
              </li>
            ))}
          </ol>
          <div className="flex gap-3 text-xs">
            {offset > 0 && (
              <button onClick={() => setOffset(Math.max(0, offset - 200))}>
                上一页已保存评论
              </button>
            )}
            {offset + view.returned < view.totalSaved && (
              <button onClick={() => setOffset(offset + 200)}>
                下一页已保存评论
              </button>
            )}
          </div>
        </details>
      )}
    </section>
  );
}
export type XhsNumericFilterValue = {
  metric?: 'likes' | 'collects' | 'shares' | 'comments' | 'fans' | 'following';
  min?: number;
  max?: number;
  metricDirection?: 'asc' | 'desc';
};
export function XhsCreatorMetricRefresh({
  creatorId,
  enabled,
}: {
  creatorId: string;
  enabled: boolean;
}) {
  const utils = trpc.useUtils(),
    refresh = trpc.xiaohongshu.refreshMetrics.useMutation({ retry: false });
  const [error, setError] = useState('');
  return (
    <div className="px-3 py-1 text-xs">
      <button
        disabled={!enabled || refresh.isLoading}
        onClick={async () => {
          setError('');
          try {
            await refresh.mutateAsync({ creatorId });
            await Promise.all([
              utils.xiaohongshu.list.invalidate(),
              utils.xiaohongshu.body.invalidate(),
              utils.xiaohongshu.engagement.invalidate(),
            ]);
          } catch (cause) {
            setError(
              cause instanceof Error
                ? cause.message
                : '资料快照更新失败；原数据保留。',
            );
          }
        }}
      >
        {refresh.isLoading ? '更新中' : '更新当前博主资料快照'}
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
export function XhsNumericFilter({
  value,
  onChange,
  creator = false,
}: {
  value: XhsNumericFilterValue;
  onChange: (v: XhsNumericFilterValue) => void;
  creator?: boolean;
}) {
  const fields = creator
    ? { fans: '粉丝', following: '关注（契约待核实）' }
    : { likes: '点赞', collects: '收藏', shares: '分享', comments: '评论' };
  return (
    <details className="px-3 py-1 text-xs">
      <summary className="cursor-pointer">
        {creator ? '博主数值筛选' : '内容互动筛选'}
        {value.metric ? ' · 已启用' : ''}
      </summary>
      <fieldset
        className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs"
        aria-label={creator ? '博主数值筛选' : '内容互动筛选'}
      >
        <select
          aria-label="筛选指标"
          value={value.metric ?? ''}
          onChange={(e) =>
            onChange({
              ...value,
              metric: (e.target.value ||
                undefined) as XhsNumericFilterValue['metric'],
              min: undefined,
              max: undefined,
            })
          }
          className="border-default-200 max-w-full rounded border bg-transparent p-1"
        >
          <option value="">{creator ? '博主指标' : '互动指标'}</option>
          {Object.entries(fields).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        {value.metric && (
          <>
            <input
              aria-label="最小值"
              type="number"
              min="0"
              step="1"
              placeholder="最小值"
              className="border-default-200 w-20 rounded border bg-transparent p-1"
              value={value.min ?? ''}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (!e.target.value || (Number.isSafeInteger(n) && n >= 0))
                  onChange({ ...value, min: e.target.value ? n : undefined });
              }}
            />
            <span>至</span>
            <input
              aria-label="最大值"
              type="number"
              min="0"
              step="1"
              placeholder="最大值"
              className="border-default-200 w-20 rounded border bg-transparent p-1"
              value={value.max ?? ''}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (!e.target.value || (Number.isSafeInteger(n) && n >= 0))
                  onChange({ ...value, max: e.target.value ? n : undefined });
              }}
            />
            <select
              aria-label="指标排序"
              value={value.metricDirection ?? 'desc'}
              onChange={(e) =>
                onChange({
                  ...value,
                  metricDirection: e.target.value as 'asc' | 'desc',
                })
              }
              className="border-default-200 rounded border bg-transparent p-1"
            >
              <option value="desc">从高到低</option>
              <option value="asc">从低到高</option>
            </select>
            {value.min !== undefined &&
              value.max !== undefined &&
              value.min > value.max && (
                <span role="alert">最小值不可大于最大值</span>
              )}
            <span className="text-default-500">
              平台已保存范围 · 未知排末；区间筛选排除未知
            </span>
          </>
        )}
      </fieldset>
    </details>
  );
}
