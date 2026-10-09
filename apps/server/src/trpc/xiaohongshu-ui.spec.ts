import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as ts from 'typescript';

const filename = path.resolve(
  __dirname,
  '../../../web/src/pages/feeds/xiaohongshu.tsx',
);
const text = fs.readFileSync(filename, 'utf8');
const ast = ts.createSourceFile(
  filename,
  text,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const expressions: Record<string, string> = {};
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.initializer)
    expressions[node.name.getText(ast)] = node.initializer.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
function evaluate(name: string, scope: Record<string, unknown>) {
  const context = { module: { exports: undefined as any }, ...scope };
  vm.runInNewContext(
    ts.transpileModule('module.exports = ' + expressions[name], {
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
describe('formal XHS UI actual handlers (offline, not visual acceptance)', () => {
  function harness() {
    const state = {
      name: '待接入备注',
      url: 'https://www.xiaohongshu.com/synthetic-profile',
      message: '',
      creator: '',
      note: 'old-note',
      busy: false,
    };
    const invalidated = jest.fn().mockResolvedValue(undefined);
    const scope: any = {
      active: { current: false },
      setBusy: (v: boolean) => (state.busy = v),
      setMessage: (v: string) => (state.message = v),
      displayName: state.name,
      profileUrl: state.url,
      setDisplayName: (v: string) => (state.name = v),
      setProfileUrl: (v: string) => (state.url = v),
      setCreatorId: (v: string) => (state.creator = v),
      setNoteId: (v: string) => (state.note = v),
      add: { mutateAsync: jest.fn() },
      utils: { xiaohongshu: { list: { invalidate: invalidated } } },
      capability: { data: { canRefresh: false } },
      creators: {
        data: {
          items: [
            { id: 'a', enabled: true },
            { id: 'paused', enabled: false },
            { id: 'b', enabled: true },
          ],
        },
      },
      updateCreator: jest.fn(),
    };
    scope.run = evaluate('run', scope);
    return { scope, state, invalidated };
  }
  it('saves only a pending record and clears input only after actual persistence', async () => {
    const { scope, state } = harness();
    scope.add.mutateAsync.mockResolvedValue({
      subscribed: false,
      creator: { id: 'pending' },
      message: '已保存待接入博主；尚未读取笔记。',
    });
    await evaluate('handleAdd', scope)();
    expect(scope.add.mutateAsync).toHaveBeenCalledWith({
      displayName: '待接入备注',
      profileUrl: 'https://www.xiaohongshu.com/synthetic-profile',
    });
    expect(state.message).toContain('待接入');
    expect(state.creator).toBe('pending');
    expect(state.name).toBe('');
    expect(state.note).toBe('');
  });
  it('keeps inputs when persistence fails and does not invent a success', async () => {
    const { scope, state } = harness();
    scope.add.mutateAsync.mockRejectedValue(new Error('synthetic failure'));
    await evaluate('handleAdd', scope)();
    expect(state.name).toBe('待接入备注');
    expect(state.url).toContain('synthetic');
    expect(state.creator).toBe('');
    expect(state.message).toContain('未完成');
  });
  it('does not send an update when the source is unconfigured', async () => {
    const { scope } = harness();
    await evaluate('handleRefreshAll', scope)();
    expect(scope.updateCreator).not.toHaveBeenCalled();
  });
  it('skips paused creators and stops the batch at an incomplete window', async () => {
    const { scope } = harness();
    scope.capability.data.canRefresh = true;
    scope.updateCreator.mockResolvedValue('partial');
    await evaluate('handleRefreshAll', scope)();
    expect(scope.updateCreator.mock.calls).toEqual([['a']]);
  });
  it('prevents duplicate in-flight UI actions and releases its guard', async () => {
    const { scope, state } = harness();
    let finish!: () => void;
    const operation = jest.fn(() => new Promise<void>((r) => (finish = r)));
    const first = scope.run(operation);
    await scope.run(operation);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(state.busy).toBe(true);
    finish();
    await first;
    expect(state.busy).toBe(false);
    expect(scope.active.current).toBe(false);
  });
  it('is wired into the real application/navigation and uses no prototype fixture or remote body HTML', () => {
    expect(
      fs.readFileSync(
        path.resolve(__dirname, '../../../web/src/App.tsx'),
        'utf8',
      ),
    ).toContain('path="/xiaohongshu"');
    expect(
      fs.readFileSync(
        path.resolve(__dirname, '../../../web/src/components/Nav.tsx'),
        'utf8',
      ),
    ).toContain("href: '/xiaohongshu'");
    expect(text).toContain('trpc.xiaohongshu.body.useQuery');
    expect(text).toContain('trpc.xiaohongshu.export.useMutation');
    expect(text).not.toMatch(
      /prototypes\/|dangerouslySetInnerHTML|toast\.success/,
    );
    expect(text).toContain('md:grid-cols-');
  });
});
