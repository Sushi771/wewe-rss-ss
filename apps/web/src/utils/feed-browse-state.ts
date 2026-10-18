import {
  ArticleDateSelection,
  articleDateShortcut,
  isArticleDateShortcut,
} from './article-date-selection';

export type ArticleSort = 'publishTime' | 'readCount' | 'likeCount';
export interface FeedBrowseFilters {
  search: string;
  folderFilter: string;
  articleDates: ArticleDateSelection;
  articleDirection: 'asc' | 'desc';
  articleSort: ArticleSort;
}
export const FILTER_STORAGE_KEY = 'wewe.feed-browse.filters';
export const POSITION_STORAGE_KEY = 'wewe.feed-browse.positions';
const VERSION = 1;
export const MAX_RESTORE_PAGES = 10;
const FILTER_TTL = 30 * 86400000;
const POSITION_TTL = 8 * 3600000;
export const emptyBrowseFilters = (): FeedBrowseFilters => ({
  search: '',
  folderFilter: 'all',
  articleDates: { mode: 'day', start: '', end: '' },
  articleDirection: 'desc',
  articleSort: 'publishTime',
});

/** Storage can be disabled, full or unavailable; browsing must still work. */
export function browserStorage(
  kind: 'localStorage' | 'sessionStorage',
): Storage | undefined {
  try {
    return window[kind];
  } catch {
    return undefined;
  }
}
function read(storage: Storage | undefined, key: string): unknown {
  try {
    return JSON.parse(storage?.getItem(key) || 'null');
  } catch {
    return null;
  }
}
function write(storage: Storage | undefined, key: string, value: unknown) {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    /* best effort */
  }
}
function validDay(value: unknown): value is string {
  if (value === '') return true;
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value < '1970-01-01'
  )
    return false;
  const date = new Date(value + 'T00:00:00Z');
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}
function validFilters(raw: unknown, now: Date): FeedBrowseFilters | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as FeedBrowseFilters;
  const dates = value.articleDates;
  if (
    typeof value.search !== 'string' ||
    value.search.length > 2000 ||
    typeof value.folderFilter !== 'string' ||
    !value.folderFilter ||
    value.folderFilter.length > 200 ||
    !['asc', 'desc'].includes(value.articleDirection) ||
    !['publishTime', 'readCount', 'likeCount'].includes(value.articleSort) ||
    !dates ||
    !['day', 'range'].includes(dates.mode) ||
    !validDay(dates.start) ||
    !validDay(dates.end) ||
    (dates.shortcut !== undefined && !isArticleDateShortcut(dates.shortcut)) ||
    (dates.mode === 'range' &&
      dates.start &&
      dates.end &&
      dates.start > dates.end)
  )
    return null;
  return {
    search: value.search,
    folderFilter: value.folderFilter,
    articleDirection: value.articleDirection,
    articleSort: value.articleSort,
    articleDates: dates.shortcut
      ? {
          ...articleDateShortcut(dates.shortcut, now),
          shortcut: dates.shortcut,
        }
      : { mode: dates.mode, start: dates.start, end: dates.end },
  };
}
function fresh(time: unknown, ttl: number, now: number): time is number {
  return (
    typeof time === 'number' &&
    Number.isFinite(time) &&
    time <= now &&
    now - time < ttl
  );
}
export function readBrowseFilters(
  storage: Storage | undefined,
  now = new Date(),
): FeedBrowseFilters {
  const raw = read(storage, FILTER_STORAGE_KEY) as {
    version?: number;
    at?: number;
    filters?: unknown;
  } | null;
  return raw?.version === VERSION && fresh(raw.at, FILTER_TTL, now.getTime())
    ? validFilters(raw.filters, now) || emptyBrowseFilters()
    : emptyBrowseFilters();
}
export function saveBrowseFilters(
  storage: Storage | undefined,
  filters: FeedBrowseFilters,
  now = new Date(),
) {
  // Invalid/incomplete edits remain visible in the form, but do not survive a reload.
  if (validFilters(filters, now))
    write(storage, FILTER_STORAGE_KEY, {
      version: VERSION,
      at: now.getTime(),
      filters,
    });
}
export function initialBrowseFilters(
  storage: Storage | undefined,
  sourceId: string | undefined,
  query: string,
  now = new Date(),
): FeedBrowseFilters {
  const params = new URLSearchParams(query);
  // An explicit URL query is a complete view. Omitted fields use defaults, never an old keyword.
  const value = query ? emptyBrowseFilters() : readBrowseFilters(storage, now);
  if (sourceId) value.folderFilter = 'all';
  if (!query) return value;
  value.search = params.get('search') ?? params.get('q') ?? '';
  if (!sourceId) value.folderFilter = params.get('group') || 'all';
  value.articleDirection = params.get('direction') === 'asc' ? 'asc' : 'desc';
  const sort = params.get('sort');
  if (sort === 'readCount' || sort === 'likeCount') value.articleSort = sort;
  const shortcut = params.get('dateShortcut');
  if (shortcut && isArticleDateShortcut(shortcut))
    value.articleDates = { ...articleDateShortcut(shortcut, now), shortcut };
  else {
    const start = params.get('dateStart') || '',
      end = params.get('dateEnd') || '';
    value.articleDates = {
      mode:
        params.get('dateMode') === 'range' || (end && end !== start)
          ? 'range'
          : 'day',
      start,
      end,
    };
  }
  return validFilters(value, now) || emptyBrowseFilters();
}

export interface BrowsePosition {
  at: number;
  pages: number;
  top: number;
  anchor?: string;
  offset?: number;
}
function positionMap(
  storage: Storage | undefined,
  now = Date.now(),
): Record<string, BrowsePosition> {
  const raw = read(storage, POSITION_STORAGE_KEY) as {
    version?: number;
    entries?: Record<string, BrowsePosition>;
  } | null;
  if (
    raw?.version !== VERSION ||
    !raw.entries ||
    typeof raw.entries !== 'object'
  )
    return {};
  return Object.fromEntries(
    Object.entries(raw.entries)
      .filter(
        ([key, p]) =>
          key.length < 3000 &&
          p &&
          fresh(p.at, POSITION_TTL, now) &&
          Number.isInteger(p.pages) &&
          p.pages > 0 &&
          p.pages <= MAX_RESTORE_PAGES &&
          Number.isFinite(p.top) &&
          p.top >= 0 &&
          p.top <= 10000000 &&
          (p.anchor === undefined ||
            (typeof p.anchor === 'string' && p.anchor.length <= 200)) &&
          (p.offset === undefined ||
            (Number.isFinite(p.offset) && Math.abs(p.offset) <= 10000)),
      )
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, 8),
  );
}
export function readBrowsePosition(
  storage: Storage | undefined,
  key: string,
): BrowsePosition | undefined {
  return positionMap(storage)[key];
}
export function saveBrowsePosition(
  storage: Storage | undefined,
  key: string,
  value: Omit<BrowsePosition, 'at'>,
) {
  const entries = positionMap(storage);
  entries[key] = {
    ...value,
    pages: Math.max(1, Math.min(MAX_RESTORE_PAGES, value.pages)),
    at: Date.now(),
  };
  write(storage, POSITION_STORAGE_KEY, {
    version: VERSION,
    entries: Object.fromEntries(
      Object.entries(entries)
        .sort(([, a], [, b]) => b.at - a.at)
        .slice(0, 8),
    ),
  });
}
export function forgetBrowsePositions(storage: Storage | undefined) {
  try {
    storage?.removeItem(POSITION_STORAGE_KEY);
  } catch {
    /* best effort */
  }
}
