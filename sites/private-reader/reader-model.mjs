import {
  createSitesClient,
  sitesDownloadBlob,
} from '../../scripts/sites-local-contract.mjs';

const readActions = new Set(['authors', 'items', 'body', 'download']);
const failure = (code) => Object.assign(new Error(code), { code });
export const statusCopy = Object.freeze({
  unconfigured: '私人身份与本机连接尚未配置。',
  'sign-in': '请使用本人账号登录后阅读。',
  forbidden: '当前账号无权访问这些私人订阅。',
  offline: '本机当前不可用，暂时无法读取缓存。',
  timeout: '连接超时，本次读取未完成。',
  'cache-missing': '这篇文章的完整图文尚未缓存，请在本机查看。',
  'source-unavailable': '这个来源目前不可用。',
  failed: '本次读取未完成，请重新读取订阅。',
});
const errorState = (code) =>
  ({
    IDENTITY_UNCONFIGURED: 'unconfigured',
    UNAUTHORIZED: 'sign-in',
    FORBIDDEN: 'forbidden',
    PC_UNAVAILABLE: 'offline',
    REQUEST_TIMEOUT: 'timeout',
    CACHE_UNAVAILABLE: 'cache-missing',
    CACHE_ADAPTER_UNCONFIGURED: 'unconfigured',
    SOURCE_UNAVAILABLE: 'source-unavailable',
  })[code] || 'failed';

/** Same-origin contract client with a finite browser deadline, no retry and no
 * backend address/credential option. The original command/response validator is
 * reused, not reimplemented. */
export function createReaderRequest({
  fetchImpl = globalThis.fetch,
  timeoutMs = 6500,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000)
    throw failure('BAD_REQUEST');
  return async (command, { signal } = {}) => {
    if (!readActions.has(command?.action)) throw failure('BAD_REQUEST');
    if (signal?.aborted) throw failure('CANCELLED');
    const controller = new AbortController();
    let timedOut = false;
    let cancelled = false;
    let timer;
    let cancel;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(failure('REQUEST_TIMEOUT'));
      }, timeoutMs);
      cancel = () => {
        cancelled = true;
        controller.abort();
        reject(failure('CANCELLED'));
      };
    });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const client = createSitesClient((endpoint, options) =>
      fetchImpl(endpoint, { ...options, signal: controller.signal }),
    );
    try {
      return await Promise.race([client(command), deadline]);
    } catch (caught) {
      if (cancelled) throw failure('CANCELLED');
      if (timedOut) throw failure('REQUEST_TIMEOUT');
      throw caught;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  };
}

const initial = (platform = 'wechat') => ({
  platform,
  status: 'idle',
  authors: [],
  items: [],
  author: null,
  item: null,
  body: null,
  nextAuthors: null,
  nextItems: null,
  truncated: false,
});

/** Browser-memory view state only. Authentication is always checked by the
 * Worker and local seam; no state value can grant access. */
export function createReaderController({ request, onState = () => {} }) {
  let state = initial();
  let generation = 0;
  let pending;
  const publish = (next) => {
    state = next;
    onState(state);
  };
  async function run(command, apply, resultValue = (value) => value) {
    const own = ++generation;
    pending?.abort();
    pending = new AbortController();
    publish({ ...state, status: 'loading' });
    try {
      const result = await request(command, { signal: pending.signal });
      if (own !== generation) return null;
      publish({ ...state, status: 'ready', ...apply(result) });
      return resultValue(result);
    } catch (caught) {
      if (own !== generation) return null;
      // Never leave old private content visible after an auth or connection
      // failure, and never convert an unavailable PC into an empty success.
      publish({ ...initial(state.platform), status: errorState(caught?.code) });
      return null;
    }
  }
  const loadItems = (author, cursor) => {
    publish({
      ...state,
      author,
      item: null,
      body: null,
      items: [],
      nextItems: null,
    });
    return run(
      {
        action: 'items',
        platform: state.platform,
        authorId: author.id,
        limit: 20,
        ...(cursor ? { cursor } : {}),
      },
      (result) => ({
        items: result.items,
        nextItems: result.nextCursor ?? null,
        truncated: result.truncated,
        status: result.items.length ? 'ready' : 'empty',
      }),
    );
  };
  const api = {
    getState: () => structuredClone(state),
    loadAuthors(platform = state.platform, cursor) {
      if (!['wechat', 'xiaohongshu'].includes(platform))
        return Promise.resolve(null);
      publish(initial(platform));
      return run(
        {
          action: 'authors',
          platform,
          limit: 20,
          ...(cursor ? { cursor } : {}),
        },
        (result) => ({
          authors: result.items,
          nextAuthors: result.nextCursor ?? null,
          truncated: result.truncated,
          status: result.items.length ? 'ready' : 'empty',
        }),
      );
    },
    openAuthor(id) {
      const author = state.authors.find((row) => row.id === id);
      return author ? loadItems(author) : Promise.resolve(null);
    },
    nextAuthors() {
      return state.nextAuthors
        ? api.loadAuthors(state.platform, state.nextAuthors)
        : Promise.resolve(null);
    },
    nextItems() {
      return state.author && state.nextItems
        ? loadItems(state.author, state.nextItems)
        : Promise.resolve(null);
    },
    openItem(id) {
      const item = state.items.find((row) => row.id === id);
      if (!item || !state.author) return Promise.resolve(null);
      publish({ ...state, item, body: null });
      return run(
        {
          action: 'body',
          platform: state.platform,
          authorId: state.author.id,
          itemId: item.id,
        },
        (body) => ({ body }),
      );
    },
    download() {
      if (
        !state.body ||
        !state.author ||
        !state.item ||
        state.status !== 'ready'
      )
        return Promise.resolve(null);
      return run(
        {
          action: 'download',
          platform: state.platform,
          authorId: state.author.id,
          itemId: state.item.id,
        },
        () => ({}),
        sitesDownloadBlob,
      );
    },
    dispose() {
      generation++;
      pending?.abort();
      publish(initial(state.platform));
    },
  };
  return api;
}
