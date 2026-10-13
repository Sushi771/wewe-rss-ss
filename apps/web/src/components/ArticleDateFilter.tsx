import { CalendarDate } from '@internationalized/date';
import { useState } from 'react';
import {
  Button,
  Calendar,
  NextUIProvider,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@nextui-org/react';
import {
  ArticleDateSelection,
  articleDateShortcut,
  isArticleDateShortcut,
} from '@web/utils/article-date-selection';

// Parse persisted calendar labels without converting through the host timezone.
function calendarDate(label: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(label)) return null;
  const [year, month, day] = label.split('-').map(Number);
  const date = new CalendarDate(year, month, day);
  return date.toString() === label && year >= 1970 ? date : null;
}

function DateCalendarButton({
  label,
  value,
  defaultDate,
  error,
  onChange,
}: {
  label: string;
  value: string;
  defaultDate: string;
  error?: string;
  onChange: (date: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      isOpen={open}
      onOpenChange={setOpen}
      placement="bottom-start"
      disableAnimation
      shouldFlip
      offset={6}
    >
      <PopoverTrigger>
        <Button
          size="sm"
          variant="bordered"
          className="h-8 min-w-0 shrink-0 gap-1 px-2 text-xs"
          aria-label={`${label}，${value || '未选择'}，打开日历`}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? 'article-date-error' : undefined}
        >
          <svg
            aria-hidden="true"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <rect x="3" y="5" width="18" height="16" rx="2" />
            <path d="M16 3v4M8 3v4M3 11h18" />
          </svg>
          <span>{value || label}</span>
          <span>日历</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="max-h-[calc(100dvh-24px)] max-w-[calc(100vw-16px)] overflow-y-auto p-1">
        {/* Scope Chinese month/week labels to this calendar, preserving app locale. */}
        <NextUIProvider locale="zh-CN" disableAnimation>
          <Calendar
            aria-label={`${label}日历`}
            value={calendarDate(value)}
            defaultFocusedValue={
              calendarDate(value) || calendarDate(defaultDate)!
            }
            minValue={new CalendarDate(1970, 1, 1)}
            maxValue={new CalendarDate(9999, 12, 31)}
            calendarWidth={256}
            disableAnimation
            prevButtonProps={{ 'aria-label': '上个月' }}
            nextButtonProps={{ 'aria-label': '下个月' }}
            onChange={(date) => {
              onChange(date.toString());
              setOpen(false);
            }}
          />
        </NextUIProvider>
      </PopoverContent>
    </Popover>
  );
}

export default function ArticleDateFilter({
  value,
  onChange,
  error,
}: {
  value: ArticleDateSelection;
  onChange: (value: ArticleDateSelection) => void;
  error?: string;
}) {
  const today = articleDateShortcut('today').start;
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
      <span>原文发布日期（上海时间）</span>
      <select
        aria-label="日期筛选方式"
        className="bg-background min-w-0 rounded border px-2 py-1 text-sm"
        value={value.shortcut || value.mode}
        onChange={(event) => {
          const mode = event.target.value;
          if (isArticleDateShortcut(mode))
            onChange({ ...articleDateShortcut(mode), shortcut: mode });
          else
            onChange({
              ...value,
              mode: mode as ArticleDateSelection['mode'],
              shortcut: undefined,
            });
        }}
      >
        <option value="day">单日</option>
        <option value="range">起止日期</option>
        <optgroup label="快捷日期（上海时间）">
          <option value="today">今天</option>
          <option value="last7">近7天（含今天）</option>
          <option value="month">本月（截至今天）</option>
        </optgroup>
      </select>
      <DateCalendarButton
        key={`start-${value.mode}`}
        label={value.mode === 'day' ? '原文发布日期' : '开始日期'}
        value={value.start}
        defaultDate={value.end || today}
        error={error}
        onChange={(start) => onChange({ ...value, start, shortcut: undefined })}
      />
      {value.mode === 'range' && (
        <>
          <span>至</span>
          <DateCalendarButton
            label="结束日期"
            value={value.end}
            defaultDate={value.start || today}
            error={error}
            onChange={(end) => onChange({ ...value, end, shortcut: undefined })}
          />
        </>
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
