// Synthetic server adapters for tests only. Never imported by the default Worker
// or the browser build; these are not real Sites/local authentication proofs.
import { createLocalSitesGateway } from '../../../scripts/sites-local-contract.mjs';
import { createPrivateReaderWorker } from '../worker.mjs';

export const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=';
export const image = 'data:image/png;base64,' + png;
export const authorId = 'synthetic-author';
export const itemId = 'synthetic-item';
export function fixture({
  viewer = 'owner',
  localViewer = 'owner',
  offline = false,
} = {}) {
  const calls = [];
  const track = (name, result) => async (input) => {
    calls.push([name, input]);
    return typeof result === 'function' ? result(input) : result;
  };
  const identity = (value) =>
    value === 'owner'
      ? { isOwner: true }
      : value === 'other'
        ? { isOwner: false }
        : null;
  const caller = {
    feed: {
      list: track('feed.list', {
        items: [
          { id: authorId, mpName: '合成订阅 <script>', token: 'PRIVATE_TOKEN' },
        ],
        nextCursor: null,
      }),
    },
    article: {
      list: track('article.list', {
        items: [
          {
            id: itemId,
            mpId: authorId,
            title: 'Synthetic owner article',
            publishTime: 1700000000,
            token: 'PRIVATE_TOKEN',
          },
        ],
        nextCursor: null,
      }),
      byId: track('article.byId', (id) => ({
        id,
        mpId: authorId,
        title: 'Synthetic owner article',
        publishTime: 1700000000,
        lastBodyStatus: 'available',
        contentHtml: '<cached-synthetic-body>',
      })),
      exportMarkdown: track('FORBIDDEN_EXPORT', null),
      retryBody: track('FORBIDDEN_RETRY', null),
    },
    xiaohongshu: {
      list: track('xhs.list', {
        items: [{ id: authorId, displayName: '合成博主' }],
      }),
      notes: track('xhs.notes', {
        items: [
          { id: itemId, title: 'Synthetic XHS note', publishTime: 1700000000 },
        ],
      }),
      body: track('xhs.body', {
        title: 'Synthetic XHS note',
        publishTime: 1700000000,
        text: 'Synthetic body',
        images: [image],
      }),
      refresh: track('FORBIDDEN_REFRESH', null),
    },
  };
  const gateway = createLocalSitesGateway({
    authorize: async () => identity(localViewer),
    caller,
    projectWechatCachedBody: async (html) => {
      if (html !== '<cached-synthetic-body>')
        throw Error('Unexpected fixture HTML');
      return {
        text: 'Synthetic body\n<script>not executable</script>',
        images: [image],
      };
    },
  });
  const worker = createPrivateReaderWorker({
    authorize: async () => identity(viewer),
    transport: {
      send: async (command) => {
        if (offline)
          throw Object.assign(Error('PC_UNAVAILABLE'), {
            code: 'PC_UNAVAILABLE',
          });
        return gateway.execute(command, { syntheticLocalChannel: true });
      },
    },
    browserScript: '/* synthetic asset only */',
  });
  const requests = [];
  const fetchImpl = async (endpoint, options) => {
    if (endpoint !== '/api/subscriptions')
      throw Error('Unexpected network endpoint');
    requests.push({ endpoint, options });
    return worker.fetch(
      new Request('https://reader.invalid' + endpoint, {
        ...options,
        headers: { ...options.headers, origin: 'https://reader.invalid' },
      }),
    );
  };
  return {
    worker,
    gateway,
    caller,
    calls,
    requests,
    fetchImpl,
    setViewer(value) {
      viewer = value;
    },
  };
}

export class NodeElement {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this._text = '';
  }
  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }
  get textContent() {
    return this._text + this.children.map((node) => node.textContent).join('');
  }
  set innerHTML(_) {
    throw Error('Raw HTML mounting forbidden');
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes) {
    this._text = '';
    this.children = [...nodes];
  }
  setAttribute(key, value) {
    this.attributes[key] = String(value);
  }
  addEventListener(name, callback) {
    this.listeners[name] = callback;
  }
  click() {
    if (!this.disabled) return this.listeners.click?.();
  }
  find(predicate) {
    return this.children
      .flatMap((node) => [node, ...node.find(predicate)])
      .filter(predicate);
  }
}
export const documentFixture = () => ({
  createElement: (tag) => new NodeElement(tag),
});
