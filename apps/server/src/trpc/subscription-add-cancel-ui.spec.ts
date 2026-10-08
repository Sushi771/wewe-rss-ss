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
let cancelExpression = '';
let openExpression = '';
function visit(node: ts.Node) {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(source) === 'handleConfirm'
  )
    expression = node.initializer!.getText(source);
  if (ts.isVariableDeclaration(node)) {
    if (node.name.getText(source) === 'handleCancelAdd')
      cancelExpression = node.initializer!.getText(source);
    if (node.name.getText(source) === 'handleOpenAdd')
      openExpression = node.initializer!.getText(source);
  }
  ts.forEachChild(node, visit);
}
visit(source);
if (!expression || !cancelExpression || !openExpression)
  throw new Error('Subscription add event handler missing');
const compiled = ts.transpileModule(
  `module.exports = {run:${expression},cancel:${cancelExpression},open:${openExpression}};`,
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2021,
      module: ts.ModuleKind.CommonJS,
    },
  },
).outputText;

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
    onOpen: jest.fn(),
    onClose: jest.fn(),
  };
  vm.runInNewContext(compiled, scope, { timeout: 1000 });
  return {
    scope,
    state,
    mutate,
    ...(scope.module.exports as {
      run: () => Promise<void>;
      cancel: () => void;
      open: () => void;
    }),
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

function evaluate(expression: string, values: Record<string, unknown>) {
  const context = { module: { exports: undefined as unknown }, ...values };
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

function attributes(tag: string, marker: string, value: string) {
  let result: Record<string, string> | undefined;
  function inspect(node: ts.Node) {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText(source) === tag
    ) {
      const props: Record<string, string> = {};
      for (const attribute of node.attributes.properties) {
        if (ts.isJsxAttribute(attribute) && attribute.initializer)
          props[attribute.name.getText(source)] = ts.isJsxExpression(
            attribute.initializer,
          )
            ? attribute.initializer.expression!.getText(source)
            : attribute.initializer.getText(source);
      }
      if (props[marker] === value) result = props;
    }
    ts.forEachChild(node, inspect);
  }
  inspect(source);
  if (!result) throw new Error(`UI control missing: ${tag} ${marker}`);
  return result;
}

function initializer(name: string) {
  let result = '';
  function inspect(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name)
      result = node.initializer!.getText(source);
    ts.forEachChild(node, inspect);
  }
  inspect(source);
  if (!result) throw new Error(`UI initializer missing: ${name}`);
  return result;
}

describe('subscription batch cancellation (actual handlers, offline)', () => {
  it('cancel closes once, waits for the in-flight result and stops unsent publishers', async () => {
    const h = harness([url('one'), url('two')]);
    let finish!: (value: unknown) => void;
    h.mutate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = h.run();
    h.cancel();
    expect(h.scope.onClose).toHaveBeenCalledTimes(1);
    expect(h.scope.addingSubscriptions.current).toBe(true);
    expect(h.scope.toast.warning).toHaveBeenCalledWith(
      expect.stringContaining('已发送的请求无法撤回'),
    );
    finish(added);
    await first;
    expect(h.mutate).toHaveBeenCalledTimes(1);
    expect(h.state.links).toBe(url('two'));
    expect(h.scope.onClose).toHaveBeenCalledTimes(1);
    expect(h.scope.setIsAddingSubscriptions.mock.calls).toEqual([
      [true],
      [false],
    ]);
  });
  it('blocks reopening and another batch until the cancelled in-flight request settles', async () => {
    const h = harness([url('one'), url('two')]);
    let finish!: (value: unknown) => void;
    h.mutate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = h.run();
    h.cancel();
    h.open();
    await h.run();
    expect(h.scope.onOpen).not.toHaveBeenCalled();
    expect(h.mutate).toHaveBeenCalledTimes(1);
    finish(added);
    await first;
    h.open();
    expect(h.scope.onOpen).toHaveBeenCalledTimes(1);
    h.scope.wxsLink = h.state.links;
    h.mutate.mockResolvedValue(added);
    await h.run();
    expect(h.mutate.mock.calls[1][0]).toEqual({
      articleUrl: url('two'),
      accountId: '123',
    });
    expect(h.scope.cancelSubscriptions.current).toBe(false);
  });
  it('stops the next publisher when cancelled while refreshing the first result caches', async () => {
    const h = harness([url('one'), url('two')]);
    h.mutate.mockResolvedValue(added);
    let release!: () => void;
    let entered!: () => void;
    const refreshing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    h.scope.queryUtils.article.list.reset.mockImplementationOnce(() => {
      entered();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const first = h.run();
    await refreshing;
    h.cancel();
    h.open();
    expect(h.scope.onOpen).not.toHaveBeenCalled();
    release();
    await first;
    expect(h.mutate).toHaveBeenCalledTimes(1);
    expect(h.state.links).toBe(url('two'));
  });
  it('retains the in-flight failed target after cancellation and never sends the rest', async () => {
    const h = harness([url('one'), url('two')]);
    let fail!: (error: Error) => void;
    h.mutate.mockImplementation(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    const first = h.run();
    h.cancel();
    fail(new Error('合成HTTP401'));
    await first;
    expect(h.mutate).toHaveBeenCalledTimes(1);
    expect(h.state.links).toBe([url('one'), url('two')].join('\n'));
    expect(h.scope.toast.success).not.toHaveBeenCalled();
    expect(h.scope.addingSubscriptions.current).toBe(false);
  });
  it('does not overwrite newer input when an older submitted snapshot finishes', async () => {
    const h = harness([url('one')]);
    let finish!: (value: unknown) => void;
    h.mutate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = h.run();
    h.cancel();
    h.state.links = url('newer-input');
    finish(added);
    await first;
    expect(h.state.links).toBe(url('newer-input'));
    expect(h.scope.onClose).toHaveBeenCalledTimes(1);
  });
  it('stops a detached old page batch and isolates a newer page batch', async () => {
    const old = harness([url('old-one'), url('old-two')]);
    let finish!: (value: unknown) => void;
    old.mutate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = old.run();
    let cleanup = '';
    function inspect(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(source) === 'useEffect' &&
        node.arguments[0]
          ?.getText(source)
          .includes('cancelSubscriptions.current = true')
      )
        cleanup = node.arguments[0].getText(source);
      ts.forEachChild(node, inspect);
    }
    inspect(source);
    const effect = evaluate(cleanup, old.scope) as () => () => void;
    effect()();
    const fresh = harness([url('fresh')], '456');
    fresh.mutate.mockResolvedValue(added);
    await fresh.run();
    finish(added);
    await first;
    expect(old.mutate).toHaveBeenCalledTimes(1);
    expect(old.scope.onClose).not.toHaveBeenCalled();
    expect(fresh.mutate).toHaveBeenCalledWith({
      articleUrl: url('fresh'),
      accountId: '456',
    });
    expect(fresh.state.links).toBe('');
  });
  it('locks input, account, opener and confirm across the whole batch, including cache waits', () => {
    const values = {
      isAddFeedLoading: true,
      isGetMpInfoLoading: false,
      isGetArticlesLoading: false,
      addCapability: { available: true, requiresAccount: true },
      addAccountId: '123',
      wxsLink: url('one'),
    };
    const textarea = attributes('Textarea', 'value', 'wxsLink');
    const account = attributes('select', 'value', 'addAccountId');
    const opener = attributes('Button', 'onPress', 'handleOpenAdd');
    const confirm = attributes('Button', 'onPress', 'handleConfirm');
    for (const expression of [
      textarea.isDisabled,
      account.disabled,
      opener.isDisabled,
      confirm.isDisabled,
      confirm.isLoading,
    ])
      expect(evaluate(expression, values)).toBe(true);
    const setWxsLink = jest.fn(),
      setAddAccountId = jest.fn();
    const locked = {
      addingSubscriptions: { current: true },
      setWxsLink,
      setAddAccountId,
    };
    (evaluate(textarea.onValueChange, locked) as (value: string) => void)(
      url('other'),
    );
    (evaluate(account.onChange, locked) as (event: unknown) => void)({
      target: { value: '456' },
    });
    expect(setWxsLink).not.toHaveBeenCalled();
    expect(setAddAccountId).not.toHaveBeenCalled();
    locked.addingSubscriptions.current = false;
    (evaluate(textarea.onValueChange, locked) as (value: string) => void)(
      url('other'),
    );
    (evaluate(account.onChange, locked) as (event: unknown) => void)({
      target: { value: '456' },
    });
    expect(setWxsLink).toHaveBeenCalledWith(url('other'));
    expect(setAddAccountId).toHaveBeenCalledWith('456');
  });
  it('routes backdrop/Esc/close changes through the same queue cancellation', async () => {
    const h = harness([url('one'), url('two')]);
    let finish!: (value: unknown) => void;
    h.mutate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = h.run();
    const modal = attributes('Modal', 'isOpen', 'isOpen');
    const change = evaluate(modal.onOpenChange, {
      handleOpenAdd: h.open,
      handleCancelAdd: h.cancel,
    }) as (open: boolean) => void;
    change(false);
    change(true);
    expect(h.scope.onOpen).not.toHaveBeenCalled();
    finish(added);
    await first;
    expect(h.mutate).toHaveBeenCalledTimes(1);
    expect(h.state.links).toBe(url('two'));
  });
  it('describes both supported bound WeRead modes without claiming every feed returns one or ten', () => {
    const values = {
      acceptanceMode: false,
      collectionChannel: 'owner-weread-latest',
      collectionRoute: { selectedBy: 'saved' },
      currentAlbumIds: [],
    };
    const description = evaluate(
      initializer('collectionDescription'),
      values,
    ) as string;
    expect(description).toContain('已连接目录模式按最近10篇');
    expect(description).toContain('旧当前篇模式读取一篇');
    expect(description).toContain('实际返回数量和完成情况以最近操作结果为准');
    expect(description).toContain('不保证全部历史');
    expect(evaluate(initializer('collectionChannelLabel'), values)).toBe(
      '腾讯读书订阅更新',
    );
  });
});
