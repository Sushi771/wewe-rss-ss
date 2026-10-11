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
