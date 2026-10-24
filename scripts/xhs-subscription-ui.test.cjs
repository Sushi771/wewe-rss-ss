const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require(
  require.resolve('typescript', { paths: [path.resolve('apps/web')] }),
);
function load(file, imports = {}) {
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2021,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'exports', 'module', output)(
    (name) => {
      if (!(name in imports)) throw Error(`Unexpected dependency ${name}`);
      return imports[name];
    },
    mod.exports,
    mod,
  );
  return mod.exports;
}
const helpers = load('apps/web/src/utils/xiaohongshu-subscription.ts');
const dateHelpers = load('apps/web/src/utils/article-date-selection.ts');
const zod = require(
  require.resolve('zod', { paths: [path.resolve('packages/shared')] }),
);
const shared = load('packages/shared/src/article-date-filter.ts', { zod });
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
const status = (state = 'running', kind = 'download') => ({
  kind,
  state,
  total: 3,
  completed: state === 'completed' ? 3 : 1,
  skipped: 0,
  failed: 0,
  remaining: state === 'completed' ? 0 : 2,
});

function fixture() {
  let index = 0;
  const slots = [],
    effects = [],
    calls = [];
  const element = (type, props) => ({ type, props: props || {} });
  const react = {
    useState(value) {
      const i = index++;
      if (!(i in slots))
        slots[i] = typeof value === 'function' ? value() : value;
      return [
        slots[i],
        (next) => {
          slots[i] = typeof next === 'function' ? next(slots[i]) : next;
        },
      ];
    },
    useRef(value) {
      const i = index++;
      if (!(i in slots)) slots[i] = { current: value };
      return slots[i];
    },
    useMemo(fn, deps) {
      const i = index++;
      if (!slots[i] || deps.some((v, j) => !Object.is(v, slots[i].deps[j])))
        slots[i] = { deps, value: fn() };
      return slots[i].value;
    },
    useCallback(fn, deps) {
      return react.useMemo(() => fn, deps);
    },
    useEffect(fn, deps) {
      const i = index++;
      const prev = slots[i];
      if (!prev || deps.some((v, j) => !Object.is(v, prev.deps[j]))) {
        slots[i] = { deps, cleanup: prev?.cleanup };
        effects.push(() => {
          slots[i].cleanup?.();
          slots[i].cleanup = fn();
        });
      }
    },
  };
  const creators = {
    items: [
      {
        id: 'creator-a',
        displayName: '合成作者',
        enabled: true,
        groupId: null,
        _count: { notes: 4 },
      },
    ],
  };
  const items = [
    {
      id: 'pending',
      title: '苹果图文',
      kind: 'image-text',
      status: 'pending',
      publishTime: Date.parse('2026-10-23T16:00Z') / 1000,
    },
    {
      id: 'saved',
      title: '苹果存档',
      kind: 'image-text',
      status: 'complete',
      publishTime: Date.parse('2026-10-24T15:59:59Z') / 1000,
    },
    {
      id: 'old',
      title: '旧笔记',
      kind: 'image-text',
      status: 'complete',
      publishTime: Date.parse('2026-10-22T12:00Z') / 1000,
    },
    {
      id: 'video',
      title: '视频',
      kind: 'video',
      status: 'complete',
      publishTime: 0,
    },
  ];
  let taskStatus = status();
  let resolveKind = 'note',
    existing = null,
    expired = false,
    cancelledPicker = false,
    failStatus = false;
  let releaseResolve;
  const api = Object.fromEntries(
    [
      'resolveSubscription',
      'subscribe',
      'refresh',
      'downloadNotes',
      'cancelTask',
    ].map((name) => [
      name,
      {
        mutate: async (input) => {
          calls.push([name, input]);
          if (name === 'resolveSubscription') {
            if (releaseResolve)
              await new Promise((resolve) => {
                releaseResolve = resolve;
              });
            return {
              resolutionId: 'resolution-a',
              inputKind: resolveKind,
              author: {
                id: 'author-a',
                name: '合成作者',
                profileUrl:
                  'https://www.xiaohongshu.com/user/profile/synthetic',
              },
              existingCreatorId: existing,
              expiresAt: new Date(
                Date.now() + (expired ? -100 : 60000),
              ).toISOString(),
            };
          }
          if (name === 'subscribe')
            return {
              creatorId: 'creator-a',
              created: !existing,
              subscribed: true,
            };
          if (name === 'refresh') {
            taskStatus = status('running', 'list');
            return { taskId: 'list-task', creatorId: input.id };
          }
          if (name === 'downloadNotes')
            return { taskId: 'download-task', creatorId: input.creatorId };
          if (name === 'cancelTask') {
            taskStatus = status('cancelled', taskStatus.kind);
            return {};
          }
        },
      },
    ]),
  );
  api.task = {
    query: async (input) => {
      calls.push(['task', input]);
      if (failStatus) throw Error('offline');
      return taskStatus;
    },
  };
  const invalidation = { invalidate: async () => {} };
  const utils = {
    client: { xiaohongshu: api },
    xiaohongshu: Object.fromEntries(
      ['list', 'notes', 'body', 'groups'].map((name) => [name, invalidation]),
    ),
  };
  const query = (data) => ({ data, isLoading: false, error: null });
  const router = {
    capability: { useQuery: () => query({ canRefresh: true }) },
    list: { useQuery: () => query(creators) },
    groups: {
      useQuery: () =>
        query({ items: [{ id: 'group-a', name: '合成分组', order: 0 }] }),
    },
    notes: {
      useQuery: (input) => {
        const range = shared.articlePublicationRange(input);
        return query({
          items: items.filter(
            (note) =>
              (!input.search ||
                (
                  note.title + (note.id === 'pending' ? ' 合成正文关键词' : '')
                ).includes(input.search)) &&
              (!range ||
                (note.publishTime > 0 &&
                  (range.gte === undefined || note.publishTime >= range.gte) &&
                  (range.lt === undefined || note.publishTime < range.lt))),
          ),
        });
      },
    },
    body: { useQuery: () => query(null) },
  };
  for (const name of [
    'edit',
    'remove',
    'export',
    'saveGroup',
    'removeGroup',
    'moveCreators',
  ])
    router[name] = {
      useMutation: () => ({
        mutateAsync: async (input) => {
          calls.push([name, input]);
          return name === 'export'
            ? {
                base64: '',
                mimeType: 'application/zip',
                filename: 'synthetic.zip',
                notes: input.noteIds.length,
              }
            : {};
        },
      }),
    };
  const ui = Object.fromEntries(
    [
      'Button',
      'Input',
      'Checkbox',
      'Modal',
      'ModalHeader',
      'ModalBody',
      'ModalContent',
      'ModalFooter',
      'Spinner',
      'Switch',
    ].map((name) => [name, name]),
  );
  const page = load('apps/web/src/pages/feeds/xiaohongshu.tsx', {
    react,
    'react/jsx-runtime': { jsx: element, jsxs: element },
    '@nextui-org/react': ui,
    '@web/utils/trpc': { trpc: { useUtils: () => utils, xiaohongshu: router } },
    '@web/components/ManagementFolders': 'ManagementFolders',
    '@web/components/ArticleDateFilter': 'ArticleDateFilter',
    '@web/utils/article-date-selection': dateHelpers,
    '@wewe-rss/shared': shared,
    '@web/utils/xiaohongshu-subscription': {
      ...helpers,
      watchSubscriptionTask: (options) =>
        helpers.watchSubscriptionTask({ ...options, interval: 2 }),
    },
    '@web/utils/auth': { getAuthCode: () => '' },
    '@web/utils/env': { serverOriginUrl: '' },
    '@web/utils/operation-message': {
      failureMessage: (cause) => cause.message,
    },
  }).default;
  const previousFetch = global.fetch;
  global.fetch = async (url) => ({
    ok: true,
    json: async () =>
      url.endsWith('/directory')
        ? {
            directory: 'synthetic-only',
            askEveryTime: true,
            cancelled: cancelledPicker,
            pickToken: 'synthetic-grant',
          }
        : { directory: 'synthetic-only', askEveryTime: true },
  });
  let tree;
  const all = (node) =>
    node == null
      ? []
      : Array.isArray(node)
        ? node.flatMap(all)
        : typeof node === 'object'
          ? [node, ...all(node.props?.children)]
          : [node];
  const render = () => {
    index = 0;
    tree = page();
    effects.splice(0).forEach((effect) => effect());
    return all(tree);
  };
  const find = (type, text) =>
    render().find(
      (n) =>
        n.type === type &&
        (n.props['aria-label'] === text ||
          n.props.label === text ||
          all(n.props.children).join('') === text),
    );
  const button = (text) => {
    const node = find('Button', text);
    assert.ok(node, `button ${text}`);
    return node;
  };
  return {
    calls,
    creators,
    items,
    render,
    find,
    button,
    async start() {
      render();
      await tick();
      render();
    },
    dispose() {
      slots.forEach((slot) => slot?.cleanup?.());
      global.fetch = previousFetch;
    },
    settings(o) {
      if (o.kind) resolveKind = o.kind;
      if ('existing' in o) existing = o.existing;
      if ('expired' in o) expired = o.expired;
      if ('cancelledPicker' in o) cancelledPicker = o.cancelledPicker;
      if ('failStatus' in o) failStatus = o.failStatus;
    },
    setTask(value) {
      taskStatus = value;
    },
    async resolve() {
      await button('订阅').props.onPress();
      find('Input', '笔记或博主主页链接').props.onValueChange(
        'https://www.xiaohongshu.com/explore/synthetic',
      );
      await button('识别作者').props.onPress();
      render();
    },
  };
}

test('note/profile resolution requires confirmation, preserves grouping, and never refreshes automatically', async () => {
  for (const kind of ['note', 'profile']) {
    const f = fixture();
    try {
      f.settings({ kind });
      await f.start();
      await f.resolve();
      assert.deepEqual(
        f.calls.map(([name]) => name),
        ['resolveSubscription'],
      );
      f.find('select', '订阅文件夹').props.onChange({
        target: { value: 'group-a' },
      });
      const confirm = f.button('确认订阅');
      await Promise.all([confirm.props.onPress(), confirm.props.onPress()]);
      assert.equal(f.calls.filter(([name]) => name === 'subscribe').length, 1);
      assert.deepEqual(f.calls.at(-1), [
        'subscribe',
        { resolutionId: 'resolution-a', groupId: 'group-a' },
      ]);
      assert.ok(
        f.render().includes('订阅成功，可更新笔记列表后选择图文保存。'),
      );
    } finally {
      f.dispose();
    }
  }
});

test('existing subscription feedback, changed input invalidation, and expired confirmation', async () => {
  const f = fixture();
  try {
    await f.start();
    f.settings({ existing: 'creator-a' });
    await f.resolve();
    assert.ok(f.button('查看已订阅博主'));
    f.find('Input', '笔记或博主主页链接').props.onValueChange('changed');
    assert.ok(f.button('识别作者'));
    f.settings({ expired: true, existing: null });
    await f.resolve();
    await f.button('确认订阅').props.onPress();
    assert.equal(f.calls.filter(([n]) => n === 'subscribe').length, 0);
    assert.ok(
      f
        .render()
        .some((n) => typeof n === 'string' && n.includes('作者确认已过期')),
    );
  } finally {
    f.dispose();
  }
});

test('date and title filters reset selection; pending image notes selectable, videos excluded; ZIP uses saved subset', async () => {
  const f = fixture();
  const oldDocument = global.document;
  const oldCreate = URL.createObjectURL,
    oldRevoke = URL.revokeObjectURL;
  global.document = {
    body: { appendChild() {} },
    createElement: () => ({ click() {}, remove() {} }),
  };
  URL.createObjectURL = () => 'blob:synthetic';
  URL.revokeObjectURL = () => {};
  try {
    await f.start();
    f.find('Checkbox', '选择筛选后全部图文笔记').props.onValueChange(true);
    assert.equal(f.find('Checkbox', '选择笔记 视频').props.isDisabled, true);
    assert.equal(
      f.find('Checkbox', '选择笔记 苹果图文').props.isSelected,
      true,
    );
    await f.button('导出已保存 ZIP').props.onPress();
    assert.deepEqual(f.calls.find(([n]) => n === 'export')[1].noteIds, [
      'saved',
      'old',
    ]);
    f.find('ArticleDateFilter').props.onChange({
      mode: 'day',
      start: '2026-10-24',
      end: '',
    });
    assert.equal(
      f.find('Checkbox', '选择笔记 苹果图文').props.isSelected,
      false,
    );
    assert.equal(f.find('Checkbox', '选择笔记 旧笔记'), undefined);
    f.find('Checkbox', '选择筛选后全部图文笔记').props.onValueChange(true);
    await f.button('搜索笔记').props.onPress();
    f.find('Input', '搜索笔记标题或正文').props.onValueChange('存档');
    assert.equal(f.find('Checkbox', '选择笔记 苹果图文'), undefined);
    assert.equal(
      f.find('Checkbox', '选择笔记 苹果存档').props.isSelected,
      false,
    );
    f.find('Input', '搜索笔记标题或正文').props.onValueChange('正文关键词');
    assert.ok(f.find('Checkbox', '选择笔记 苹果图文'));
    assert.equal(f.find('Checkbox', '选择笔记 苹果存档'), undefined);
    f.find('ArticleDateFilter').props.onChange({
      mode: 'range',
      start: '2026-10-25',
      end: '2026-10-24',
    });
    assert.equal(
      f.find('Checkbox', '选择筛选后全部图文笔记').props.isDisabled,
      true,
    );
  } finally {
    f.dispose();
    global.document = oldDocument;
    URL.createObjectURL = oldCreate;
    URL.revokeObjectURL = oldRevoke;
  }
});

test('local picker cancellation does not download; repeated download and cancel clicks start one operation; progress collapses', async () => {
  const f = fixture();
  try {
    await f.start();
    f.find('Checkbox', '选择笔记 苹果图文').props.onValueChange(true);
    f.settings({ cancelledPicker: true });
    await f.button('下载图文到本地 (1)').props.onPress();
    assert.equal(f.calls.filter(([n]) => n === 'downloadNotes').length, 0);
    f.settings({ cancelledPicker: false });
    const download = f.button('下载图文到本地 (1)');
    await Promise.all([download.props.onPress(), download.props.onPress()]);
    f.render();
    await tick();
    assert.deepEqual(f.calls.find(([n]) => n === 'downloadNotes')[1], {
      creatorId: 'creator-a',
      noteIds: ['pending'],
      pickToken: 'synthetic-grant',
    });
    assert.equal(f.calls.filter(([n]) => n === 'downloadNotes').length, 1);
    const cancel = f.button('取消任务');
    await Promise.all([cancel.props.onPress(), cancel.props.onPress()]);
    await tick();
    f.render();
    assert.equal(f.calls.filter(([n]) => n === 'cancelTask').length, 1);
    await f.button('收起进度').props.onPress();
    assert.ok(f.button('展开进度'));
    assert.equal(f.button('更新笔记列表').props.isDisabled, false);
  } finally {
    f.dispose();
  }
});

test('list refresh has distinct progress; status outages never resubmit work; partial completion unlocks controls', async () => {
  const f = fixture();
  try {
    await f.start();
    const refresh = f.button('更新笔记列表');
    await Promise.all([refresh.props.onPress(), refresh.props.onPress()]);
    f.settings({ failStatus: true });
    f.render();
    await tick();
    assert.equal(f.calls.filter(([n]) => n === 'refresh').length, 1);
    assert.equal(f.button('更新笔记列表').props.isDisabled, true);
    f.settings({ failStatus: false });
    f.setTask(status('partial', 'list'));
    await tick();
    assert.equal(f.button('更新笔记列表').props.isDisabled, false);
    assert.ok(
      f
        .render()
        .some(
          (n) => typeof n === 'string' && n.includes('更新笔记列表：部分完成'),
        ),
    );
  } finally {
    f.dispose();
  }
});

test('management folders retain move and filter handlers; excessive selection is stopped before picker or download', async () => {
  const f = fixture();
  try {
    await f.start();
    await f.find('ManagementFolders').props.onMove(['creator-a'], 'group-a');
    assert.deepEqual(
      f.calls.find(([name]) => name === 'moveCreators'),
      ['moveCreators', { ids: ['creator-a'], groupId: 'group-a' }],
    );
    f.find('ManagementFolders').props.onFilter('group-a');
    assert.equal(f.find('ManagementFolders').props.filter, 'group-a');
    for (let i = 0; i < 101; i++)
      f.items.push({
        id: `synthetic-${i}`,
        title: `图文 ${i}`,
        kind: 'image-text',
        status: 'pending',
        publishTime: 0,
      });
    f.find('Checkbox', '选择筛选后全部图文笔记').props.onValueChange(true);
    const download = f.button('下载图文到本地 (104)');
    assert.equal(download.props.isDisabled, true);
    await download.props.onPress();
    assert.equal(
      f.calls.filter(([name]) => name === 'downloadNotes').length,
      0,
    );
  } finally {
    f.dispose();
  }
});

test('poller abort prevents stale completion; all terminal states and counts remain visible', async () => {
  const controller = new AbortController();
  let finish;
  const observed = [];
  const watching = helpers.watchSubscriptionTask({
    taskId: 'synthetic',
    query: () =>
      new Promise((r) => {
        finish = r;
      }),
    signal: controller.signal,
    onTask: (value) => observed.push(value),
    onError: assert.fail,
    interval: 1,
  });
  controller.abort();
  finish(status('completed'));
  await watching;
  assert.deepEqual(observed, []);
  for (const state of [
    'completed',
    'partial',
    'blocked',
    'cancelled',
    'failed',
  ])
    assert.equal(helpers.taskFinished(status(state)), true);
  assert.match(
    helpers.taskText({ ...status('partial'), skipped: 1, failed: 1 }),
    /跳过 1，失败 1，剩余 2/,
  );
});
