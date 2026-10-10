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
    addSourceSelection: '',
    addAccountId: accountId,
    repairTarget: null,
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
  batchId: 'synthetic-batch',
  state: 'queued',
  items: [
    { index: 0, state: 'queued' },
    { index: 1, state: 'queued' },
  ],
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

describe('durable batch modal closing (actual handlers, offline)', () => {
  it('closing only hides the modal and does not cancel or replay the persisted batch', async () => {
    const h = harness([url('one'), url('two')]);
    let done!: (value: typeof added) => void;
    h.mutate.mockImplementation(
      () =>
        new Promise((resolve) => {
          done = resolve;
        }),
    );
    const first = h.run();
    h.cancel();
    await h.run();
    expect(h.scope.onClose).toHaveBeenCalledTimes(1);
    expect(h.mutate).toHaveBeenCalledTimes(1);
    done(added);
    await first;
    expect(h.state.links).toBe('');
    expect(h.state.messages.join('')).toContain('关闭窗口后仍会继续');
    expect(h.scope.toast.success).not.toHaveBeenCalled();
  });
  it('a late response does not overwrite newer input', async () => {
    const h = harness([url('one')]);
    let done!: (value: typeof added) => void;
    h.mutate.mockImplementation(
      () =>
        new Promise((resolve) => {
          done = resolve;
        }),
    );
    const first = h.run();
    h.state.links = url('new');
    done(added);
    await first;
    expect(h.state.links).toBe(url('new'));
  });
  it('controls remain disabled during the atomic request and backdrop uses the same close handler', () => {
    const attrs = attributes('Button', 'onPress', 'handleConfirm');
    expect(
      evaluate(attrs.isDisabled, {
        isAddFeedLoading: true,
        addCapability: { available: true },
        wxsLink: url('one'),
      }),
    ).toBe(true);
    const input = attributes('Textarea', 'label', '"文章链接"');
    expect(evaluate(input.isDisabled, { isAddFeedLoading: true })).toBe(true);
    expect(initializer('isAddFeedLoading')).toContain('isAddingSubscriptions');
    expect(fs.readFileSync(filename, 'utf8')).toContain(
      'open ? handleOpenAdd() : handleCancelAdd()',
    );
  });
});
