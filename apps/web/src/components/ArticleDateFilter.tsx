import { ArticleDateSelection } from '@web/utils/article-date-selection';

export default function ArticleDateFilter({
  value,
  onChange,
  error,
}: {
  value: ArticleDateSelection;
  onChange: (value: ArticleDateSelection) => void;
  error?: string;
}) {
  const fieldClass = 'min-w-0 rounded border bg-background px-2 py-1 text-sm';
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
      <span>原文发布日期（上海时间）</span>
      <select
        aria-label="日期筛选方式"
        className={fieldClass}
        value={value.mode}
        onChange={(event) =>
          onChange({
            ...value,
            mode: event.target.value as ArticleDateSelection['mode'],
          })
        }
      >
        <option value="day">单日</option>
        <option value="range">起止日期</option>
      </select>
      <label className="flex min-w-0 items-center gap-1">
        {value.mode === 'day' ? '日期' : '从'}
        <input
          type="date"
          aria-label={value.mode === 'day' ? '原文发布日期' : '开始日期'}
          min="1970-01-01"
          max="9999-12-31"
          className={fieldClass}
          value={value.start}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? 'article-date-error' : undefined}
          onChange={(event) =>
            onChange({ ...value, start: event.target.value })
          }
        />
      </label>
      {value.mode === 'range' && (
        <label className="flex min-w-0 items-center gap-1">
          至
          <input
            type="date"
            aria-label="结束日期"
            min="1970-01-01"
            max="9999-12-31"
            className={fieldClass}
            value={value.end}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'article-date-error' : undefined}
            onChange={(event) =>
              onChange({ ...value, end: event.target.value })
            }
          />
        </label>
      )}
      <button
        type="button"
        className="hover:bg-default-100 rounded px-2 py-1 text-sm disabled:opacity-40"
        disabled={!value.start && !value.end}
        onClick={() => onChange({ mode: value.mode, start: '', end: '' })}
      >
        清除日期
      </button>
      {error && (
        <span
          id="article-date-error"
          role="alert"
          className="w-full text-red-600"
        >
          {error}
        </span>
      )}
    </div>
  );
}
