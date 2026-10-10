import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as ts from 'typescript';

// Execute actual handlers and capability projection. This is offline behavior
// verification; it does not represent browser rendering or real upstream use.
const file = path.resolve(__dirname, '../../../web/src/pages/feeds/index.tsx');
const source = ts.createSourceFile(
  file,
  fs.readFileSync(file, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const expressions: Record<string, string> = {};
const controls: Record<string, Record<string, string>> = {};
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.initializer)
    expressions[node.name.getText(source)] = node.initializer.getText(source);
  if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
    const props: Record<string, string> = {};
    for (const p of node.attributes.properties)
      if (ts.isJsxAttribute(p) && p.initializer)
        props[p.name.getText(source)] = ts.isJsxExpression(p.initializer)
          ? p.initializer.expression!.getText(source)
          : p.initializer.getText(source);
    if (props['aria-label']) controls[props['aria-label']] = props;
  }
  ts.forEachChild(node, visit);
}
visit(source);
function evaluate(expression: string, scope: Record<string, unknown>) {
  const context = { module: { exports: undefined as any }, ...scope };
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
const url = (suffix: string) => `https://mp.weixin.qq.com/s/${suffix}`;
const native = {
  source: 'native',
  available: true,
  requiresAccount: true,
  message: '验证所选账号的目录',
};
const paid = {
  source: 'wechat2rss',
  available: true,
  requiresAccount: false,
  message: '实例已配置，取文待核验',
};
const received = {
  requestedSource: 'wechat2rss',
  sourceBindingChanged: true,
  accepted: true,
  pending: false,
  status: 'updated',
  created: true,
  message: '首批缓存已读取，正文图片已入库。',
  feed: { id: 'MP_WXS_3456789012', mpName: '合成公众号' },
};

function harness(selected = '', links = [url('one'), url('two')]) {
  const state = {
    links: links.join('\n'),
    selected,
    messages: ['旧来源回执'],
    verification: { synthetic: true } as unknown,
  };
  const mutate = jest.fn();
  const scope: any = {
    addSourceSelection: selected,
    addCapability: selected === 'wechat2rss' ? paid : native,
    addAccountId: '123',
    wxsLink: state.links,
    repairTarget: null,
    addingSubscriptions: { current: false },
    cancelSubscriptions: { current: false },
    addFromArticle: mutate,
    setIsAddingSubscriptions: jest.fn(),
    setAddSourceSelection: (value: string) => {
      state.selected = value;
    },
    setAddVerification: (value: unknown) => {
      state.verification = value;
    },
    setAddMessages: (value: any) => {
      state.messages =
        typeof value === 'function' ? value(state.messages) : value;
    },
    setWxsLink: (value: any) => {
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
    onOpen: jest.fn(),
    onClose: jest.fn(),
  };
  return {
    state,
    scope,
    mutate,
    run: evaluate(expressions.handleConfirm, scope) as () => Promise<void>,
    select: evaluate(expressions.handleSelectAddSource, scope) as (
      value: string,
    ) => void,
    open: evaluate(expressions.handleOpenAdd, scope) as () => void,
    cancel: evaluate(expressions.handleCancelAdd, scope) as () => void,
  };
}

describe('source selector through original add UI (offline)', () => {
  it('keeps the default request unchanged, while explicit native is included', async () => {
    for (const selected of ['', 'native']) {
      const h = harness(selected, [url('one')]);
      h.mutate.mockResolvedValue({
        ...received,
        source: 'owner-weread-latest',
        pending: false,
        created: false,
        message: '已订阅',
      });
      await h.run();
      expect(h.mutate).toHaveBeenCalledWith({
        articleUrl: url('one'),
        accountId: '123',
        ...(selected ? { source: selected } : {}),
      });
    }
  });
  it('explicit paid never sends the native account and keeps its choice for every request', async () => {
    const h = harness('wechat2rss');
    h.mutate.mockResolvedValue(received);
    await h.run();
    expect(h.mutate.mock.calls).toEqual([
      [{ articleUrl: url('one'), accountId: undefined, source: 'wechat2rss' }],
      [{ articleUrl: url('two'), accountId: undefined, source: 'wechat2rss' }],
    ]);
    expect(h.state.links).toBe('');
    expect(h.state.selected).toBe('wechat2rss');
    expect(h.scope.toast.success.mock.calls[0][0]).toContain('缓存已入库');
  });
  it('existing binding receives a clear unchanged-source receipt instead of implying a paid switch', async () => {
    const h = harness('wechat2rss', [url('one')]);
    h.mutate.mockResolvedValue({
      ...received,
      sourceBindingChanged: false,
      status: 'source-preserved',
      created: false,
    });
    await h.run();
    expect(h.scope.toast.warning).toHaveBeenCalledWith('现有订阅来源保持', {
      description: expect.stringContaining('本号仍使用原来源'),
    });
    expect(h.scope.toast.success).not.toHaveBeenCalled();
    expect(h.mutate).toHaveBeenCalledTimes(1);
  });
  it('an unavailable selected source cannot submit or silently choose the available default', async () => {
    const defaultAddCapability = {
      ...native,
      sources: [native, { ...paid, available: false, message: '未启用' }],
    };
    const selectedAddSource = evaluate(expressions.selectedAddSource, {
      defaultAddCapability,
      addSourceSelection: 'wechat2rss',
    });
    const capability = evaluate(expressions.addCapability, {
      defaultAddCapability,
      selectedAddSource,
      addSourceSelection: 'wechat2rss',
    });
    const h = harness('wechat2rss');
    h.scope.addCapability = capability;
    // Re-create the actual handler after the simulated render updates its values.
    await evaluate(expressions.handleConfirm, h.scope)();
    expect(h.mutate).not.toHaveBeenCalled();
    expect(h.state.links).toBe([url('one'), url('two')].join('\n'));
    expect(h.state.selected).toBe('wechat2rss');
    expect(h.scope.toast.error).toHaveBeenCalledWith('暂不能新增订阅', {
      description: '未启用',
    });
  });
  it('unknown or removed selection remains unavailable, never reverting to default', () => {
    const defaultAddCapability = { ...native, sources: [native] };
    const selectedAddSource = evaluate(expressions.selectedAddSource, {
      defaultAddCapability,
      addSourceSelection: 'wechat2rss',
    });
    expect(
      evaluate(expressions.addCapability, {
        defaultAddCapability,
        selectedAddSource,
        addSourceSelection: 'wechat2rss',
      }),
    ).toBeUndefined();
  });
  it('source switch preserves links/account, clears old feedback, and sends no request', () => {
    const h = harness();
    h.select('wechat2rss');
    expect(h.state.selected).toBe('wechat2rss');
    expect(h.state.links).toBe([url('one'), url('two')].join('\n'));
    expect(h.scope.addAccountId).toBe('123');
    expect(h.state.messages).toEqual([]);
    expect(h.state.verification).toBeNull();
    expect(h.mutate).not.toHaveBeenCalled();
    h.select('arbitrary-url');
    expect(h.state.selected).toBe('wechat2rss');
  });
  it('after switching and rendering, the next click submits the newly selected paid source', async () => {
    const h = harness();
    h.select('wechat2rss');
    const defaultAddCapability = { ...native, sources: [native, paid] };
    const selectedAddSource = evaluate(expressions.selectedAddSource, {
      defaultAddCapability,
      addSourceSelection: h.state.selected,
    });
    h.scope.addSourceSelection = h.state.selected;
    h.scope.addCapability = evaluate(expressions.addCapability, {
      defaultAddCapability,
      selectedAddSource,
      addSourceSelection: h.state.selected,
    });
    h.mutate.mockResolvedValue(received);
    await evaluate(expressions.handleConfirm, h.scope)();
    expect(h.mutate.mock.calls[0][0]).toEqual({
      articleUrl: url('one'),
      source: 'wechat2rss',
      accountId: undefined,
    });
  });
  it('paid selection leaves native repair capability and its account query independent', () => {
    const defaultAddCapability = {
      ...native,
      existingRepairAvailable: true,
      sources: [native, paid],
    };
    const selectedAddSource = paid;
    const addCapability = evaluate(expressions.addCapability, {
      defaultAddCapability,
      selectedAddSource,
      addSourceSelection: 'wechat2rss',
    });
    expect(addCapability.existingRepairAvailable).toBe(true);
    let enabled = '';
    function inspect(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(source) === 'trpc.account.list.useQuery'
      ) {
        const options = node.arguments[1] as ts.ObjectLiteralExpression;
        const prop = options.properties.find(
          (p) =>
            ts.isPropertyAssignment(p) && p.name.getText(source) === 'enabled',
        ) as ts.PropertyAssignment;
        enabled = prop.initializer.getText(source);
      }
      ts.forEachChild(node, inspect);
    }
    inspect(source);
    expect(
      evaluate(enabled, {
        isOpen: true,
        repairTarget: null,
        addCapability,
        defaultAddCapability,
      }),
    ).toBe(false);
    expect(
      evaluate(enabled, {
        isOpen: false,
        repairTarget: { id: 'synthetic' },
        addCapability,
        defaultAddCapability,
      }),
    ).toBe(true);
  });
  it('failure retains the chosen source and remaining URLs, without raw codes or fallback', async () => {
    const h = harness('wechat2rss');
    h.mutate.mockRejectedValue(new Error('WECHAT2RSS_UPSTREAM_REJECTED'));
    await h.run();
    expect(h.mutate).toHaveBeenCalledTimes(1);
    expect(h.state.selected).toBe('wechat2rss');
    expect(h.state.links).toBe([url('one'), url('two')].join('\n'));
    expect(h.state.messages.join('')).toContain('授权和配置');
    expect(h.state.messages.join('')).not.toContain(
      'WECHAT2RSS_UPSTREAM_REJECTED',
    );
    expect(h.scope.onClose).not.toHaveBeenCalled();
  });
  it('blocks double submission, switching and reopen until cancellation settles; reopen preserves choice', async () => {
    const h = harness('wechat2rss');
    let finish!: (value: unknown) => void;
    h.mutate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const running = h.run();
    await h.run();
    h.select('native');
    h.cancel();
    h.open();
    expect(h.mutate).toHaveBeenCalledTimes(1);
    expect(h.state.selected).toBe('wechat2rss');
    expect(h.scope.onOpen).not.toHaveBeenCalled();
    finish(received);
    await running;
    expect(h.state.links).toBe(url('two'));
    expect(h.scope.toast.success).not.toHaveBeenCalled();
    h.open();
    expect(h.scope.onOpen).toHaveBeenCalledTimes(1);
    expect(h.state.selected).toBe('wechat2rss');
    h.select('native');
    expect(h.state.selected).toBe('native');
    expect(h.mutate).toHaveBeenCalledTimes(1);
  });
  it('late failure after cancellation preserves the target without stale failure notification', async () => {
    const h = harness('wechat2rss');
    let fail!: (error: Error) => void;
    h.mutate.mockImplementation(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    const running = h.run();
    h.cancel();
    fail(new Error('WECHAT2RSS_TIMEOUT'));
    await running;
    expect(h.state.links).toBe([url('one'), url('two')].join('\n'));
    expect(h.scope.toast.error).not.toHaveBeenCalled();
    expect(h.state.selected).toBe('wechat2rss');
  });
  it('the source control is locked for the whole batch and status is human readable', () => {
    const control = controls['"本次新增来源"'];
    expect(evaluate(control.disabled, { isAddFeedLoading: true })).toBe(true);
    expect(evaluate(control.disabled, { isAddFeedLoading: false })).toBe(false);
    const select = jest.fn();
    evaluate(control.onChange, { handleSelectAddSource: select })({
      target: { value: 'wechat2rss' },
    });
    expect(select).toHaveBeenCalledWith('wechat2rss');
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('新增后读取首批缓存');
    expect(text).toContain('已有订阅保留原来源');
    expect(text).not.toContain('{addCapability?.code}');
  });
});
