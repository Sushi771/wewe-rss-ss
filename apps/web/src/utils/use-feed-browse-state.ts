import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ArticleDateSelection,
  articleDateShortcut,
} from './article-date-selection';
import {
  ArticleSort,
  FeedBrowseFilters,
  browserStorage,
  emptyBrowseFilters,
  forgetBrowsePositions,
  initialBrowseFilters,
  saveBrowseFilters,
} from './feed-browse-state';

/** No route persistence: desktop home stays /feeds; only filters are remembered. */
export function useFeedBrowseState(sourceId?: string) {
  const location = useLocation();
  const navigate = useNavigate();
  const route = location.pathname + location.search;
  // A click inside a folder carries its browsing context. A direct source URL
  // still starts without an unrelated cached folder restriction.
  const folderContext =
    !location.search &&
    sourceId &&
    location.state?.feedId === sourceId &&
    typeof location.state?.feedFolder === 'string' &&
    location.state.feedFolder.length > 0 &&
    location.state.feedFolder.length <= 200
      ? location.state.feedFolder
      : undefined;
  const [state, setState] = useState(() => ({
    route,
    entryKey: location.key,
    filters: {
      ...initialBrowseFilters(
        browserStorage('sessionStorage'),
        sourceId,
        location.search,
      ),
      ...(folderContext ? { folderFilter: folderContext } : {}),
    },
    generation: 0,
  }));
  // The same URL may have multiple history entries with different folder context.
  // Derive each entry's state before queries render; never query with stale scope.
  const sameEntry = state.route === route && state.entryKey === location.key;
  const current = sameEntry
    ? state
    : {
        route,
        entryKey: location.key,
        filters: location.search
          ? initialBrowseFilters(undefined, sourceId, location.search)
          : {
              ...state.filters,
              folderFilter: sourceId
                ? folderContext || 'all'
                : state.filters.folderFilter,
            },
        generation: state.generation + 1,
      };
  if (!sameEntry) setState(current);
  const update = useCallback(
    <K extends keyof FeedBrowseFilters>(
      key: K,
      next:
        | FeedBrowseFilters[K]
        | ((value: FeedBrowseFilters[K]) => FeedBrowseFilters[K]),
    ) => {
      setState((previous) => ({
        ...previous,
        filters: {
          ...previous.filters,
          [key]:
            typeof next === 'function' ? next(previous.filters[key]) : next,
        },
      }));
    },
    [],
  );
  const setters = useMemo(
    () => ({
      setSearch: (value: string) => update('search', value),
      setFolderFilter: (value: string | ((previous: string) => string)) =>
        update('folderFilter', value),
      setArticleDates: (value: ArticleDateSelection) =>
        update('articleDates', value),
      setArticleDirection: (value: 'asc' | 'desc') =>
        update('articleDirection', value),
      setArticleSort: (value: ArticleSort) => update('articleSort', value),
    }),
    [update],
  );
  useEffect(() => {
    saveBrowseFilters(browserStorage('sessionStorage'), current.filters);
  }, [current.filters]);
  useEffect(() => {
    const resolve = () =>
      setState((previous) => {
        const shortcut = previous.filters.articleDates.shortcut;
        if (!shortcut) return previous;
        const dates = { ...articleDateShortcut(shortcut), shortcut };
        return JSON.stringify(dates) ===
          JSON.stringify(previous.filters.articleDates)
          ? previous
          : {
              ...previous,
              filters: { ...previous.filters, articleDates: dates },
            };
      });
    const timer = window.setInterval(resolve, 60000);
    window.addEventListener('focus', resolve);
    document.addEventListener('visibilitychange', resolve);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', resolve);
      document.removeEventListener('visibilitychange', resolve);
    };
  }, []);
  const clearBrowseState = useCallback(() => {
    forgetBrowsePositions(browserStorage('sessionStorage'));
    if (location.search) navigate(location.pathname, { replace: true });
    setState((previous) => ({
      ...previous,
      filters: emptyBrowseFilters(),
      generation: previous.generation + 1,
    }));
  }, [location.search, location.pathname, navigate]);
  return {
    ...current.filters,
    ...setters,
    clearBrowseState,
    browseGeneration: current.generation,
  };
}
