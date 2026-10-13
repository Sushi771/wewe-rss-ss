import { useCallback, useEffect, useRef, useState } from 'react';
import { markArticleText, readerDocument } from '../utils/article-reader-find';

interface ArticleReaderProps {
  contentHtml: string;
  findOpen: boolean;
  onFindOpenChange: (open: boolean) => void;
}

export default function ArticleReader({
  contentHtml,
  findOpen,
  onFindOpenChange,
}: ArticleReaderProps) {
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const prefix = useRef(`wewe-find-${crypto.randomUUID()}`);
  const [keyword, setKeyword] = useState('');
  const [result, setResult] = useState({
    url: '',
    ids: [] as string[],
    truncated: false,
  });
  const [active, setActive] = useState(0);
  const [searching, setSearching] = useState(false);
  const closeFind = useCallback(() => {
    onFindOpenChange(false);
    setKeyword('');
    trigger.current?.focus();
  }, [onFindOpenChange]);
  const navigate = useCallback(
    (direction: number) => {
      setActive((index) =>
        result.ids.length
          ? (index + direction + result.ids.length) % result.ids.length
          : 0,
      );
    },
    [result.ids.length],
  );

  useEffect(() => {
    if (findOpen) input.current?.focus();
  }, [findOpen]);

  useEffect(() => {
    let objectUrl = '';
    let cancelled = false;
    setActive(0);
    setSearching(true);
    const render = () => {
      if (cancelled) return;
      const marked = markArticleText(
        document,
        contentHtml,
        findOpen ? keyword : '',
        prefix.current,
      );
      objectUrl = URL.createObjectURL(
        new Blob([readerDocument(marked.html, document.baseURI)], {
          type: 'text/html;charset=utf-8',
        }),
      );
      setResult({
        url: objectUrl,
        ids: marked.ids,
        truncated: marked.truncated,
      });
      setSearching(false);
    };
    // Initial/unmarked rendering is immediate; debounce typing and IME updates.
    const timer =
      findOpen && keyword ? window.setTimeout(render, 120) : undefined;
    if (!timer) render();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [contentHtml, findOpen, keyword]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        event.stopImmediatePropagation();
        onFindOpenChange(true);
        input.current?.focus();
      } else if (findOpen && event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeFind();
      } else if (
        findOpen &&
        event.key === 'Enter' &&
        event.target === input.current
      ) {
        event.preventDefault();
        if (!searching) navigate(event.shiftKey ? -1 : 1);
      }
    };
    // Capture reserves Escape before React Aria dismisses the enclosing Modal.
    // An opaque sandbox frame cannot relay keyboard events; find keeps input focus.
    document.addEventListener('keydown', keydown, true);
    return () => document.removeEventListener('keydown', keydown, true);
  }, [closeFind, findOpen, navigate, onFindOpenChange, searching]);

  return (
    <div className="min-w-0">
      <button
        ref={trigger}
        type="button"
        aria-expanded={findOpen}
        onClick={() => (findOpen ? closeFind() : onFindOpenChange(true))}
        className="hover:bg-default-100 mb-2 rounded px-2 py-1 text-sm"
      >
        正文内查找
      </button>
      {findOpen && (
        <div
          role="search"
          aria-label="当前文章正文内查找"
          className="mb-2 flex flex-wrap items-center gap-2 rounded border p-2 text-sm"
        >
          <input
            ref={input}
            aria-label="查找正文关键词"
            placeholder="查找关键词"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            className="min-w-0 flex-1 rounded border bg-transparent px-2 py-1"
          />
          <output
            aria-live="polite"
            className="whitespace-nowrap"
            title={
              result.truncated
                ? '匹配较多，仅显示前5000处；请输入更长关键词。'
                : undefined
            }
          >
            {searching
              ? '查找中…'
              : !keyword
                ? '输入关键词'
                : result.ids.length
                  ? `${active + 1} / ${result.ids.length}${result.truncated ? '+' : ''}`
                  : '0 处匹配'}
          </output>
          <button
            type="button"
            aria-label="上一处匹配"
            disabled={searching || !result.ids.length}
            onClick={() => navigate(-1)}
            className="rounded border px-2 py-1 disabled:opacity-40"
          >
            ↑
          </button>
          <button
            type="button"
            aria-label="下一处匹配"
            disabled={searching || !result.ids.length}
            onClick={() => navigate(1)}
            className="rounded border px-2 py-1 disabled:opacity-40"
          >
            ↓
          </button>
          <button
            type="button"
            aria-label="关闭正文查找"
            onClick={closeFind}
            className="rounded border px-2 py-1"
          >
            ×
          </button>
        </div>
      )}
      <iframe
        title="已保存文章正文"
        sandbox=""
        referrerPolicy="no-referrer"
        className="h-[65vh] w-full rounded border bg-white"
        src={
          result.url
            ? `${result.url}${result.ids[active] && !searching ? `#${result.ids[active]}` : ''}`
            : undefined
        }
      />
    </div>
  );
}
