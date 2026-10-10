'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require(
  require.resolve('typescript', { paths: [path.resolve('apps/web')] }),
);
const jsx = (type, props) => ({ type, props: props || {} });
function hooks() {
  const state = [];
  let cursor = 0;
  return {
    reset: () => {
      cursor = 0;
    },
    react: {
      useState(initial) {
        const i = cursor++;
        if (!(i in state)) state[i] = initial;
        return [
          state[i],
          (value) => {
            state[i] = typeof value === 'function' ? value(state[i]) : value;
          },
        ];
      },
      useMemo: (fn) => fn(),
      useEffect() {},
    },
  };
}
function load(file, modules) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    require: (name) => {
      assert(name in modules, name);
      return modules[name];
    },
  });
  return module.exports.default;
}
function nodes(tree) {
  const result = [];
  function visit(n) {
    if (Array.isArray(n)) return n.forEach(visit);
    if (n && typeof n === 'object') {
      result.push(n);
      visit(n.props?.children);
    }
  }
  visit(tree);
  return result;
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (tree && typeof tree === 'object') return text(tree.props.children);
  return typeof tree === 'string' ? tree : '';
}

test('first subscription has an honest name badge; later metadata restores a real avatar', () => {
  const h = hooks();
  const Avatar = load('apps/web/src/components/FeedAvatar.tsx', {
    react: h.react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
  });
  const render = (props) => {
    h.reset();
    return Avatar(props);
  };
  const empty = render({ src: '', name: '新公众号' });
  assert.equal(text(empty), '新');
  assert.equal(empty.props['aria-label'], '新公众号名称标识');
  assert(!nodes(empty).some((n) => n.type === 'img'));
  const actual = render({ src: 'https://wx.qlogo.cn/new/0', name: '新公众号' });
  assert.equal(
    nodes(actual).find((n) => n.type === 'img').props.src,
    'https://wx.qlogo.cn/new/0',
  );
  assert.equal(actual.props['aria-label'], '新公众号头像');
});
test('old real avatar is preserved in presentation; bad image falls back and changed metadata recovers', () => {
  const h = hooks();
  const Avatar = load('apps/web/src/components/FeedAvatar.tsx', {
    react: h.react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
  });
  const render = (props) => {
    h.reset();
    return Avatar(props);
  };
  const props = { src: 'https://wx.qlogo.cn/saved/0', name: '旧公众号' };
  const img = nodes(render(props)).find((n) => n.type === 'img');
  assert.equal(img.props.src, props.src);
  assert.equal(img.props.referrerPolicy, 'no-referrer');
  img.props.onError();
  assert.equal(text(render(props)), '旧');
  assert(!nodes(render(props)).some((n) => n.type === 'img'));
  assert.equal(
    nodes(render({ ...props, src: 'https://wx.qlogo.cn/replaced/0' })).find(
      (n) => n.type === 'img',
    ).props.src,
    'https://wx.qlogo.cn/replaced/0',
  );
  assert.equal(text(render({ src: '', name: '' })), '公');
});
function readingFixture(cached) {
  const h = hooks();
  let readInput;
  const item = {
    id: 'synthetic-article',
    mpId: 'synthetic',
    title: 'Synthetic title',
    sourceUrl: 'https://mp.weixin.qq.com/s/synthetic',
    bodyCached: cached,
    bodyRetry: { allowed: false, reason: 'Synthetic source unavailable' },
    publishTime: 1,
    feed: { mpName: 'Synthetic publisher', collectionChannel: 'wechat2rss' },
  };
  const trpc = {
    useUtils: () => ({}),
    article: {
      byId: {
        useQuery: (id, options) => {
          readInput = { id, options };
          return {
            error: id ? { message: 'Synthetic read failed' } : undefined,
          };
        },
      },
      retryBody: { useMutation: () => ({ isLoading: false }) },
      summary: {
        useQuery: () => ({
          data: { articles: 1, cachedBodies: cached ? 1 : 0 },
        }),
      },
      list: {
        useInfiniteQuery: () => ({
          data: { pages: [{ items: [item] }] },
          isLoading: false,
          isError: false,
        }),
      },
    },
  };
  const List = load('apps/web/src/pages/feeds/list.tsx', {
    react: h.react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    '@nextui-org/react': new Proxy({}, { get: (_, key) => key }),
    '@web/utils/trpc': { trpc },
    'react-router-dom': { useParams: () => ({ id: 'synthetic' }) },
    dayjs: { default: () => ({ format: () => 'Synthetic date' }) },
    sonner: { toast: {} },
  });
  const render = () => {
    h.reset();
    return List({
      search: '',
      selectedIds: new Set(),
      onSelectionChange() {},
      collectionChannels: { synthetic: 'wechat2rss' },
    });
  };
  return {
    render,
    get readInput() {
      return readInput;
    },
  };
}
test('cached title remains a keyboard-focusable reading link without a duplicate success button', () => {
  const f = readingFixture(true);
  const view = f.render();
  assert(!text(view).includes('阅读已缓存正文'));
  const link = nodes(view).find(
    (n) => n.type === 'a' && n.props.children === 'Synthetic title',
  );
  assert(link.props.href);
  assert.equal(link.props['aria-label'], '阅读缓存正文：Synthetic title');
  let prevented = false;
  link.props.onClick({
    preventDefault: () => {
      prevented = true;
    },
  });
  f.render();
  assert.equal(prevented, true);
  assert.equal(f.readInput.id, 'synthetic-article');
  assert.equal(f.readInput.options.enabled, true);
  assert.match(text(f.render()), /失败|未能|无法/);
});
test('missing bodies retain a short warning and original link; no false complete claim', () => {
  const f = readingFixture(false);
  const view = f.render();
  assert.match(text(view), /正文未缓存/);
  assert.match(text(view), /正文暂不可重试/);
  assert(!text(view).includes('Synthetic source unavailable'));
  const link = nodes(view).find(
    (n) => n.type === 'a' && n.props.children === 'Synthetic title',
  );
  let prevented = false;
  link.props.onClick({
    preventDefault: () => {
      prevented = true;
    },
  });
  f.render();
  assert.equal(prevented, false);
  assert.equal(f.readInput.options.enabled, false);
  assert.equal(link.props.href, 'https://mp.weixin.qq.com/s/synthetic');
});
