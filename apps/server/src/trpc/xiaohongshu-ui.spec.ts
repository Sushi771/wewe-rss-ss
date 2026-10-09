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
function evaluate(
  name: string,
  scope: Record<string, unknown>,
  table = expressions,
) {
  const context = { module: { exports: undefined as any }, ...scope };
  vm.runInNewContext(
    ts.transpileModule('module.exports = ' + table[name], {
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
      Error,
      active: { current: false },
      setBusy: (v: boolean) => (state.busy = v),
      setMessage: (v: string) => (state.message = v),
      displayName: state.name,
      profileUrl: state.url,
      setDisplayName: (v: string) => (state.name = v),
      setProfileUrl: (v: string) => (state.url = v),
      setCreatorId: (v: string) => (state.creator = v),
      setNoteId: (v: string) => (state.note = v),
      setSelectedIds: jest.fn(),
      setFolderFilter: jest.fn(),
      setAdding: jest.fn(),
      setSearch: jest.fn(),
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
      /disabled=\{busy\}[\s\S]*?aria-pressed=\{creatorId === creator.id\}/,
    );
    state.creator = 'a';
    scope.active.current = true;
    evaluate('selectCreator', scope)('b');
    expect(state.creator).toBe('a');
    expect(text).toContain('if (active.current) return;');
  });
  it('uses cached-note ID local save as the primary flow, skips videos and creates no browser ZIP', async () => {
    const { scope, state } = harness();
    scope.current = { id: 'a', displayName: '博主A' };
    scope.saveSettings = {
      directory: 'synthetic-configured-directory',
      askEveryTime: false,
    };
    scope.selectedNotes = [{ id: 'note-a', status: 'complete' }];
    scope.localApi = jest
      .fn()
      .mockResolvedValue({ saved: true, savedCount: 1, alreadySavedCount: 0 });
    scope.exportNotes = { mutateAsync: jest.fn() };
    await evaluate('handleLocalSave', scope)();
    expect(scope.localApi.mock.calls).toEqual([
      ['/xiaohongshu/save', { creatorId: 'a', noteIds: ['note-a'] }],
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
    scope.selectedNotes = [
      { id: 'one', status: 'complete' },
      { id: 'two', status: 'complete' },
    ];
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
    expect(text).toContain('md:flex-row');
    expect(text).toContain('mac-toolbar');
    expect(text).toContain('compact-list');
  });
  it('clears selection on search and keeps creator/selection unchanged while processing', () => {
    const { scope, state } = harness();
    scope.setSelectedIds = jest.fn();
    scope.setSearch = jest.fn();
    evaluate('handleSearch', scope)('new title');
    expect(scope.setSearch).toHaveBeenCalledWith('new title');
    expect(scope.setSelectedIds.mock.calls[0][0].size).toBe(0);
    scope.active.current = true;
    scope.setSearch.mockClear();
    scope.setSelectedIds.mockClear();
    evaluate('handleSearch', scope)('ignored');
    evaluate('selectNote', scope)('ignored', true);
    expect(scope.setSearch).not.toHaveBeenCalled();
    expect(scope.setSelectedIds).not.toHaveBeenCalled();
    expect(state.creator).toBe('');
  });
  it('selects only matching complete notes and excludes hidden selection and unarchived video', () => {
    const scope = {
      notes: {
        data: {
          items: [
            { id: 'a', title: 'Match A', status: 'complete' },
            { id: 'b', title: 'Other', status: 'complete' },
            { id: 'v', title: 'Match Video', status: 'video-skipped' },
          ],
        },
      },
      search: 'match',
      useMemo: (fn: () => unknown) => fn(),
    };
    const visibleNotes = evaluate('visibleNotes', scope);
    const selectedNotes = evaluate('selectedNotes', {
      visibleNotes,
      selectedIds: new Set(['a', 'b', 'v']),
    });
    expect(selectedNotes.map((note: { id: string }) => note.id)).toEqual(['a']);
  });
  it('chooses a batch directory once and sends all selected IDs with one picker credential', async () => {
    const { scope, state } = harness();
    scope.current = { id: 'a', displayName: '博主A' };
    scope.saveSettings = { directory: 'old', askEveryTime: true };
    scope.selectedNotes = [{ id: 'one' }, { id: 'two' }];
    scope.setSaveSettings = jest.fn();
    scope.setDirectory = jest.fn();
    scope.localApi = jest
      .fn()
      .mockResolvedValueOnce({
        directory: 'chosen',
        askEveryTime: true,
        pickToken: 'synthetic-token',
      })
      .mockResolvedValueOnce({
        saved: true,
        savedCount: 2,
        alreadySavedCount: 1,
      });
    await evaluate('handleLocalSave', scope)();
    expect(scope.localApi.mock.calls).toEqual([
      ['/directory', {}],
      [
        '/xiaohongshu/save',
        {
          creatorId: 'a',
          noteIds: ['one', 'two'],
          pickToken: 'synthetic-token',
        },
      ],
    ]);
    expect(state.message).toContain('2 篇已保存');
  });
  it('does not label an unconfirmed count as successful and keeps server partial-save evidence', async () => {
    const { scope, state } = harness();
    scope.current = { id: 'a', displayName: '博主A' };
    scope.saveSettings = { directory: 'old', askEveryTime: false };
    scope.selectedNotes = [{ id: 'one' }, { id: 'two' }];
    scope.localApi = jest
      .fn()
      .mockResolvedValue({ saved: true, savedCount: 1, alreadySavedCount: 0 });
    await evaluate('handleLocalSave', scope)();
    expect(state.message).toContain('未完成');
    expect(state.message).not.toContain('2 篇已保存');
    scope.localApi.mockRejectedValue(new Error('已保存1篇，余下未保存'));
    await evaluate('handleLocalSave', scope)();
    expect(state.message).toContain('已保存1篇');
  });
  it('updates only the original askEveryTime setting and retains the native picker contract', async () => {
    const { scope } = harness();
    scope.saveSettings = { directory: 'old', askEveryTime: false };
    scope.setSaveSettings = jest.fn();
    scope.setDirectory = jest.fn();
    scope.localApi = jest
      .fn()
      .mockResolvedValue({ directory: 'old', askEveryTime: true });
    await evaluate('handleSaveSettings', scope)(true);
    expect(scope.localApi).toHaveBeenCalledWith('/settings', {
      askEveryTime: true,
    });
    scope.localApi.mockReset().mockResolvedValue({ cancelled: true });
    await evaluate('handleChooseDirectory', scope)();
    expect(scope.setDirectory).toHaveBeenCalledTimes(1);
  });
  it('exports exactly the selected notes and cleans up the browser download resource', async () => {
    const { scope, state } = harness();
    const link = {
      href: '',
      download: '',
      click: jest.fn(),
      remove: jest.fn(),
    };
    scope.current = { id: 'a', displayName: '博主A' };
    scope.selectedNotes = [{ id: 'one' }, { id: 'two' }];
    scope.exportNotes = {
      mutateAsync: jest.fn().mockResolvedValue({
        base64: '',
        mimeType: 'application/zip',
        filename: 'synthetic.zip',
        notes: 2,
      }),
    };
    scope.atob = () => '';
    scope.Blob = Blob;
    scope.URL = {
      createObjectURL: jest.fn().mockReturnValue('blob:synthetic'),
      revokeObjectURL: jest.fn(),
    };
    scope.document = {
      createElement: () => link,
      body: { appendChild: jest.fn() },
    };
    await evaluate('handleDownload', scope)();
    expect(scope.exportNotes.mutateAsync).toHaveBeenCalledWith({
      creatorId: 'a',
      noteIds: ['one', 'two'],
    });
    expect(link.click).toHaveBeenCalledTimes(1);
    expect(link.remove).toHaveBeenCalledTimes(1);
    expect(scope.URL.revokeObjectURL).toHaveBeenCalledWith('blob:synthetic');
    expect(state.message).toContain('2 篇完整图文 ZIP');
  });
});

describe('shared single-level management folder actual handlers (offline)', () => {
  const file = path.resolve(
    __dirname,
    '../../../web/src/components/ManagementFolders.tsx',
  );
  const source = fs.readFileSync(file, 'utf8');
  const syntax = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const table: Record<string, string> = {};
  function collect(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.initializer)
      table[node.name.getText(syntax)] = node.initializer.getText(syntax);
    ts.forEachChild(node, collect);
  }
  collect(syntax);
  function harness() {
    const scope = {
      Error,
      disabled: false,
      active: { current: false },
      onBusyChange: jest.fn(),
      setError: jest.fn(),
      selectedIds: ['a', 'b'],
      dragType: 'application/x-wewe-xiaohongshu',
      onMove: jest.fn().mockResolvedValue(undefined),
      run: undefined as unknown,
    };
    scope.run = evaluate('run', scope, table);
    return scope;
  }
  it('moves a selected batch atomically and ignores foreign-platform or external drops', async () => {
    const scope = harness();
    const drop = evaluate('drop', scope, table);
    const event = {
      preventDefault: jest.fn(),
      dataTransfer: { getData: jest.fn().mockReturnValue('') },
    };
    drop(event, 'folder');
    expect(scope.onMove).not.toHaveBeenCalled();
    event.dataTransfer.getData.mockReturnValue('a');
    drop(event, 'folder');
    await Promise.resolve();
    expect(event.dataTransfer.getData).toHaveBeenCalledWith(
      'application/x-wewe-xiaohongshu',
    );
    expect(scope.onMove).toHaveBeenCalledWith(['a', 'b'], 'folder');
  });
  it('moves an unselected item alone to ungrouped and blocks drop during processing', async () => {
    const scope = harness();
    const event = {
      preventDefault: jest.fn(),
      dataTransfer: { getData: () => 'c' },
    };
    evaluate('drop', scope, table)(event, null);
    await Promise.resolve();
    expect(scope.onMove).toHaveBeenCalledWith(['c'], null);
    scope.active.current = true;
    evaluate('drop', scope, table)(event, 'ignored');
    expect(scope.onMove).toHaveBeenCalledTimes(1);
  });
  it('prevents repeat operations, releases the busy guard and surfaces rejected group changes', async () => {
    const scope = harness();
    let finish!: () => void;
    const operation = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const run = evaluate('run', scope, table);
    const first = run(operation);
    await run(operation);
    expect(operation).toHaveBeenCalledTimes(1);
    finish();
    await first;
    expect(scope.onBusyChange.mock.calls).toEqual([[true], [false]]);
    await run(() => Promise.reject(new Error('组中仍有订阅，拒绝删除')));
    expect(scope.setError).toHaveBeenLastCalledWith('组中仍有订阅，拒绝删除');
    expect(scope.active.current).toBe(false);
  });
  it('shares folder controls across both real pages and provides a touch-friendly bulk button', () => {
    const feeds = fs.readFileSync(
      path.resolve(__dirname, '../../../web/src/pages/feeds/index.tsx'),
      'utf8',
    );
    expect(feeds).toContain('<ManagementFolders');
    expect(text).toContain('<ManagementFolders');
    expect(feeds).toContain('moveFeeds.mutateAsync({ ids, groupId })');
    expect(text).toContain('moveCreators.mutateAsync({ ids, groupId })');
    expect(source).toContain('移动已选');
    expect(source).not.toMatch(/parentId|粉丝|follower/i);
  });
  it('does not send a sorting update when a WeChat drag was consumed by folder assignment', async () => {
    const file = path.resolve(
      __dirname,
      '../../../web/src/pages/feeds/index.tsx',
    );
    const contents = fs.readFileSync(file, 'utf8');
    const syntax = ts.createSourceFile(
      file,
      contents,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const table: Record<string, string> = {};
    function collect(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && node.initializer)
        table[node.name.getText(syntax)] = node.initializer.getText(syntax);
      ts.forEachChild(node, collect);
    }
    collect(syntax);
    const scope = {
      movedIntoFolder: { current: true },
      folderOperation: { current: false },
      setDraggedItem: jest.fn(),
      orderedFeeds: [{ id: 'a' }, { id: 'b' }],
      updateOrder: jest.fn().mockResolvedValue(undefined),
      refetchFeedList: jest.fn(),
      toast: { success: jest.fn(), error: jest.fn() },
    };
    await evaluate('handleDragEnd', scope, table)();
    expect(scope.updateOrder).not.toHaveBeenCalled();
    expect(scope.movedIntoFolder.current).toBe(false);
    await evaluate('handleDragEnd', scope, table)();
    expect(scope.updateOrder).toHaveBeenCalledWith([
      { id: 'a', order: 0 },
      { id: 'b', order: 1 },
    ]);
  });
});
