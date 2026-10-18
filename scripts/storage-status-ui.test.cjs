'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadActualTs } = require('./offline-ts-fixture.cjs');
const helpers = loadActualTs('apps/web/src/utils/startup-status.ts');

test('nonblocking forecasts stay out of the reading banner; actual blocked checks have short true copy', () => {
  assert.equal(
    helpers.startupBlockingMessage({
      status: 'ready',
      writesAllowed: true,
      message: '备份空间接近容量或按持续变化预测剩余不足24小时',
    }),
    '',
  );
  assert.match(
    helpers.startupBlockingMessage({
      status: 'failed',
      writesAllowed: false,
      message: '备份空间预算不足',
    }),
    /存储空间受限.*暂停/,
  );
  assert(
    !helpers
      .startupBlockingMessage({
        status: 'failed',
        writesAllowed: false,
        message: '备份空间预算不足',
      })
      .includes('磁盘满'),
  );
  assert.match(
    helpers.startupBlockingMessage({
      status: 'verifying',
      writesAllowed: false,
      message: 'private diagnostic',
    }),
    /正在检查数据/,
  );
  assert.match(
    helpers.startupBlockingMessage({
      status: 'failed',
      writesAllowed: false,
      message: 'private diagnostic',
    }),
    /数据检查未通过/,
  );
});

test('only concrete unsuccessful storage requests receive storage failure copy, never an advisory forecast', () => {
  for (const message of [
    'INCREMENTAL_DISK_SPACE_INSUFFICIENT',
    'SQLITE_SPACE_BUDGET_EXCEEDED',
    'SQLITE_FULL',
    '备份空间预算不足',
  ])
    assert.equal(helpers.isStorageFailure(message), true);
  for (const message of [
    '备份空间接近上限',
    '预计不足24小时',
    'INCREMENTAL_DISK_POLICY_INVALID',
    'OTHER_FAILURE',
  ])
    assert.equal(helpers.isStorageFailure(message), false);
});

test('status reader validates the API, makes one read-only request and does not turn failures into ready', async () => {
  const previous = global.fetch;
  const calls = [];
  try {
    global.fetch = async (url, options) => {
      calls.push({ url, options });
      return new Response(
        JSON.stringify({ status: 'ready', writesAllowed: true, message: '' }),
      );
    };
    const state = await helpers.readStartupStatus(new AbortController().signal);
    assert.equal(state.writesAllowed, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/startup-status');
    assert.equal(calls[0].options.cache, 'no-store');
    assert.equal(calls[0].options.method, undefined);
    global.fetch = async () => new Response('{}', { status: 503 });
    await assert.rejects(
      helpers.readStartupStatus(new AbortController().signal),
    );
    global.fetch = async () =>
      new Response(JSON.stringify({ status: 'ready', message: '' }));
    await assert.rejects(
      helpers.readStartupStatus(new AbortController().signal),
    );
  } finally {
    global.fetch = previous;
  }
});

test('actual provider gives one concise failed-operation toast with a details action, without hiding unrelated failures', () => {
  const ts = require(
    require.resolve('typescript', { paths: [path.resolve('apps/web')] }),
  );
  const options = [],
    notices = [],
    navigations = [];
  const jsx = (type, props) => ({ type, props });
  const loaded = { exports: {} };
  const source = ts.transpileModule(
    fs.readFileSync('apps/web/src/provider/trpc.tsx', 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  vm.runInNewContext(source, {
    module: loaded,
    exports: loaded.exports,
    console: { log() {}, error() {} },
    require(name) {
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === 'react')
        return {
          useState: (value) => [
            typeof value === 'function' ? value() : value,
            () => {},
          ],
        };
      if (name === 'react-router-dom')
        return { useNavigate: () => (to) => navigations.push(to) };
      if (name === '@tanstack/react-query')
        return {
          QueryClient: class {
            constructor(o) {
              options.push(o);
            }
          },
          QueryClientProvider: 'QueryClientProvider',
        };
      if (name === '@trpc/client')
        return Object.fromEntries(
          ['httpBatchLink', 'httpLink', 'loggerLink', 'splitLink'].map(
            (key) => [key, () => ({})],
          ),
        );
      if (name === 'sonner')
        return { toast: { error: (...args) => notices.push(args) } };
      if (name === '../utils/trpc')
        return {
          isTRPCClientError: () => true,
          trpc: { createClient: () => ({}), Provider: 'Provider' },
        };
      if (name === '../utils/auth')
        return { getAuthCode: () => 'fixture', setAuthCode() {} };
      if (name === '../utils/env')
        return {
          enabledAuthCode: false,
          privateOnlineMode: false,
          serverOriginUrl: '',
        };
      if (name === '../utils/startup-status') return helpers;
      throw Error('Unexpected dependency ' + name);
    },
  });
  loaded.exports.TrpcProvider({ children: null });
  options[0].defaultOptions.mutations.onError({
    message: 'INCREMENTAL_DISK_SPACE_INSUFFICIENT',
    data: { httpStatus: 503 },
  });
  assert.equal(notices.length, 1);
  assert.equal(notices[0][0], '存储空间受限，本次操作未完成。');
  assert(!notices[0][1].description);
  notices[0][1].action.onClick();
  assert.deepEqual(navigations, [helpers.STORAGE_DETAILS_PATH]);
  options[0].defaultOptions.queries.onError({
    message: 'Other request failed',
    data: { httpStatus: 500 },
  });
  assert.equal(notices[1][1].description, 'Other request failed');
});

test('reading page removes only the implementation note and retains real filter/position controls', () => {
  const source = fs.readFileSync('apps/web/src/pages/feeds/index.tsx', 'utf8');
  assert(!source.includes('筛选与排序在本次浏览中记住'));
  assert(source.includes('useFeedBrowseState'));
  assert(source.includes('clearBrowseState()'));
  assert(source.includes('清除筛选与浏览位置'));
  assert.equal(
    fs
      .readFileSync('apps/web/src/utils/feed-browse-state.ts', 'utf8')
      .includes('saveBrowseFilters'),
    true,
  );
});
