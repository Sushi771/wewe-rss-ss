import type { XhsMetricSnapshot } from '@wewe-rss/shared';
import { trpc } from '@web/utils/trpc';
import { useEffect, useRef, useState } from 'react';

export function XhsMetricLine({
  snapshot,
  creator = false,
  showUpdatedAt = true,
}: {
  snapshot: XhsMetricSnapshot | null;
  creator?: boolean;
  showUpdatedAt?: boolean;
}) {
  if (creator) {
    const fans = snapshot?.values.fans;
    const following = snapshot?.values.following;
    const collectedAt = snapshot?.collectedAt;
    const date = collectedAt != null && Number.isFinite(new Date(collectedAt).getTime())
      ? new Date(collectedAt).toLocaleString() : null;
    return (
      <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-sm text-foreground" aria-label="博主资料">
        <span>粉丝 <strong className="font-semibold tabular-nums">{fans == null ? '未采集' : new Intl.NumberFormat('zh-CN').format(fans)}</strong></span>
        {following != null && <span>关注 <strong className="font-semibold tabular-nums">{new Intl.NumberFormat('zh-CN').format(following)}</strong></span>}
        {showUpdatedAt && date && <span className="text-xs text-neutral-500">更新于 {date}</span>}
      </span>
    );
  }
  const fields = creator
    ? { fans: '粉丝', following: '关注' }
    : { likes: '赞', collects: '收藏', shares: '分享', comments: '评论' };
  return (
    <span
      className="text-default-500 text-xs"
      title={`历史快照 · ${snapshot ? new Date(snapshot.collectedAt).toLocaleString() : '未保存'} · ${snapshot?.evidence === 'verified-response' ? '已核响应' : '响应契约待核实'}`}
    >
      {Object.entries(fields)
        .filter(
          ([key]) =>
            !creator ||
            key !== 'following' ||
            snapshot?.values.following != null,
        )
        .map(
          ([key, label]) =>
            `${label} ${snapshot?.values[key] === null || snapshot?.values[key] === undefined ? '未知' : new Intl.NumberFormat('zh-CN').format(snapshot.values[key]!)}`,
        )
        .join(' · ')}
    </span>
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
  const alive = useRef(true),
    operation = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return (
    <div className="px-3 py-1 text-xs">
      <button
        disabled={!enabled || refresh.isLoading}
        onClick={async () => {
          if (operation.current || !alive.current) return;
          operation.current = true;
          setError('');
          try {
            await refresh.mutateAsync({ creatorId });
            if (!alive.current) return;
            await Promise.all([
              utils.xiaohongshu.list.invalidate(),
              utils.xiaohongshu.engagement.invalidate(),
            ]);
          } catch (cause) {
            if (!alive.current) return;
            setError(
              cause instanceof Error
                ? cause.message
                : '资料快照更新失败；原数据保留。',
            );
          } finally {
            operation.current = false;
          }
        }}
      >
        {refresh.isLoading ? '更新中' : '更新博主资料'}
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
export function XhsNumericFilter({
  value,
  onChange,
  creator = false,
  disabled = false,
}: {
  disabled?: boolean;
  value: XhsNumericFilterValue;
  onChange: (v: XhsNumericFilterValue) => void;
  creator?: boolean;
}) {
  const fields = creator
    ? { fans: '粉丝', following: '关注（契约待核实）' }
    : { likes: '点赞', collects: '收藏', shares: '分享', comments: '评论' };
  return (
    <details className="xhs-numeric-filter">
      <summary className="cursor-pointer">
        {creator ? '博主数值筛选' : '内容互动筛选'}
        {value.metric
          ? ` · ${fields[value.metric as keyof typeof fields] ?? ''} ${value.min ?? '不限'}–${value.max ?? '不限'}`
          : ' · 不限'}
      </summary>
      <fieldset
        disabled={disabled}
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
            {creator && (
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
            )}
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
        {value.metric && (
          <button type="button" onClick={() => onChange({})}>
            清除此条件
          </button>
        )}
      </fieldset>
    </details>
  );
}
