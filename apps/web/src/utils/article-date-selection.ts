import { ArticleFilter } from '@wewe-rss/shared';

export interface ArticleDateSelection {
  mode: 'day' | 'range';
  start: string;
  end: string;
}

export function dateSelectionFilter(
  value: ArticleDateSelection,
): ArticleFilter {
  return {
    dateStart: value.start || undefined,
    dateEnd: (value.mode === 'day' ? value.start : value.end) || undefined,
  };
}

export type ArticleDateShortcut = 'today' | 'last7' | 'month';

export function isArticleDateShortcut(
  value: string,
): value is ArticleDateShortcut {
  return value === 'today' || value === 'last7' || value === 'month';
}

/** Resolve at selection time, using Shanghai calendar days even on UTC hosts. */
export function articleDateShortcut(
  shortcut: ArticleDateShortcut,
  now: Date = new Date(),
): ArticleDateSelection {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) =>
    parts.find((item) => item.type === type)!.value;
  const today = `${part('year')}-${part('month')}-${part('day')}`;
  if (shortcut === 'today') return { mode: 'day', start: today, end: '' };
  // UTC arithmetic on the calendar label avoids host timezone and DST offsets.
  const start =
    shortcut === 'month'
      ? today.slice(0, 8) + '01'
      : new Date(Date.parse(today + 'T00:00:00Z') - 6 * 86400000)
          .toISOString()
          .slice(0, 10);
  return { mode: 'range', start, end: today };
}
