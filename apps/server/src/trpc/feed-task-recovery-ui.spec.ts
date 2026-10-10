import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as ts from 'typescript';

// Execute actual page callbacks, with no database, transport or upstream writes.
const filename = path.resolve(
  __dirname,
  '../../../web/src/pages/feeds/index.tsx',
);
const source = ts.createSourceFile(
  filename,
  fs.readFileSync(filename, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
function expression(name: string) {
  let value = '';
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name)
      value = node.initializer!.getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!value) throw new Error(`Missing page callback: ${name}`);
  return value;
}
function compile(code: string, values: Record<string, unknown>) {
  const scope = { module: { exports: {} }, ...values };
  vm.runInNewContext(
    ts.transpileModule(`module.exports = ${code}`, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2021,
        module: ts.ModuleKind.CommonJS,
      },
    }).outputText,
    scope,
  );
  return scope.module.exports as any;
}
function manual() {
  const refresh = jest.fn().mockResolvedValue(undefined);
  const options = compile(expression('manualBatches'), {
    manualObservedStates: { current: new Map() },
    manualObserved: { current: false },
    refreshSavedSubscriptions: refresh,
    toast: { warning: jest.fn() },
    trpc: {
      feed: {
        manualRefreshBatches: {
          useQuery: (_: unknown, config: unknown) => config,
        },
      },
    },
  });
  return { refresh, options };
}
const batch = (state: string, batchId = 'one') => ({
  batchId,
  state,
  items: [
    { state: state === 'running' ? 'waiting' : 'succeeded', bodyReady: false },
  ],
});

describe('feed task recovery callbacks (actual UI, offline)', () => {
  it('the actual manual progress component hides terminal records and uses short per-feed labels', () => {
    const componentFile = path.resolve(
      __dirname,
      '../../../web/src/pages/feeds/manual-refresh-progress.tsx',
    );
    const module = { exports: {} as any };
    const jsx = (type: unknown, props: unknown) => ({ type, props });
    vm.runInNewContext(
      ts.transpileModule(fs.readFileSync(componentFile, 'utf8'), {
        compilerOptions: {
          target: ts.ScriptTarget.ES2021,
          module: ts.ModuleKind.CommonJS,
          jsx: ts.JsxEmit.ReactJSX,
        },
      }).outputText,
      {
        module,
        exports: module.exports,
        require(id: string) {
          if (id === 'react')
            return {
              useRef: (value: unknown) => ({ current: value }),
              useState: (value: unknown) => [value, () => {}],
            };
          if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx };
          if (id === '@nextui-org/react')
            return { Button: 'Button', Progress: 'Progress' };
          if (id === '@web/utils/trpc')
            return {
              trpc: {
                feed: {
                  stopSubscriptionBatch: { useMutation: () => ({}) },
                  resumeSubscriptionBatch: { useMutation: () => ({}) },
                },
              },
            };
          throw new Error(id);
        },
      },
    );
    for (const state of ['completed', 'stopped'])
      expect(
        module.exports.default({
          batch: batch(state),
          feeds: [],
          onChange: jest.fn(),
        }),
      ).toBeNull();
    const tree = module.exports.default({
      batch: {
        ...batch('running'),
        items: [
          {
            state: 'succeeded',
            accepted: true,
            message: 'SYNTHETIC_LONG_TECHNICAL_MESSAGE',
          },
        ],
      },
      feeds: [],
      onChange: jest.fn(),
    });
    expect(JSON.stringify(tree)).toContain('缓存已同步');
    expect(JSON.stringify(tree)).not.toContain(
      'SYNTHETIC_LONG_TECHNICAL_MESSAGE',
    );
  });
  it('refreshes a new batch that finishes between two status reads once', async () => {
    const h = manual();
    await h.options.onSuccess({ items: [] });
    await h.options.onSuccess({ items: [batch('completed')] });
    await h.options.onSuccess({ items: [batch('completed')] });
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });
  it('history never invalidates views on mount/reentry, including stale waiting items', async () => {
    for (let entry = 0; entry < 3; entry++) {
      const h = manual();
      const data = {
        items: [{ ...batch('completed'), items: [{ state: 'waiting' }] }],
      };
      await h.options.onSuccess(data);
      await h.options.onSuccess(data);
      expect(h.refresh).not.toHaveBeenCalled();
      expect(
        h.options.refetchInterval(data, { state: { status: 'success' } }),
      ).toBe(false);
    }
  });
  it.each(['completed', 'paused', 'stopped'])(
    'observed running → %s refreshes once even with overlapping reads',
    async (state) => {
      const h = manual();
      await h.options.onSuccess({ items: [batch('running')] });
      let finish!: () => void;
      h.refresh.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      const data = { items: [batch(state)] };
      const pending = h.options.onSuccess(data);
      await h.options.onSuccess(data);
      expect(h.refresh).toHaveBeenCalledTimes(1);
      finish();
      await pending;
      await h.options.onSuccess(data);
      expect(h.refresh).toHaveBeenCalledTimes(1);
      expect(
        h.options.refetchInterval(data, { state: { status: 'success' } }),
      ).toBe(false);
    },
  );
  it('keeps another active batch polling and stops after query failure', async () => {
    const h = manual();
    await h.options.onSuccess({
      items: [batch('running'), batch('running', 'two')],
    });
    const data = { items: [batch('completed'), batch('running', 'two')] };
    await h.options.onSuccess(data);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(
      h.options.refetchInterval(data, { state: { status: 'success' } }),
    ).toBe(3000);
    expect(
      h.options.refetchInterval(data, { state: { status: 'error' } }),
    ).toBe(false);
    await h.options.onSuccess({
      items: [batch('completed'), batch('stopped', 'two')],
    });
    expect(h.refresh).toHaveBeenCalledTimes(2);
  });
  it('does not automatically retry a failed terminal view read', async () => {
    const h = manual();
    await h.options.onSuccess({ items: [batch('running')] });
    h.refresh.mockRejectedValue(new Error('SYNTHETIC_READ_FAILED'));
    await h.options.onSuccess({ items: [batch('completed')] });
    await h.options.onSuccess({ items: [batch('completed')] });
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });
  it('merges concurrent saved views and publishes the real feed list despite an article query failure', async () => {
    let finish!: (value: unknown) => void;
    const refetch = jest.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const ordered = jest.fn(),
      filter = jest.fn();
    const cancel = jest.fn(),
      reset = jest.fn().mockRejectedValue(new Error('SYNTHETIC_ARTICLES'));
    const refresh = compile(expression('refreshSavedSubscriptions'), {
      savedViewRefresh: { current: null },
      refetchFeedList: refetch,
      setOrderedFeeds: ordered,
      setFolderFilter: filter,
      folderFilter: 'hidden-folder',
      queryUtils: {
        feed: { list: { cancel } },
        article: { list: { reset }, summary: { invalidate: jest.fn() } },
      },
    });
    const first = refresh(false),
      second = refresh(true);
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    expect(filter).toHaveBeenCalledTimes(1);
    const feeds = [{ id: 'synthetic-feed', mpName: '合成公众号' }];
    finish({ data: { items: feeds } });
    await Promise.all([first, second]);
    expect(ordered).toHaveBeenCalledWith(feeds);
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
