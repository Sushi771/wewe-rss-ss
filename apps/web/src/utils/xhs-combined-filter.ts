import type { MetricKey } from './xhs-metric-sort';
export type Condition = {
  id: number;
  metric: MetricKey;
  operator: '>' | '>=' | '<' | '<=' | 'between';
  value: string;
  upper: string;
};
export type CombinedFilter = { mode: 'and' | 'or'; conditions: Condition[] };
export const emptyCombinedFilter = (): CombinedFilter => ({
  mode: 'and',
  conditions: [],
});
export const metricLabels: Record<MetricKey, string> = {
  likes: '点赞',
  collects: '收藏',
  shares: '分享',
  comments: '评论',
};
type Parsed = {
  metric: MetricKey;
  operator: Condition['operator'];
  value: number;
  upper?: number;
};
export type CompiledFilter = {
  mode: CombinedFilter['mode'];
  conditions: Parsed[];
  errors: Record<number, string>;
  valid: boolean;
};
function number(value: string): number | undefined {
  const text = value.trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER
    ? n
    : undefined;
}
export function compileFilter(draft: CombinedFilter): CompiledFilter {
  const errors: Record<number, string> = {},
    conditions: Parsed[] = [];
  for (const c of draft.conditions) {
    const value = number(c.value),
      upper = c.operator === 'between' ? number(c.upper) : undefined;
    if (
      !Object.prototype.hasOwnProperty.call(metricLabels, c.metric) ||
      !['>', '>=', '<', '<=', 'between'].includes(c.operator)
    )
      errors[c.id] = '请选择有效的指标与比较方式。';
    else if (
      value === undefined ||
      (c.operator === 'between' && upper === undefined)
    )
      errors[c.id] = '请输入非负数，不含单位，且不超过安全数值范围。';
    else if (c.operator === 'between' && value > upper!)
      errors[c.id] = '区间下限不能大于上限。';
    else
      conditions.push({ metric: c.metric, operator: c.operator, value, upper });
  }
  return {
    mode: draft.mode,
    conditions,
    errors,
    valid: Object.keys(errors).length === 0,
  };
}
function matches(
  values: Record<string, number | null> | undefined,
  c: Parsed,
): boolean {
  const n = values?.[c.metric];
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return false;
  switch (c.operator) {
    case '>':
      return n > c.value;
    case '>=':
      return n >= c.value;
    case '<':
      return n < c.value;
    case '<=':
      return n <= c.value;
    case 'between':
      return n >= c.value && n <= c.upper!;
  }
}
/** Full scoped local result in, matched result out. Unknown values never become zero. */
export function filterNotes<
  T extends { metrics?: { values: Record<string, number | null> } | null },
>(rows: readonly T[], filter: CompiledFilter): T[] {
  if (!filter.valid) return [];
  if (!filter.conditions.length) return [...rows];
  return rows.filter((row) =>
    filter.mode === 'and'
      ? filter.conditions.every((c) => matches(row.metrics?.values, c))
      : filter.conditions.some((c) => matches(row.metrics?.values, c)),
  );
}
export function conditionLabel(c: Condition): string {
  return `${metricLabels[c.metric]} ${c.operator === 'between' ? `${c.value || '…'}–${c.upper || '…'}（含两端）` : `${c.operator} ${c.value || '…'}`}`;
}
