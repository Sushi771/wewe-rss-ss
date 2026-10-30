import {
  compileFilter,
  emptyCombinedFilter,
  metricLabels,
} from '@web/utils/xhs-combined-filter';
import type { CombinedFilter, Condition } from '@web/utils/xhs-combined-filter';
export default function XhsCombinedFilter({
  value,
  onChange,
  disabled = false,
}: {
  value: CombinedFilter;
  onChange: (value: CombinedFilter) => void;
  disabled?: boolean;
}) {
  const compiled = compileFilter(value);
  const update = (id: number, patch: Partial<Condition>) =>
    onChange({
      ...value,
      conditions: value.conditions.map((c) =>
        c.id === id ? { ...c, ...patch } : c,
      ),
    });
  return (
    <details className="xhs-combined-filter">
      <summary>筛选{value.conditions.length ? `（${value.conditions.length}）` : ''}</summary>
      <fieldset disabled={disabled} className="xhs-combined-controls">
        <legend className="sr-only">组合筛选条件</legend>
        <label>
          匹配方式{' '}
          <select
            aria-label="条件匹配方式"
            value={value.mode}
            onChange={(e) =>
              onChange({
                ...value,
                mode: e.target.value as CombinedFilter['mode'],
              })
            }
          >
            <option value="and">全部满足（AND）</option>
            <option value="or">任一满足（OR）</option>
          </select>
        </label>
        {value.conditions.map((c, index) => (
          <div key={c.id} className="xhs-condition-row">
            <span className="sr-only">条件 {index + 1}</span>
            <select
              aria-label={`条件 ${index + 1} 指标`}
              value={c.metric}
              onChange={(e) =>
                update(c.id, { metric: e.target.value as Condition['metric'] })
              }
            >
              {Object.entries(metricLabels).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
            <select
              aria-label={`条件 ${index + 1} 比较方式`}
              value={c.operator}
              onChange={(e) =>
                update(c.id, {
                  operator: e.target.value as Condition['operator'],
                })
              }
            >
              {['>', '>=', '<', '<='].map((op) => (
                <option key={op} value={op}>
                  {op}{' '}
                  {
                    {
                      '>': '大于',
                      '>=': '大于等于',
                      '<': '小于',
                      '<=': '小于等于',
                    }[op]
                  }
                </option>
              ))}
              <option value="between">区间（含两端）</option>
            </select>
            <input
              type="text"
              inputMode="decimal"
              aria-label={`条件 ${index + 1} ${c.operator === 'between' ? '下限' : '数值'}`}
              placeholder={c.operator === 'between' ? '下限' : '数值'}
              value={c.value}
              aria-invalid={!!compiled.errors[c.id]}
              aria-describedby={
                compiled.errors[c.id]
                  ? `xhs-condition-error-${c.id}`
                  : undefined
              }
              onChange={(e) => update(c.id, { value: e.target.value })}
            />
            {c.operator === 'between' && (
              <>
                <span>至</span>
                <input
                  type="text"
                  inputMode="decimal"
                  aria-label={`条件 ${index + 1} 上限`}
                  placeholder="上限"
                  value={c.upper}
                  aria-invalid={!!compiled.errors[c.id]}
                  aria-describedby={
                    compiled.errors[c.id]
                      ? `xhs-condition-error-${c.id}`
                      : undefined
                  }
                  onChange={(e) => update(c.id, { upper: e.target.value })}
                />
              </>
            )}
            <button
              type="button"
              aria-label={`删除条件 ${index + 1}`}
              onClick={() =>
                onChange({
                  ...value,
                  conditions: value.conditions.filter((row) => row.id !== c.id),
                })
              }
            >
              删除
            </button>
            {compiled.errors[c.id] && (
              <p id={`xhs-condition-error-${c.id}`} role="alert">
                条件 {index + 1}：{compiled.errors[c.id]}
              </p>
            )}
          </div>
        ))}
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() =>
              onChange({
                ...value,
                conditions: [
                  ...value.conditions,
                  {
                    id: Math.max(0, ...value.conditions.map((c) => c.id)) + 1,
                    metric: 'likes',
                    operator: '>=',
                    value: '',
                    upper: '',
                  },
                ],
              })
            }
          >
            添加条件
          </button>
          <button
            type="button"
            disabled={!value.conditions.length}
            onClick={() => onChange(emptyCombinedFilter())}
          >
            清空条件
          </button>
        </div>
      </fieldset>
    </details>
  );
}
