import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as ts from 'typescript';

// Actual frontend projections/handlers, with offline replies only. No platform.
const file = path.resolve(__dirname, '../../../web/src/pages/feeds/index.tsx');
const text = fs.readFileSync(file, 'utf8');
const source = ts.createSourceFile(
  file,
  text,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const expressions: Record<string, string> = {};
let accountQueryEnabled = '';
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.initializer)
    expressions[node.name.getText(source)] = node.initializer.getText(source);
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(source) === 'trpc.account.list.useQuery'
  ) {
    const options = node.arguments[1] as ts.ObjectLiteralExpression;
    const enabled = options.properties.find(
      (p) => ts.isPropertyAssignment(p) && p.name.getText(source) === 'enabled',
    ) as ts.PropertyAssignment;
    accountQueryEnabled = enabled.initializer.getText(source);
  }
  ts.forEachChild(node, visit);
}
visit(source);
function evaluate(expression: string, scope: Record<string, unknown>) {
  const context = {
    module: { exports: undefined as any },
    addCapabilityError: undefined,
    ...scope,
  };
  vm.runInNewContext(
    ts.transpileModule(`module.exports = ${expression};`, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2021,
        module: ts.ModuleKind.CommonJS,
      },
    }).outputText,
    context,
    { timeout: 1000 },
  );
  return context.module.exports;
}
const native = { source: 'native', available: true, requiresAccount: true };
const paid = { source: 'wechat2rss', available: true, requiresAccount: false };
const url = (suffix: string) => `https://mp.weixin.qq.com/s/${suffix}`;
const received = {
  batchId: 'synthetic-batch',
  state: 'queued',
  items: [
    { index: 0, state: 'queued' },
    { index: 1, state: 'queued' },
  ],
};
function project(sources: unknown[], error?: Error) {
  const defaultAddCapability = {
    ...native,
    sources,
    existingRepairAvailable: true,
  };
  const selectedAddSource = evaluate(expressions.selectedAddSource, {
    defaultAddCapability,
    addSourceSelection: evaluate(expressions.addSourceSelection, {}),
  });
  return evaluate(expressions.addCapability, {
    defaultAddCapability,
    selectedAddSource,
    addCapabilityError: error,
  });
}
function harness() {
  const state = {
    links: [url('one'), url('two')].join('\n'),
    messages: [] as string[],
  };
  const mutate = jest.fn();
  const scope = {
    addCapabilityError: undefined as Error | undefined,
    addCapability: paid as typeof paid | undefined,
    addAccountId: '123',
    wxsLink: state.links,
    repairTarget: null,
    addingSubscriptions: { current: false },
    cancelSubscriptions: { current: false },
    addSubscriptionBatch: mutate,
    setIsAddingSubscriptions: jest.fn(),
    setAddVerification: jest.fn(),
    setAddMessages: (value: string[] | ((previous: string[]) => string[])) => {
      state.messages =
        typeof value === 'function' ? value(state.messages) : value;
    },
    setWxsLink: (value: string | ((previous: string) => string)) => {
      state.links = typeof value === 'function' ? value(state.links) : value;
    },
    toast: { error: jest.fn(), success: jest.fn(), warning: jest.fn() },
    queryUtils: {
      feed: {
        list: { cancel: jest.fn().mockResolvedValue(undefined) },
        subscriptionBatches: {
          invalidate: jest.fn().mockResolvedValue(undefined),
        },
      },
      article: {
        list: { reset: jest.fn().mockResolvedValue(undefined) },
        summary: { invalidate: jest.fn().mockResolvedValue(undefined) },
      },
    },
    refetchFeedList: jest.fn(),
    folderFilter: 'all',
    setFolderFilter: jest.fn(),
    setOrderedFeeds: jest.fn(),
    onOpen: jest.fn(),
    onClose: jest.fn(),
  };
  return {
    scope,
    state,
    mutate,
    run: () => evaluate(expressions.handleConfirm, scope)() as Promise<void>,
    cancel: () => evaluate(expressions.handleCancelAdd, scope)(),
    open: () => evaluate(expressions.handleOpenAdd, scope)(),
  };
}
describe('Wechat2RSS-only add UI (offline)', () => {
  it('paid add does not read native accounts, while explicit existing repair retains that capability', () => {
    expect(
      evaluate(accountQueryEnabled, {
        isOpen: true,
        addCapability: paid,
        repairTarget: null,
        defaultAddCapability: { existingRepairAvailable: true },
      }),
    ).toBe(false);
    expect(
      evaluate(accountQueryEnabled, {
        isOpen: false,
        addCapability: undefined,
        repairTarget: { id: 'existing' },
        defaultAddCapability: { existingRepairAvailable: true },
      }),
    ).toBe(true);
  });
  it('projects only the paid capability even when native is the available default', () => {
    expect(project([native, paid])).toMatchObject(paid);
    expect(project([native, { ...paid, available: false }]).available).toBe(
      false,
    );
    expect(project([native])).toBeUndefined();
    expect(project([native, paid], new Error('stale read'))).toBeUndefined();
  });
  it('persists all normalized links in one batch, with no native account or frontend add loop', async () => {
    const h = harness();
    h.mutate.mockResolvedValue(received);
    await h.run();
    expect(h.mutate.mock.calls).toEqual([
      [{ articleUrls: [url('one'), url('two')] }],
    ]);
    expect(h.state.links).toBe('');
    expect(h.state.messages.join('')).toContain('已保存 2 条链接');
    expect(h.scope.toast.success).not.toHaveBeenCalled();
  });
  it('unavailable or missing paid capability never falls back to native', async () => {
    for (const capability of [undefined, { ...paid, available: false }]) {
      const h = harness();
      h.scope.addCapability = capability;
      await h.run();
      expect(h.mutate).not.toHaveBeenCalled();
      expect(h.state.links).toContain(url('one'));
    }
  });
  it('read failure after durable acknowledgement never retains repeatable input or claims success', async () => {
    const h = harness();
    h.mutate.mockResolvedValue(received);
    h.scope.queryUtils.feed.subscriptionBatches.invalidate.mockRejectedValue(
      new Error('local read'),
    );
    await h.run();
    expect(h.state.links).toBe('');
    expect(h.mutate).toHaveBeenCalledTimes(1);
    expect(h.scope.toast.success).not.toHaveBeenCalled();
    expect(h.state.messages.join('')).toContain('不要重复提交');
  });
  it('uncertain transport preserves input but only reads progress and never retries', async () => {
    const h = harness();
    h.mutate.mockRejectedValue(new Error('transport'));
    await h.run();
    expect(h.mutate).toHaveBeenCalledTimes(1);
    expect(h.state.links).toContain(url('two'));
    expect(
      h.scope.queryUtils.feed.subscriptionBatches.invalidate,
    ).toHaveBeenCalledTimes(1);
    expect(h.scope.toast.success).not.toHaveBeenCalled();
  });
});
