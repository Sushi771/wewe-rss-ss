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
  it('labels late and batch update receipts with their actual creator and disables selection during operations', async () => {
    const { scope, state } = harness();
    let finish!: (result: unknown) => void;
    scope.creators.data.items[0].displayName = '博主A';
    scope.refresh = {
      mutateAsync: jest.fn(
        () =>
          new Promise((r) => {
            finish = r;
          }),
      ),
    };
    scope.receipts = { current: {} };
    scope.utils.xiaohongshu.notes = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };
    const update = evaluate('updateCreator', scope)('a');
    state.creator = 'b';
    finish({ message: '窗口已完成', added: 1, status: 'complete' });
    await update;
    expect(state.message).toBe('博主A：窗口已完成 新增完整图文：1');
    expect(scope.receipts.current.a).toBe(state.message);
    expect(text).toMatch(
      /disabled=\{busy\}[\s\S]*?aria-pressed=\{creatorId === c.id\}/,
    );
    expect(text).toContain('if (active.current) return;');
  });
  it('uses cached-note ID local save as the primary flow, skips videos and creates no browser ZIP', async () => {
    const { scope, state } = harness();
    scope.current = { id: 'a', displayName: '博主A' };
    scope.saveSettings = {
      directory: 'synthetic-configured-directory',
      askEveryTime: false,
    };
    scope.notes = {
      data: {
        items: [
          { id: 'note-a', status: 'complete' },
          { id: 'video', status: 'video-skipped' },
        ],
      },
    };
    scope.localApi = jest
      .fn()
      .mockResolvedValue({ saved: true, alreadySaved: false });
    scope.exportNotes = { mutateAsync: jest.fn() };
    await evaluate('handleLocalSave', scope)();
    expect(scope.localApi.mock.calls).toEqual([
      ['/xiaohongshu/note-a/save', { creatorId: 'a' }],
    ]);
    expect(scope.exportNotes.mutateAsync).not.toHaveBeenCalled();
    expect(state.message).toContain('1 篇已保存');
    expect(text.indexOf('onPress={handleLocalSave}')).toBeLessThan(
      text.indexOf('onPress={handleDownload}'),
    );
  });
  it('stops a local-save batch on native picker cancellation or a failed save without retrying', async () => {
    const { scope, state } = harness();
    scope.current = { id: 'a', displayName: '博主A' };
    scope.saveSettings = {
      directory: 'synthetic-configured-directory',
      askEveryTime: true,
    };
    scope.notes = {
      data: {
        items: [
          { id: 'one', status: 'complete' },
          { id: 'two', status: 'complete' },
        ],
      },
    };
    scope.localApi = jest.fn().mockResolvedValue({ cancelled: true });
    scope.setSaveSettings = jest.fn();
    await evaluate('handleLocalSave', scope)();
    expect(scope.localApi.mock.calls).toEqual([['/directory', {}]]);
    expect(state.message).toContain('已取消');
    scope.saveSettings.askEveryTime = false;
    scope.localApi.mockReset().mockRejectedValue(new Error('SYNTHETIC_FAILED'));
    await evaluate('handleLocalSave', scope)();
    expect(scope.localApi).toHaveBeenCalledTimes(1);
    expect(state.message).toContain('未完成');
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
