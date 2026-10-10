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
// Use the real imported batch helper in the extracted UI handler scope.
const batchExports: Record<string, unknown> = {};
vm.runInNewContext(
  ts.transpileModule(
    fs.readFileSync(
      path.resolve(__dirname, '../../../web/src/utils/xiaohongshu-refresh.ts'),
      'utf8',
    ),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2021,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText,
  { exports: batchExports, Error },
  { timeout: 1000 },
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
      setMobileSidebarOpen: jest.fn(),
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
      refreshCreatorBatch: batchExports.refreshCreatorBatch,
      receipts: { current: {} },
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
    const { scope, state } = harness();
    scope.capability.data.canRefresh = true;
    scope.updateCreator.mockResolvedValue('partial');
    await evaluate('handleRefreshAll', scope)();
    expect(scope.updateCreator.mock.calls).toEqual([['a']]);
    expect(state.message).toContain(
      '完成 0 位，未完成 1 位，未执行 1 位；已停用跳过 1 位',
    );
  });
  it('reports all completed creators without counting paused creators as completed', async () => {
    const { scope, state } = harness();
    scope.capability.data.canRefresh = true;
    scope.updateCreator.mockResolvedValue('complete');
    await evaluate('handleRefreshAll', scope)();
    expect(scope.updateCreator.mock.calls).toEqual([['a'], ['b']]);
    expect(state.message).toContain(
      '完成 2 位，未完成 0 位，未执行 0 位；已停用跳过 1 位',
    );
  });
  it('retains completed count when a later update throws and does not replay', async () => {
    const { scope, state } = harness();
    scope.capability.data.canRefresh = true;
    scope.updateCreator
      .mockResolvedValueOnce('complete')
      .mockRejectedValueOnce(new Error('synthetic failure'));
    await evaluate('handleRefreshAll', scope)();
    expect(scope.updateCreator.mock.calls).toEqual([['a'], ['b']]);
    expect(state.message).toContain(
      '完成 1 位，未完成 1 位，未执行 0 位；已停用跳过 1 位',
    );
    expect(state.message).toContain('synthetic failure');
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
    expect(state.message).toBe('博主A：窗口已完成 新增完整缓存笔记：1');
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
  it('uses selected complete cached-note IDs for local save and creates no browser ZIP', async () => {
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
    expect(state.message).toContain('新增保存 1 篇');
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
  it('closes mobile management after selecting a creator and keeps it unchanged while busy', () => {
    const { scope, state } = harness();
    scope.receipts = { current: { a: '博主A：旧回执' } };
    evaluate('selectCreator', scope)('a');
    expect(state.creator).toBe('a');
    expect(state.message).toBe('博主A：旧回执');
    expect(scope.setMobileSidebarOpen).toHaveBeenCalledWith(false);
    scope.setMobileSidebarOpen.mockClear();
    scope.active.current = true;
    evaluate('selectCreator', scope)('b');
    expect(state.creator).toBe('a');
    expect(scope.setMobileSidebarOpen).not.toHaveBeenCalled();
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
        savedCount: 1,
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
    expect(state.message).toContain('新增保存 1 篇，已有保存 1 篇');
  });
  it.each([
    [0, 2],
    [1, 1],
  ])(
    'confirms an existing or mixed batch with %i newly saved and %i already saved notes',
    async (savedCount, alreadySavedCount) => {
      const { scope, state } = harness();
      scope.current = { id: 'a', displayName: '博主A' };
      scope.saveSettings = { directory: 'old', askEveryTime: false };
      scope.selectedNotes = [{ id: 'one' }, { id: 'two' }];
      scope.localApi = jest
        .fn()
        .mockResolvedValue({ saved: true, savedCount, alreadySavedCount });
      await evaluate('handleLocalSave', scope)();
      expect(scope.localApi).toHaveBeenCalledTimes(1);
      expect(state.message).toContain(
        `博主A：本次新增保存 ${savedCount} 篇，已有保存 ${alreadySavedCount} 篇`,
      );
      expect(state.message).not.toContain('未完成');
      expect(state.message).not.toContain('其中');
    },
  );
  it.each([
    [-1, 3],
    [3, -1],
    [0.5, 1.5],
    [1.5, 0.5],
    ['1', 1],
    [1, '1'],
    [0, undefined],
    [undefined, 0],
    [0, null],
    [0, Infinity],
    [NaN, 2],
    [1, 2],
  ])(
    'rejects malformed or mismatched save counters %s and %s',
    async (savedCount, alreadySavedCount) => {
      const { scope, state } = harness();
      scope.current = { id: 'a', displayName: '博主A' };
      scope.saveSettings = { directory: 'old', askEveryTime: false };
      scope.selectedNotes = [{ id: 'one' }, { id: 'two' }];
      scope.localApi = jest
        .fn()
        .mockResolvedValue({ saved: true, savedCount, alreadySavedCount });
      await evaluate('handleLocalSave', scope)();
      expect(state.message).toContain('未完成');
      expect(state.message).not.toContain('本次新增保存');
      expect(scope.localApi).toHaveBeenCalledTimes(1);
    },
  );
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
    expect(state.message).toContain('2 篇完整缓存笔记 ZIP');
  });
  it('includes complete cached video in selection and excludes video without a complete archive', () => {
    const selectedNotes = evaluate('selectedNotes', {
      visibleNotes: [
        { id: 'image', kind: 'image-text', status: 'complete' },
        { id: 'video', kind: 'video', status: 'complete' },
        { id: 'pending-video', kind: 'video', status: 'video-skipped' },
      ],
      selectedIds: new Set(['image', 'video', 'pending-video']),
    });
    expect(selectedNotes.map((note: { id: string }) => note.id)).toEqual([
      'image',
      'video',
    ]);
  });
  it.each([
    ['image-text', 0],
    ['video', 1],
  ])(
    'sends complete %s IDs through the original batch save and displays confirmed video count %i',
    async (kind, videoCount) => {
      const { scope, state } = harness();
      scope.current = { id: 'a', displayName: '博主A' };
      scope.saveSettings = { directory: 'old', askEveryTime: false };
      scope.selectedNotes = [{ id: 'one', status: 'complete', kind }];
      scope.localApi = jest.fn().mockResolvedValue({
        saved: true,
        savedCount: 1,
        alreadySavedCount: 0,
        videoCount,
        ...(videoCount
          ? { videoDecoded: false, videoVerification: 'container-and-bytes' }
          : {}),
      });
      await evaluate('handleLocalSave', scope)();
      expect(scope.localApi.mock.calls).toEqual([
        ['/xiaohongshu/save', { creatorId: 'a', noteIds: ['one'] }],
      ]);
      expect(state.message).toContain('新增保存 1 篇');
      if (videoCount) {
        expect(state.message).toContain('1 篇含已归档 video 文件');
        expect(state.message).toContain('尚未解码或播放');
      } else {
        expect(state.message).toContain('本批次不含已归档视频');
        expect(state.message).not.toContain('含已归档 video 文件');
      }
    },
  );
  it('confirms existing video without treating it as newly saved or decoded', async () => {
    const { scope, state } = harness();
    scope.current = { id: 'a', displayName: '博主A' };
    scope.saveSettings = { directory: 'old', askEveryTime: false };
    scope.selectedNotes = [{ id: 'one', status: 'complete', kind: 'video' }];
    scope.localApi = jest.fn().mockResolvedValue({
      saved: true,
      savedCount: 0,
      alreadySavedCount: 1,
      videoCount: 1,
      videoDecoded: false,
      videoVerification: 'container-and-bytes',
    });
    await evaluate('handleLocalSave', scope)();
    expect(state.message).toContain('新增保存 0 篇，已有保存 1 篇');
    expect(state.message).toContain('1 篇含已归档 video 文件（含已有保存）');
    expect(state.message).toContain('尚未解码或播放');
  });
  it.each([
    {},
    { videoCount: 0 },
    { videoCount: -1 },
    { videoCount: 0.5 },
    { videoCount: 2 },
    { videoCount: null },
    { videoCount: 1 },
    {
      videoCount: 1,
      videoDecoded: true,
      videoVerification: 'container-and-bytes',
    },
    { videoCount: 1, videoDecoded: false, videoVerification: 'unknown' },
  ])(
    'keeps unconfirmed or mismatched video evidence out of the success receipt (%j)',
    async (evidence) => {
      const { scope, state } = harness();
      scope.current = { id: 'a', displayName: '博主A' };
      scope.saveSettings = { directory: 'old', askEveryTime: false };
      scope.selectedNotes = [{ id: 'one', status: 'complete', kind: 'video' }];
      scope.localApi = jest.fn().mockResolvedValue({
        saved: true,
        savedCount: 1,
        alreadySavedCount: 0,
        ...evidence,
      });
      await evaluate('handleLocalSave', scope)();
      expect(state.message).toContain('未完成');
      expect(state.message).not.toContain('新增保存');
      expect(scope.localApi).toHaveBeenCalledTimes(1);
    },
  );
  it('labels cached video honestly and renders metadata and cover only without requesting media', () => {
    const status = evaluate('noteStatus', {});
    expect(status({ status: 'complete', kind: 'video' })).toBe(
      '视频缓存（结构字节已核，未解码/播放）',
    );
    expect(status({ status: 'complete', kind: 'image-text' })).toBe('图文缓存');
    expect(status({ status: 'video-skipped', kind: 'video' })).toBe(
      '视频未归档',
    );
    expect(text).not.toContain('完整图文');
    expect(text).toContain('body.data.video.bytes');
    expect(text).toContain('本页不加载视频字节');
    expect(text).not.toMatch(
      /<video\b|video\/mp4;base64|video\.bytes\.toString|video\.url|createElement\(['"]video/,
    );
    expect(text).toContain('body.data.images.map');
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
  it('defaults both mobile management sidebars to hidden with selectors and keeps desktop sidebars', () => {
    const feeds = fs.readFileSync(
      path.resolve(__dirname, '../../../web/src/pages/feeds/index.tsx'),
      'utf8',
    );
    for (const contents of [feeds, text]) {
      expect(contents).toMatch(
        /\[mobileSidebarOpen, setMobileSidebarOpen\] = useState\(false\)/,
      );
      if (contents === feeds) {
        expect(contents).toContain(
          "mobileSidebarOpen ? 'feed-sidebar-open' : ''",
        );
        expect(contents).toContain('mac-sidebar feed-sidebar');
        const css = fs.readFileSync(
          path.resolve(__dirname, '../../../web/src/index.css'),
          'utf8',
        );
        expect(css).toMatch(
          /\.feed-sidebar\.mac-sidebar\s*\{\s*display:\s*none/,
        );
        expect(css).toMatch(
          /@media \(min-width: 768px\)[\s\S]*\.feed-sidebar\.mac-sidebar\s*\{\s*display:\s*flex/,
        );
      } else {
        // XHS keeps its existing important utilities; WeChat now owns its
        // mobile and desktop geometry in the single-scroll sidebar stylesheet.
        expect(contents).toContain("mobileSidebarOpen ? '!flex' : '!hidden'");
        expect(contents).toContain('md:!flex');
      }
      expect(contents).toContain('!min-w-0');
      expect(contents).toContain('aria-expanded={mobileSidebarOpen}');
    }
    expect(feeds).toContain('aria-label="手机选择公众号"');
    expect(text).toContain('aria-label="手机选择小红书博主"');
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
