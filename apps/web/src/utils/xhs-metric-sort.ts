export function nextTimeOrder(current: 'asc' | 'desc' | null, metricActive: boolean): 'asc' | 'desc' | null {
  return metricActive || !current ? 'asc' : current === 'asc' ? 'desc' : null;
}
export type MetricKey = 'likes' | 'collects' | 'shares' | 'comments';
export type MetricOrder = {
  metric: MetricKey;
  direction: 'asc' | 'desc';
} | null;
export function nextMetricOrder(
  current: MetricOrder,
  metric: MetricKey,
): MetricOrder {
  return current?.metric !== metric
    ? { metric, direction: 'desc' }
    : current.direction === 'desc'
      ? { metric, direction: 'asc' }
      : null;
}
type Row = {
  id: string;
  publishTime: number;
  metrics?: { values: Partial<Record<MetricKey, number | null>> } | null;
};
/** Apply to the complete filtered result before slicing the visible page. */
export function orderNotes<T extends Row>(
  rows: readonly T[],
  order: MetricOrder,
  timeDirection: 'asc' | 'desc',
): T[] {
  return [...rows].sort((a, b) => {
    const av = order ? a.metrics?.values[order.metric] : a.publishTime || null;
    const bv = order ? b.metrics?.values[order.metric] : b.publishTime || null;
    const validA = typeof av === 'number' && Number.isFinite(av);
    const validB = typeof bv === 'number' && Number.isFinite(bv);
    if (!validA || !validB)
      return validA === validB ? a.id.localeCompare(b.id) : validA ? -1 : 1;
    return (
      ((order?.direction ?? timeDirection) === 'asc' ? av - bv : bv - av) ||
      a.id.localeCompare(b.id)
    );
  });
}
