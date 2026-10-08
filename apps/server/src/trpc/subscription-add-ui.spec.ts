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
    addAccountId: accountId,
    wxsLink: state.links,
    addFromArticle: mutate,
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
      article: {
        list: { reset: jest.fn().mockResolvedValue(undefined) },
        summary: { invalidate: jest.fn().mockResolvedValue(undefined) },
      },
    },
    refetchFeedList: jest.fn(),
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
  source: 'owner-weread-latest',
  status: 'updated',
  accepted: true,
  pending: false,
  created: true,
  feed: { id: 'MP_WXS_3456789012', mpName: '合成公众号' },
  message: '正文图片已保存',
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
      addCapability: { existingRepairAvailable: true },
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
    h.mutate.mockResolvedValue({ ...added, created: false });
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
    finish({ ...added, created: false });
    await pending;
    expect(h.state.target).toBeNull();
    expect(h.scope.toast.success).not.toHaveBeenCalled();
    expect(h.scope.addingSubscriptions.current).toBe(false);
  });
  it.each([
    'PUBLIC_ORIGINAL_LOGIN_REDIRECT',
    'PUBLIC_ORIGINAL_ARTICLE_REDIRECT',
    'PUBLIC_ORIGINAL_UNSUPPORTED_REDIRECT',
    'PUBLIC_ORIGINAL_VERIFICATION_REQUIRED',
  ])(
    'preserves URL and selected account on %s and sends no automatic followup',
    async (code) => {
      const h = harness([url('one'), url('next')], '123');
      h.mutate.mockResolvedValue({
        ...added,
        status: 'blocked',
        accepted: false,
        pending: true,
        feed: null,
        code,
        httpStatus: 302,
      });
      await h.run();
      expect(h.state.links).toBe([url('one'), url('next')].join('\n'));
      expect(h.scope.addAccountId).toBe('123');
      expect(h.scope.onClose).not.toHaveBeenCalled();
      expect(h.mutate).toHaveBeenCalledTimes(1);
    },
  );
  it('requires selected normal account before issuing discovery', async () => {
    const h = harness([url('one')], '');
    await h.run();
    expect(h.mutate).not.toHaveBeenCalled();
    expect(h.state.links).toBe(url('one'));
  });
  it('sends only one public URL and selected account, processes explicit submissions serially', async () => {
    const h = harness([url('one'), url('two')]);
    h.mutate.mockResolvedValue(added);
    await h.run();
    expect(h.mutate.mock.calls).toEqual([
      [{ articleUrl: url('one'), accountId: '123' }],
      [{ articleUrl: url('two'), accountId: '123' }],
    ]);
    expect(h.state.links).toBe('');
    expect(h.scope.onClose).toHaveBeenCalledTimes(1);
  });
  it('retains unknown candidate and queued links without claiming success or continuing probes', async () => {
    const h = harness([url('unknown'), url('next')]);
    h.mutate.mockResolvedValue({
      ...added,
      status: 'needs-verification',
      accepted: false,
      pending: true,
      feed: null,
      message: '未添加订阅',
    });
    await h.run();
    expect(h.mutate).toHaveBeenCalledTimes(1);
    expect(h.state.links).toBe([url('unknown'), url('next')].join('\n'));
    expect(h.scope.toast.success).not.toHaveBeenCalled();
    expect(h.scope.onClose).not.toHaveBeenCalled();
  });
  it('shows a later body challenge separately from directory-confirmed subscription and stops remaining additions', async () => {
    const h = harness([url('one'), url('next')]);
    h.mutate.mockResolvedValue({
      ...added,
      status: 'blocked',
      pending: true,
      businessCode: -2041,
      message: '目录已添加，正文尚未完成',
    });
    await h.run();
    expect(h.mutate).toHaveBeenCalledTimes(1);
    expect(h.state.links).toBe(url('next'));
    expect(h.state.messages.join('')).toContain('业务码 -2041');
    expect(h.scope.toast.success).not.toHaveBeenCalled();
    expect(h.scope.onClose).not.toHaveBeenCalled();
  });
  it('prevents duplicate clicks while one add is pending', async () => {
    const h = harness([url('one')]);
    let finish: (value: unknown) => void = () => undefined;
    h.mutate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = h.run();
    await h.run();
    expect(h.mutate).toHaveBeenCalledTimes(1);
    finish(added);
    await first;
    expect(h.scope.addingSubscriptions.current).toBe(false);
  });
  it('preserves the pending URL and displays the actual safe verification notice without a second mutation', async () => {
    const h = harness([url('one'), url('next')]);
    const verification = {
      status: 'available',
      articleUrl: 'https://mp.weixin.qq.com/s/' + 'a'.repeat(22),
      url: 'https://mp.weixin.qq.com/mp/verify?action=check',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
    h.mutate.mockResolvedValue({
      ...added,
      accepted: false,
      feed: null,
      pending: true,
      status: 'needs-verification',
      officialVerification: verification,
    });
    await h.run();
    expect(h.scope.setAddVerification).toHaveBeenLastCalledWith(verification);
    expect(h.mutate).toHaveBeenCalledTimes(1);
    expect(h.state.links).toBe([url('one'), url('next')].join('\n'));
    expect(h.scope.toast.success).not.toHaveBeenCalled();
  });
  it('bounds the explicit batch and deduplicates identical submitted links', async () => {
    const many = harness(Array.from({ length: 21 }, (_, n) => url(String(n))));
    await many.run();
    expect(many.mutate).not.toHaveBeenCalled();
    const same = harness([url('same'), url('same')]);
    same.mutate.mockResolvedValue(added);
    await same.run();
    expect(same.mutate).toHaveBeenCalledTimes(1);
  });
});
