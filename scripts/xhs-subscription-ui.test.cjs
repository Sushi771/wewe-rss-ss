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
  const element = (type, props) =>
    typeof type === 'function'
      ? type(props || {})
      : { type, props: props || {} };
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
  let bodyData = null;
  let connectionData = {
    liveEnabled: false,
    connected: false,
    stored: null,
    verified: false,
    canConnect: false,
    canPersist: false,
    restartRequiresReparse: true,
  };
  let nextTask = 0;
  let releaseResolve;
  const api = Object.fromEntries(
    [
      'resolveSubscription',
      'subscribe',
      'refresh',
      'downloadNotes',
      'cancelTask',
      'resumeTask',
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
          if (name === 'downloadNotes') {
            taskStatus = status('running');
            return {
              taskId: nextTask++
                ? 'download-task-' + nextTask
                : 'download-task',
              creatorId: input.creatorId,
            };
          }
          if (name === 'resumeTask') {
            taskStatus = status('running');
            return { taskId: 'resumed-task', creatorId: 'creator-a' };
          }
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
    client: {
      get xiaohongshu() {
        return { ...api };
      },
    },
    xiaohongshu: Object.fromEntries(
      ['list', 'notes', 'body', 'groups', 'capability'].map((name) => [
        name,
        invalidation,
      ]),
    ),
  };
  const query = (data) => ({ data, isLoading: false, error: null });
  const router = {
    connectionStatus: {
      useQuery: () => ({
        ...query(connectionData),
        refetch: async () => {
          calls.push(['connectionStatus']);
          return { data: connectionData };
        },
      }),
    },
    restoreSession: {
      useMutation: () => ({
        mutateAsync: async () => {
          calls.push(['restoreSession']);
          connectionData = { ...connectionData, connected: true };
        },
      }),
    },
    disconnectSession: {
      useMutation: () => ({
        mutateAsync: async () => {
          calls.push(['disconnectSession']);
          connectionData = {
            ...connectionData,
            connected: false,
            stored: false,
          };
        },
      }),
    },
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
          items: items
            .map((note) => ({
              creatorId: 'creator-a',
              creatorName: '合成作者',
              groupId: null,
              ...note,
            }))
            .filter(
              (note) =>
                (!input.creatorId || note.creatorId === input.creatorId) &&
                (input.groupId === undefined ||
                  note.groupId === input.groupId) &&
                (!input.search ||
                  (
                    note.title +
                    note.creatorName +
                    (note.id === 'pending' ? ' 合成正文关键词' : '')
                  ).includes(input.search)) &&
                (!range ||
                  (note.publishTime > 0 &&
                    (range.gte === undefined ||
                      note.publishTime >= range.gte) &&
                    (range.lt === undefined || note.publishTime < range.lt))),
            ),
        });
      },
    },
    body: {
      useQuery: (input) => {
        if (input.noteId) calls.push(['bodyLookup', input]);
        return query(bodyData);
      },
    },
  };
  api.notes = {
    query: async (input) => {
      calls.push(['notesScope', input]);
      return router.notes.useQuery(input).data;
    },
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
      'Chip',
      'Modal',
      'ModalHeader',
      'ModalBody',
      'ModalContent',
      'ModalFooter',
      'Spinner',
      'Progress',
      'Tooltip',
      'Popover',
      'PopoverContent',
      'PopoverTrigger',
      'Switch',
    ].map((name) => [name, name]),
  );
  const primitives = load(
    'apps/web/src/components/SubscriptionPrimitives.tsx',
    {
      'react/jsx-runtime': { jsx: element, jsxs: element },
      '@nextui-org/react': ui,
    },
  );
  const page = load('apps/web/src/pages/feeds/xiaohongshu.tsx', {
    react,
    'react/jsx-runtime': { jsx: element, jsxs: element },
    '@nextui-org/react': ui,
    '@web/utils/trpc': {
      trpc: { useUtils: () => ({ ...utils }), xiaohongshu: router },
    },
    '@web/components/SubscriptionPrimitives': primitives,
    '@web/components/ManagementFolders': 'ManagementFolders',
    '@web/components/ArticleReader': 'ArticleReader',
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
    async start(all = false) {
      render();
      await tick();
      render();
      if (!all) {
        find('button', '合成作者').props.onClick();
        render();
      }
    },
    dispose() {
      slots.forEach((slot) => slot?.cleanup?.());
      global.fetch = previousFetch;
    },
    settings(o) {
      if ('body' in o) bodyData = o.body;
      if ('connection' in o) connectionData = o.connection;
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

test('note/profile resolution requires confirmation, preserves grouping, and refreshes only after successful new subscription', async () => {
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
      assert.deepEqual(
        f.calls.find(([name]) => name === 'subscribe'),
        ['subscribe', { resolutionId: 'resolution-a', groupId: 'group-a' }],
      );
      assert.equal(f.calls.filter(([name]) => name === 'refresh').length, 1);
      assert.equal(
        f.calls.findIndex(([name]) => name === 'refresh') >
          f.calls.findIndex(([name]) => name === 'subscribe'),
        true,
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

test('date and title filters reset selection; pending image notes selectable, uncached videos excluded; ZIP keeps cached video', async () => {
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
    f.find('Checkbox', '全选已加载').props.onValueChange(true);
    assert.equal(f.find('Checkbox', '选择笔记 视频').props.isDisabled, false);
    assert.equal(
      f.find('Checkbox', '选择笔记 苹果图文').props.isSelected,
      true,
    );
    await f.button('导出已保存 ZIP').props.onPress();
    await f.button('开始导出').props.onPress();
    assert.deepEqual(f.calls.find(([n]) => n === 'export')[1].noteIds, [
      'saved',
      'old',
      'video',
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
    f.find('Checkbox', '全选已加载').props.onValueChange(true);
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
    assert.equal(f.find('Checkbox', '全选已加载').props.isDisabled, true);
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
    f.find('summary', '收起进度').props.onClick({ preventDefault() {} });
    assert.ok(f.find('summary', '查看进度'));
    assert.equal(f.button('更新笔记列表').props.isDisabled, false);
    f.find('Checkbox', '选择笔记 苹果图文').props.onValueChange(true);
    f.render();
    await tick();
    assert.equal(
      f.find('Checkbox', '选择笔记 苹果图文').props.isSelected,
      true,
      'terminal polling must not clear a new selection',
    );
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

test('management folders retain move/filter handlers and selections above 100 remain downloadable', async () => {
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
    f.find('ManagementFolders').props.onFilter('all');
    for (let i = 0; i < 101; i++)
      f.items.push({
        id: `synthetic-${i}`,
        title: `图文 ${i}`,
        kind: 'image-text',
        status: 'pending',
        publishTime: 0,
      });
    await f.button('选择当前筛选全部').props.onPress();
    const download = f.button('下载图文到本地 (104)');
    assert.equal(download.props.isDisabled, false);
    await download.props.onPress();
    assert.equal(
      f.calls.filter(([name]) => name === 'downloadNotes').length,
      1,
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

test('cross-page loaded selection preserves earlier IDs; filtered export includes unloaded matches and batches above 100', async () => {
  const f = fixture();
  const oldDocument = global.document,
    oldCreate = URL.createObjectURL,
    oldRevoke = URL.revokeObjectURL;
  const filenames = [];
  global.document = {
    body: { appendChild() {} },
    createElement: () => ({
      click() {
        filenames.push(this.download);
      },
      remove() {},
    }),
  };
  URL.createObjectURL = () => 'blob:synthetic';
  URL.revokeObjectURL = () => {};
  try {
    for (let i = 0; i < 205; i++)
      f.items.push({
        id: `batch-${String(i).padStart(3, '0')}`,
        title: `批量 ${i}`,
        kind: 'image-text',
        status: 'complete',
        publishTime: Date.parse('2026-10-24T00:00Z') / 1000,
      });
    f.items.push({
      id: 'excluded-day',
      title: '批量 日期外',
      kind: 'image-text',
      status: 'complete',
      publishTime: Date.parse('2026-10-20T00:00Z') / 1000,
    });
    await f.start();
    await f.button('搜索笔记').props.onPress();
    f.find('Input', '搜索笔记标题或正文').props.onValueChange('批量');
    f.find('ArticleDateFilter').props.onChange({
      mode: 'day',
      start: '2026-10-24',
      end: '',
    });
    f.find('Checkbox', '全选已加载').props.onValueChange(true);
    assert.ok(f.button('下载图文到本地 (20)'));
    await f.button('加载更多').props.onPress();
    assert.equal(f.find('Checkbox', '选择笔记 批量 0').props.isSelected, true);
    f.find('Checkbox', '全选已加载').props.onValueChange(true);
    assert.ok(f.button('下载图文到本地 (40)'));
    assert.equal(f.find('Checkbox', '选择笔记 批量 204'), undefined);
    await f.button('导出已保存 ZIP').props.onPress();
    f.render()
      .find((n) => n.type === 'input' && n.props.value === 'filtered')
      .props.onChange();
    await f.button('开始导出').props.onPress();
    const exports = f.calls
      .filter(([name]) => name === 'export')
      .map(([, input]) => input);
    assert.deepEqual(
      exports.map((input) => input.noteIds.length),
      [100, 100, 5],
    );
    assert.equal(new Set(exports.flatMap((input) => input.noteIds)).size, 205);
    assert.ok(!exports.some((input) => input.noteIds.includes('excluded-day')));
    assert.deepEqual(f.calls.find(([name]) => name === 'notesScope')[1], {
      creatorId: 'creator-a',
      search: '批量',
      dateStart: '2026-10-24',
      dateEnd: '2026-10-24',
    });
    assert.deepEqual(filenames, [
      'synthetic-part-1-of-3.zip',
      'synthetic-part-2-of-3.zip',
      'synthetic-part-3-of-3.zip',
    ]);
    assert.ok(f.button('下载图文到本地 (40)'));
  } finally {
    f.dispose();
    global.document = oldDocument;
    URL.createObjectURL = oldCreate;
    URL.revokeObjectURL = oldRevoke;
  }
});

test('archive batches stop after cancellation or uncertain response and never replay; receipts validate counts', async () => {
  const ids = Array.from({ length: 225 }, (_, i) => `id-${i}`);
  const controller = new AbortController();
  const sends = [],
    saved = [];
  const result = await helpers.exportArchiveBatches({
    ids,
    signal: controller.signal,
    send: async (batch) => {
      sends.push(batch);
      return { notes: batch.length };
    },
    save: (receipt) => {
      saved.push(receipt);
      controller.abort();
    },
    onProgress() {},
  });
  assert.equal(result.cancelled, true);
  assert.equal(result.completed, 100);
  assert.equal(sends.length, 1);
  assert.equal(saved.length, 1);
  let attempts = 0;
  await assert.rejects(
    helpers.exportArchiveBatches({
      ids,
      signal: new AbortController().signal,
      send: async () => {
        attempts++;
        throw Error('lost response');
      },
      save: assert.fail,
      onProgress: assert.fail,
    }),
    /lost response/,
  );
  assert.equal(attempts, 1);
  await assert.rejects(
    helpers.exportArchiveBatches({
      ids: ['one'],
      signal: new AbortController().signal,
      send: async () => ({ notes: 0 }),
      save: assert.fail,
      onProgress: assert.fail,
    }),
    /回执篇数/,
  );
});

test('resuming waits for executor release, uses original task identity and newly returned task ID, and retains new selections', async () => {
  const f = fixture();
  try {
    await f.start();
    f.find('Checkbox', '选择笔记 苹果图文').props.onValueChange(true);
    await f.button('下载图文到本地 (1)').props.onPress();
    f.render();
    await tick();
    f.setTask({ ...status('cancelled'), resumable: false });
    await tick();
    assert.equal(f.find('Button', '继续未完成任务'), undefined);
    assert.equal(f.button('更新笔记列表').props.isDisabled, true);
    f.setTask({ ...status('cancelled'), resumable: true });
    await tick();
    const resume = f.button('继续未完成任务');
    await Promise.all([resume.props.onPress(), resume.props.onPress()]);
    assert.deepEqual(
      f.calls.find(([name]) => name === 'resumeTask'),
      ['resumeTask', { taskId: 'download-task', pickToken: 'synthetic-grant' }],
    );
    assert.equal(f.calls.filter(([name]) => name === 'resumeTask').length, 1);
    f.render();
    await tick();
    assert.ok(
      f.calls.some(
        ([name, input]) => name === 'task' && input.taskId === 'resumed-task',
      ),
    );
    f.setTask({ ...status('completed'), resumable: false });
    await tick();
    f.render();
    f.find('Checkbox', '选择笔记 苹果存档').props.onValueChange(true);
    await tick();
    assert.equal(
      f.find('Checkbox', '选择笔记 苹果存档').props.isSelected,
      true,
    );
  } finally {
    f.dispose();
  }
});

test('search clear and hidden-filter feedback match WeChat; Escape closes input without dropping filter', async () => {
  const previousWindow = global.window;
  const listeners = new Map();
  global.window = {
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name, callback) => {
      if (listeners.get(name) === callback) listeners.delete(name);
    },
  };
  const f = fixture();
  try {
    await f.start();
    await f.button('搜索笔记').props.onPress();
    const input = f.find('Input', '搜索笔记标题或正文');
    assert.equal(input.props.autoFocus, true);
    assert.equal(input.props.isClearable, true);
    assert.equal(input.props.maxLength, 200);
    assert.ok(f.render().some((node) => node.props?.id === 'xhs-search-panel'));
    input.props.onValueChange('存档');
    f.render();
    listeners.get('keydown')({ key: 'Escape' });
    assert.equal(f.find('Input', '搜索笔记标题或正文'), undefined);
    const chip = f.find('Chip', '搜索：存档；清除关键词');
    assert.ok(chip);
    chip.props.onClose();
    assert.equal(f.find('Chip', '搜索：存档；清除关键词'), undefined);
    assert.ok(f.find('Checkbox', '选择笔记 苹果图文'));
    await f.button('搜索笔记').props.onPress();
    f.find('Input', '搜索笔记标题或正文').props.onValueChange('存档');
    f.find('Input', '搜索笔记标题或正文').props.onClear();
    assert.equal(f.find('Input', '搜索笔记标题或正文').props.value, '');
  } finally {
    f.dispose();
    global.window = previousWindow;
  }
});

test('saved note uses the common reader/find component, preserves images, and reserves Escape while finding', async () => {
  const f = fixture();
  try {
    await f.start();
    f.settings({
      body: {
        title: '合成正文',
        text: 'A <script> & 关键词\n第二段',
        images: ['data:image/png;base64,c3ludGhldGlj'],
        kind: 'image-text',
      },
    });
    f.render()
      .find(
        (node) => node.type === 'button' && node.props.children === '苹果存档',
      )
      .props.onClick();
    let reader = f.find('ArticleReader');
    assert.ok(reader);
    assert.match(reader.props.contentHtml, /A &lt;script&gt; &amp; 关键词/);
    assert.match(
      reader.props.contentHtml,
      /data:image\/png;base64,c3ludGhldGlj/,
    );
    assert.equal(reader.props.findOpen, false);
    reader.props.onFindOpenChange(true);
    const modal = f
      .render()
      .find((node) => node.type === 'Modal' && node.props.size === '4xl');
    assert.equal(modal.props.isKeyboardDismissDisabled, true);
    modal.props.onClose();
    reader = f.find('ArticleReader');
    assert.equal(reader.props.findOpen, false);
  } finally {
    f.dispose();
  }
});

test('global/group queries preserve authors, exports dispatch by author and reading uses the actual owner', async () => {
  const f = fixture();
  const oldDocument = global.document,
    oldCreate = URL.createObjectURL,
    oldRevoke = URL.revokeObjectURL;
  global.document = {
    body: { appendChild() {} },
    createElement: () => ({ click() {}, remove() {} }),
  };
  URL.createObjectURL = () => 'blob:synthetic';
  URL.revokeObjectURL = () => {};
  try {
    f.items.push({
      id: 'author-b-note',
      creatorId: 'creator-b',
      creatorName: '第二作者',
      groupId: 'group-a',
      title: '分组正文',
      kind: 'image-text',
      status: 'complete',
      publishTime: 1,
    });
    await f.start(true);
    assert.ok(f.find('Checkbox', '选择笔记 分组正文'));
    await f.button('选择当前筛选全部').props.onPress();
    await f.button('导出已保存 ZIP').props.onPress();
    await f.button('开始导出').props.onPress();
    const exports = f.calls.filter(([name]) => name === 'export');
    assert.ok(exports.some(([, input]) => input.creatorId === 'creator-a'));
    assert.deepEqual(
      exports.find(([, input]) => input.creatorId === 'creator-b')[1].noteIds,
      ['author-b-note'],
    );
    f.find('ManagementFolders').props.onFilter('group-a');
    assert.ok(f.find('Checkbox', '选择笔记 分组正文'));
    assert.equal(f.find('Checkbox', '选择笔记 苹果图文'), undefined);
    await f.button('导出已保存 ZIP').props.onPress();
    f.render()
      .find((n) => n.type === 'input' && n.props.value === 'filtered')
      .props.onChange();
    await f.button('开始导出').props.onPress();
    assert.equal(
      f.calls.filter(([name]) => name === 'notesScope').at(-1)[1].groupId,
      'group-a',
    );
    f.render()
      .find((n) => n.type === 'button' && n.props.children === '分组正文')
      .props.onClick();
    f.render();
    assert.equal(
      f.calls.filter(([name]) => name === 'bodyLookup').at(-1)[1].creatorId,
      'creator-b',
    );
    f.find('ManagementFolders').props.onFilter('ungrouped');
    assert.equal(f.find('Checkbox', '选择笔记 分组正文'), undefined);
  } finally {
    f.dispose();
    global.document = oldDocument;
    URL.createObjectURL = oldCreate;
    URL.revokeObjectURL = oldRevoke;
  }
});

test('mixed-author downloads run serially, stop queued authors on cancellation, and preserve the selected scope', async () => {
  const f = fixture();
  try {
    f.items.push({
      id: 'author-b-pending',
      creatorId: 'creator-b',
      creatorName: '第二作者',
      groupId: null,
      title: '第二图文',
      kind: 'image-text',
      status: 'pending',
      publishTime: 1,
    });
    f.items.push({
      id: 'author-c-pending',
      creatorId: 'creator-c',
      creatorName: '第三作者',
      groupId: null,
      title: '第三图文',
      kind: 'image-text',
      status: 'pending',
      publishTime: 1,
    });
    await f.start(true);
    f.find('Checkbox', '选择笔记 苹果图文').props.onValueChange(true);
    f.find('Checkbox', '选择笔记 第二图文').props.onValueChange(true);
    f.find('Checkbox', '选择笔记 第三图文').props.onValueChange(true);
    await f.button('下载图文到本地 (3)').props.onPress();
    f.render();
    await tick();
    assert.equal(
      f.calls.filter(([name]) => name === 'downloadNotes').length,
      1,
    );
    f.setTask(status('completed'));
    await tick();
    f.render();
    await tick();
    const downloads = f.calls.filter(([name]) => name === 'downloadNotes');
    assert.equal(downloads.length, 2);
    assert.deepEqual(downloads[1][1].noteIds, ['author-b-pending']);
    assert.equal(downloads[1][1].creatorId, 'creator-b');
    await f.button('取消任务').props.onPress();
    await tick();
    f.render();
    assert.ok(f.button('下载图文到本地 (3)'));
    assert.equal(
      f.calls.filter(([name]) => name === 'downloadNotes').length,
      2,
      'cancel must not submit the queued third author',
    );
  } finally {
    f.dispose();
  }
});

test('connection controls stay default-off, never request secrets or connect automatically, and restore/disconnect only when pressed', async () => {
  const f = fixture();
  try {
    await f.start(true);
    assert.equal(f.button('恢复本机会话').props.isDisabled, true);
    assert.equal(f.button('断开本机会话').props.isDisabled, true);
    assert.equal(
      f.calls.some(([name]) => /Session/.test(name)),
      false,
    );
    assert.equal(
      f
        .render()
        .some(
          (n) =>
            n.type === 'Input' &&
            /a1|webSession|cookie/i.test(
              n.props.label || n.props['aria-label'] || '',
            ),
        ),
      false,
    );
    f.settings({
      connection: {
        liveEnabled: true,
        connected: false,
        stored: true,
        verified: false,
      },
    });
    const restore = f.button('恢复本机会话');
    await Promise.all([restore.props.onPress(), restore.props.onPress()]);
    assert.equal(
      f.calls.filter(([name]) => name === 'restoreSession').length,
      1,
    );
    await f.button('断开本机会话').props.onPress();
    assert.equal(
      f.calls.filter(([name]) => name === 'disconnectSession').length,
      1,
    );
    assert.ok(f.find('Checkbox', '选择笔记 苹果存档'));
  } finally {
    f.dispose();
  }
});
