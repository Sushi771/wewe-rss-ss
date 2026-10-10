import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as ts from 'typescript';

// Execute the actual React event handler with controlled hooks/mutations. No DOM
// or extension installation; this does not claim a real browser visual acceptance.
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
let expression = '';
const repairHandlers: Record<string, string> = {};
function visit(node: ts.Node) {
  if (
    ts.isVariableDeclaration(node) &&
    ['handleRepairConfirm', 'handleOpenRepair', 'handleCancelRepair'].includes(
      node.name.getText(source),
    )
  )
    repairHandlers[node.name.getText(source)] =
      node.initializer!.getText(source);
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(source) === 'handleConfirm'
  )
    expression = node.initializer!.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
if (!expression) throw new Error('Subscription add event handler missing');
const compiled = ts.transpileModule(`module.exports = ${expression};`, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2021,
    module: ts.ModuleKind.CommonJS,
  },
}).outputText;

function harness(links: string[], accountId = '123') {
  const state = { links: links.join('\n'), messages: [] as string[] };
  const mutate = jest.fn();
  const scope = {
    module: { exports: null as unknown },
    addingSubscriptions: { current: false },
    cancelSubscriptions: { current: false },
    setIsAddingSubscriptions: jest.fn(),
    addCapability: { available: true, requiresAccount: true },
    addSourceSelection: '',
    addAccountId: accountId,
    wxsLink: state.links,
    addSubscriptionBatch: mutate,
    setAddVerification: jest.fn(),
    setAddMessages: (update: string[] | ((previous: string[]) => string[])) => {
      state.messages =
        typeof update === 'function' ? update(state.messages) : update;
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
    onClose: jest.fn(),
  };
  vm.runInNewContext(compiled, scope, { timeout: 1000 });
  return {
    scope,
    state,
    mutate,
    run: scope.module.exports as () => Promise<void>,
  };
}
const url = (suffix: string) => `https://mp.weixin.qq.com/s/${suffix}`;
const added = {
  batchId: 'synthetic-batch',
  state: 'queued',
  items: [{ index: 0, state: 'queued' }],
};

describe('original subscription UI action (actual handler, offline)', () => {
  function repairHarness() {
    const state = {
      target: { id: 'MP_WXS_3456789012', mpName: '合成公众号' } as {
        id: string;
        mpName: string;
      } | null,
      messages: [] as string[],
    };
    const mutate = jest.fn();
    const scope = {
      module: { exports: null as any },
      addingSubscriptions: { current: false },
      cancelSubscriptions: { current: false },
      isOpen: false,
      repairTarget: state.target,
      defaultAddCapability: { existingRepairAvailable: true },
      addAccountId: '123',
      repairNativeSource: mutate,
      setIsAddingSubscriptions: jest.fn(),
      setRepairMessages: (messages: string[]) => {
        state.messages = messages;
      },
      setRepairTarget: (target: typeof state.target) => {
        state.target = target;
      },
      refreshFeedViews: jest.fn().mockResolvedValue(undefined),
      refetchFeedList: jest.fn(),
      queryUtils: {
        article: {
          list: { reset: jest.fn() },
          summary: { invalidate: jest.fn() },
        },
      },
      toast: { error: jest.fn(), success: jest.fn(), warning: jest.fn() },
    };
    vm.runInNewContext(
      ts.transpileModule(
        `module.exports={run:${repairHandlers.handleRepairConfirm},open:${repairHandlers.handleOpenRepair},cancel:${repairHandlers.handleCancelRepair}};`,
        {
          compilerOptions: {
            target: ts.ScriptTarget.ES2021,
            module: ts.ModuleKind.CommonJS,
          },
        },
      ).outputText,
      scope,
      { timeout: 1000 },
    );
    return {
      state,
      scope,
      mutate,
      ...(scope.module.exports as {
        run: () => Promise<void>;
        open: (feed: { id: string; mpName: string }) => void;
        cancel: () => void;
      }),
    };
  }
  it('repair opening/cancellation sends no request; confirming sends only selected existing feed/account/confirmation', async () => {
    const h = repairHarness();
    h.open({ id: 'MP_WXS_3456789012', mpName: '合成公众号' });
    expect(h.mutate).not.toHaveBeenCalled();
    h.mutate.mockResolvedValue({
      accepted: true,
      pending: false,
      feed: { id: 'MP_WXS_3456789012', mpName: '合成公众号' },
      message: '已修复',
    });
    await h.run();
    expect(h.mutate).toHaveBeenCalledWith({
      feedId: 'MP_WXS_3456789012',
      accountId: '123',
      confirmed: true,
    });
    expect(h.scope.refreshFeedViews).toHaveBeenCalledTimes(1);
    expect(h.state.target).toBeNull();
    expect(h.scope.toast.success).toHaveBeenCalledTimes(1);
    const cancel = repairHarness();
    cancel.cancel();
    expect(cancel.mutate).not.toHaveBeenCalled();
  });
  it('a failed repair preserves selected subscription/account and displays the actual refusal once', async () => {
    const h = repairHarness();
    h.mutate.mockResolvedValue({
      ...added,
      accepted: false,
      pending: true,
      feed: null,
      businessCode: -2041,
      message: '停止记录保留',
    });
    await h.run();
    expect(h.state.target?.id).toBe('MP_WXS_3456789012');
    expect(h.scope.addAccountId).toBe('123');
    expect(h.state.messages.join('')).toContain('业务码 -2041');
    expect(h.mutate).toHaveBeenCalledTimes(1);
    expect(h.scope.toast.success).not.toHaveBeenCalled();
  });
  it('repair requires an explicit normal account, guards double clicks and ignores a late result after closing', async () => {
    const missing = repairHarness();
    missing.scope.addAccountId = '';
    await missing.run();
    expect(missing.mutate).not.toHaveBeenCalled();
    const h = repairHarness();
    let finish: (result: unknown) => void = () => {};
    h.mutate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = h.run();
    await h.run();
    expect(h.mutate).toHaveBeenCalledTimes(1);
    h.cancel();
    finish({
      accepted: true,
      pending: false,
      feed: { id: 'MP_WXS_3456789012', mpName: '合成公众号' },
      message: '已修复',
    });
    await pending;
    expect(h.state.target).toBeNull();
    expect(h.scope.toast.success).not.toHaveBeenCalled();
    expect(h.scope.addingSubscriptions.current).toBe(false);
  });
  it('uses the paid batch API without requiring the native repair account', async () => {
    const h = harness([url('one')], '');
    h.mutate.mockResolvedValue(added);
    await h.run();
    expect(h.mutate).toHaveBeenCalledWith({ articleUrls: [url('one')] });
    expect(h.scope.toast.success).not.toHaveBeenCalled();
  });
  it('locks double clicks until the persisted batch acknowledgement settles', async () => {
    const h = harness([url('one'), url('two')]);
    let done!: (value: typeof added) => void;
    h.mutate.mockImplementation(
      () =>
        new Promise((resolve) => {
          done = resolve;
        }),
    );
    const first = h.run();
    await h.run();
    expect(h.mutate).toHaveBeenCalledTimes(1);
    done(added);
    await first;
    expect(h.scope.addingSubscriptions.current).toBe(false);
  });
  it('deduplicates input, rejects more than twenty links, and rejects impostor hosts', async () => {
    const h = harness([url('one'), url('one'), '', url('two')]);
    h.mutate.mockResolvedValue(added);
    await h.run();
    expect(h.mutate).toHaveBeenCalledWith({
      articleUrls: [url('one'), url('two')],
    });
    for (const links of [
      Array.from({ length: 21 }, (_, i) => url(String(i))),
      ['https://mp.weixin.qq.com.evil/s/one'],
    ]) {
      const invalid = harness(links);
      await invalid.run();
      expect(invalid.mutate).not.toHaveBeenCalled();
      expect(invalid.state.links).toBe(links.join('\n'));
    }
  });
});
