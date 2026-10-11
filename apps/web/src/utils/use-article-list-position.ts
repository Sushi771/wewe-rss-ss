import { useCallback, useEffect, useRef } from 'react';
import {
  browserStorage,
  readBrowsePosition,
  saveBrowsePosition,
  BrowsePosition,
} from './feed-browse-state';

interface ListPositionOptions {
  viewKey: string;
  pageCount: number;
  itemCount: number;
  loading: boolean;
  fetching: boolean;
  hasNext: boolean;
  failed: boolean;
  loadNext: () => Promise<unknown>;
  paused: boolean;
}
/** Bounded, sequential reads of local list pages; never opens a reader or selects a row. */
export function useArticleListPosition(options: ListPositionOptions) {
  const {
    viewKey,
    pageCount,
    itemCount,
    loading,
    fetching,
    hasNext,
    failed,
    loadNext,
    paused,
  } = options;
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastPosition = useRef<BrowsePosition>();
  const latest = useRef(options);
  latest.current = options;
  const active = useRef({
    key: options.viewKey,
    pending: readBrowsePosition(
      browserStorage('sessionStorage'),
      options.viewKey,
    ),
    done: false,
    requesting: false,
  });
  if (active.current.key !== options.viewKey)
    active.current = {
      key: options.viewKey,
      pending: readBrowsePosition(
        browserStorage('sessionStorage'),
        options.viewKey,
      ),
      done: false,
      requesting: false,
    };
  const capturePosition = useCallback(() => {
    if (
      !active.current.done ||
      latest.current.paused ||
      !scrollRef.current ||
      latest.current.loading
    )
      return;
    const element = scrollRef.current,
      rect = element.getBoundingClientRect();
    const rows = Array.from(
      element.querySelectorAll<HTMLElement>('[data-article-id]'),
    );
    const anchor = rows.find(
      (row) => row.getBoundingClientRect().bottom > rect.top,
    );
    const snapshot = {
      pages: latest.current.pageCount || 1,
      top: element.scrollTop,
      anchor: anchor?.dataset.articleId,
      offset: anchor
        ? anchor.getBoundingClientRect().top - rect.top
        : undefined,
    };
    lastPosition.current = { ...snapshot, at: Date.now() };
    saveBrowsePosition(
      browserStorage('sessionStorage'),
      latest.current.viewKey,
      snapshot,
    );
  }, []);
  const cancelRestore = useCallback(() => {
    active.current.done = true;
    active.current.pending = undefined;
  }, []);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const cancel = () => cancelRestore();
    const key = (event: KeyboardEvent) => {
      if (
        [
          'ArrowDown',
          'ArrowUp',
          'PageDown',
          'PageUp',
          'Home',
          'End',
          ' ',
        ].includes(event.key)
      )
        cancel();
    };
    element.addEventListener('wheel', cancel, { passive: true });
    element.addEventListener('touchstart', cancel, { passive: true });
    element.addEventListener('pointerdown', cancel);
    element.addEventListener('keydown', key);
    window.addEventListener('pagehide', capturePosition);
    return () => {
      element.removeEventListener('wheel', cancel);
      element.removeEventListener('touchstart', cancel);
      element.removeEventListener('pointerdown', cancel);
      element.removeEventListener('keydown', key);
      window.removeEventListener('pagehide', capturePosition);
    };
  }, [capturePosition, cancelRestore]);
  useEffect(() => {
    const state = active.current,
      element = scrollRef.current;
    if (!element || paused) return;
    if (state.done) {
      capturePosition();
      return;
    }
    const target = state.pending;
    if (!target) {
      element.scrollTop = 0;
      state.done = true;
      return;
    }
    if (failed) {
      state.done = true;
      return;
    }
    if (loading || fetching || !pageCount) return;
    if (pageCount < target.pages && hasNext) {
      if (state.requesting) return;
      state.requesting = true;
      void loadNext()
        .catch(() => {
          if (active.current === state) state.done = true;
        })
        .finally(() => {
          state.requesting = false;
        });
      return;
    }
    // Wait for loaded row geometry; cancel the old view's frame on every update.
    const frame = requestAnimationFrame(() => {
      if (active.current !== state || state.done) return;
      const anchor = Array.from(
        element.querySelectorAll<HTMLElement>('[data-article-id]'),
      ).find((row) => row.dataset.articleId === target.anchor);
      element.scrollTop = !itemCount
        ? 0
        : anchor
          ? element.scrollTop +
            anchor.getBoundingClientRect().top -
            element.getBoundingClientRect().top -
            (target.offset || 0)
          : target.top;
      state.done = true;
      capturePosition();
    });
    return () => cancelAnimationFrame(frame);
  }, [
    viewKey,
    pageCount,
    itemCount,
    loading,
    fetching,
    hasNext,
    failed,
    loadNext,
    paused,
    capturePosition,
  ]);
  const readerPosition = useRef<ReturnType<typeof readBrowsePosition>>();
  const rememberForReader = useCallback(() => {
    capturePosition();
    readerPosition.current = lastPosition.current;
  }, [capturePosition]);
  const restoreAfterReader = useCallback(() => {
    if (!readerPosition.current) return;
    active.current.pending = readerPosition.current;
    active.current.done = false;
    readerPosition.current = undefined;
  }, []);
  return {
    scrollRef,
    capturePosition,
    cancelRestore,
    rememberForReader,
    restoreAfterReader,
  };
}
