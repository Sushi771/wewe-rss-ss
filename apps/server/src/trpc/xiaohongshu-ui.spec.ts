import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as ts from 'typescript';

const filename = path.resolve(
  process.env.XHS_UI_SOURCE_ROOT || path.resolve(__dirname, '../../../web'),
  'src/pages/feeds/xiaohongshu.tsx',
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
const messageExports: Record<string, unknown> = {};
vm.runInNewContext(
  ts.transpileModule(
    fs.readFileSync(
      path.resolve(__dirname, '../../../web/src/utils/operation-message.ts'),
      'utf8',
    ),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2021,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText,
  { exports: messageExports },
  { timeout: 1000 },
);
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
const taskExports: Record<string, any> = {};
vm.runInNewContext(
  ts.transpileModule(
    fs.readFileSync(
      path.resolve(
        path.dirname(filename),
        '../../utils/xiaohongshu-subscription.ts',
      ),
      'utf8',
    ),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2021,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText,
  { exports: taskExports, Error, setTimeout, clearTimeout },
  { timeout: 1000 },
);
const effects: Record<string, string> = {};
function collectTaskEffect(node: ts.Node) {
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(ast) === 'useEffect' &&
    node.arguments[0]?.getText(ast).includes('watchSubscriptionTask')
  )
    effects.taskEffect = node.arguments[0].getText(ast);
  ts.forEachChild(node, collectTaskEffect);
}
collectTaskEffect(ast);

describe('formal XHS async subscription UI actual handlers (offline, not visual acceptance)', () => {
  const terminal = (state = 'completed') => ({
    kind: 'download',
    state,
    total: 2,
    completed: state === 'completed' ? 2 : 0,
    skipped: 0,
    failed: 0,
    remaining: state === 'completed' ? 0 : 2,
  });
  function harness() {
    const state: any = {
      busy: false,
      message: '',
      error: '',
      creator: '',
      note: 'old',
      url: 'https://www.xiaohongshu.com/user/profile/synthetic',
      resolution: null,
      task: null,
      taskId: '',
      selected: new Set(),
      dates: null,
    };
    const invalidated = jest.fn().mockResolvedValue(undefined);
    const scope: any = {
      Error,
      Date,
      Set,
      Promise,
      AbortController,
      useCallback: (fn: unknown) => fn,
      active: { current: false },
      taskRunning: { current: false },
      cancelPending: { current: false },
      queuedCreators: { current: [] },
      profileUrl: state.url,
      taskId: 'task-one',
      resolution: null,
      subscriptionGroup: '',
      failureMessage: messageExports.failureMessage,
      taskFinished: taskExports.taskFinished,
      taskText: taskExports.taskText,
      selectedImageNotes: taskExports.selectedImageNotes,
      current: { id: 'a', displayName: '合成作者' },
      selectedNotes: [{ id: 'note-a', status: 'listed', kind: 'image-text' }],
      saveSettings: { directory: 'synthetic-only', askEveryTime: false },
      creators: {
        data: {
          items: [
            { id: 'a', enabled: true },
            { id: 'paused', enabled: false },
            { id: 'b', enabled: true },
          ],
        },
      },
      utils: {
        xiaohongshu: {
          list: { invalidate: invalidated },
          notes: { invalidate: invalidated },
        },
      },
      subscriptionApi: {
        resolveSubscription: { mutate: jest.fn() },
        subscribe: { mutate: jest.fn() },
        refresh: {
          mutate: jest
            .fn()
            .mockResolvedValue({ taskId: 'task-one', creatorId: 'a' }),
        },
        downloadNotes: {
          mutate: jest
            .fn()
            .mockResolvedValue({ taskId: 'download-one', creatorId: 'a' }),
        },
        cancelTask: { mutate: jest.fn().mockResolvedValue(undefined) },
        task: { query: jest.fn() },
      },
      localApi: jest.fn(),
      exportNotes: { mutateAsync: jest.fn() },
      watchSubscriptionTask: jest.fn().mockResolvedValue(undefined),
    };
    for (const [setter, property] of Object.entries({
      setBusy: 'busy',
      setMessage: 'message',
      setOperationError: 'error',
      setCreatorId: 'creator',
      setNoteId: 'note',
      setProfileUrl: 'url',
      setResolution: 'resolution',
      setTask: 'task',
      setTaskId: 'taskId',
      setDateSelection: 'dates',
      setSelectedIds: 'selected',
    }))
      scope[setter] = jest.fn((v: unknown) => (state[property] = v));
    for (const name of [
      'setProgressOpen',
      'setCancelling',
      'setSaveSettings',
      'setDirectory',
      'setFolderFilter',
      'setAdding',
      'setSearch',
      'setMobileSidebarOpen',
    ])
      scope[name] = jest.fn();
    scope.startTask = evaluate('startTask', scope);
    scope.run = evaluate('run', scope);
    scope.updateCreator = evaluate('updateCreator', scope);
    return { scope, state, invalidated };
  }
  function watch(scope: any) {
    evaluate('taskEffect', scope, effects)();
    return scope.watchSubscriptionTask.mock.calls[0][0];
  }
  it('resolves author information for confirmation without subscribing, listing or downloading', async () => {
    const { scope, state } = harness();
    const resolution = {
      resolutionId: 'resolve-one',
      author: { id: 'author', name: '已核实作者' },
      expiresAt: Date.now() + 60000,
    };
    scope.subscriptionApi.resolveSubscription.mutate.mockResolvedValue(
      resolution,
    );
    await evaluate('handleResolve', scope)();
    expect(
      scope.subscriptionApi.resolveSubscription.mutate,
    ).toHaveBeenCalledWith({ url: state.url });
    expect(state.resolution).toEqual(resolution);
    expect(scope.subscriptionApi.subscribe.mutate).not.toHaveBeenCalled();
    expect(scope.subscriptionApi.refresh.mutate).not.toHaveBeenCalled();
    expect(scope.subscriptionApi.downloadNotes.mutate).not.toHaveBeenCalled();
  });
  it('retains input when resolution fails and does not invent success', async () => {
    const { scope, state } = harness();
    scope.subscriptionApi.resolveSubscription.mutate.mockRejectedValue(
      new Error('synthetic resolve failure'),
    );
    await evaluate('handleResolve', scope)();
    expect(state.url).toContain('synthetic');
    expect(state.resolution).toBeNull();
    expect(state.error).toContain('synthetic');
  });
  it('confirms only the server resolution, applies the chosen group and clears input after persistence', async () => {
    const { scope, state, invalidated } = harness();
    scope.resolution = {
      resolutionId: 'resolve-one',
      expiresAt: Date.now() + 60000,
      existingCreatorId: null,
    };
    scope.subscriptionGroup = 'xhs-group';
    scope.subscriptionApi.subscribe.mutate.mockResolvedValue({
      subscribed: true,
      created: true,
      creatorId: 'subscribed',
    });
    await evaluate('handleAdd', scope)();
    expect(scope.subscriptionApi.subscribe.mutate).toHaveBeenCalledWith({
      resolutionId: 'resolve-one',
      groupId: 'xhs-group',
    });
    expect(state.creator).toBe('subscribed');
    expect(state.url).toBe('');
    expect(state.note).toBe('');
    expect(invalidated).toHaveBeenCalled();
    expect(scope.subscriptionApi.downloadNotes.mutate).not.toHaveBeenCalled();
  });
  it('does not submit stale confirmation or clear an input after rejected persistence', async () => {
    const { scope, state } = harness();
    scope.resolution = { resolutionId: 'old', expiresAt: Date.now() - 1 };
    await evaluate('handleAdd', scope)();
    expect(scope.subscriptionApi.subscribe.mutate).not.toHaveBeenCalled();
    expect(state.url).toContain('synthetic');
    scope.resolution.expiresAt = Date.now() + 60000;
    scope.subscriptionApi.subscribe.mutate.mockRejectedValue(
      new Error('synthetic persistence failure'),
    );
    await evaluate('handleAdd', scope)();
    expect(state.creator).toBe('');
    expect(state.url).toContain('synthetic');
  });
  it('starts a metadata-only list task and holds the busy guard until its terminal receipt', async () => {
    const { scope, state } = harness();
    await scope.run(() => scope.updateCreator('a'));
    expect(scope.subscriptionApi.refresh.mutate).toHaveBeenCalledWith({
      id: 'a',
    });
    expect(state.task).toMatchObject({ kind: 'list', state: 'queued' });
    expect(state.busy).toBe(true);
    expect(scope.subscriptionApi.downloadNotes.mutate).not.toHaveBeenCalled();
    const callbacks = watch(scope);
    callbacks.onTask({ ...terminal(), kind: 'list' });
    expect(state.busy).toBe(false);
    expect(scope.active.current).toBe(false);
  });
  it('skips paused creators, queues sequential list work and stops at a partial result', async () => {
    const { scope, state } = harness();
    await evaluate('handleRefreshAll', scope)();
    expect(scope.subscriptionApi.refresh.mutate.mock.calls).toEqual([
      [{ id: 'a' }],
    ]);
    expect(scope.queuedCreators.current).toEqual(['b']);
    watch(scope).onTask({ ...terminal('partial'), kind: 'list' });
    expect(scope.queuedCreators.current).toEqual([]);
    expect(scope.subscriptionApi.refresh.mutate).toHaveBeenCalledTimes(1);
    expect(state.task.state).toBe('partial');
  });
  it('advances a completed creator once and retains busy state for the next queued task', async () => {
    const { scope, state } = harness();
    await evaluate('handleRefreshAll', scope)();
    watch(scope).onTask({ ...terminal(), kind: 'list' });
    await Promise.resolve();
    await Promise.resolve();
    expect(scope.subscriptionApi.refresh.mutate.mock.calls).toEqual([
      [{ id: 'a' }],
      [{ id: 'b' }],
    ]);
    expect(state.busy).toBe(true);
  });
  it('retains the completed receipt when the next creator fails without replaying', async () => {
    const { scope, state } = harness();
    await evaluate('handleRefreshAll', scope)();
    scope.subscriptionApi.refresh.mutate.mockRejectedValue(
      new Error('synthetic queue failure'),
    );
    watch(scope).onTask({ ...terminal(), kind: 'list' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(scope.subscriptionApi.refresh.mutate).toHaveBeenCalledTimes(2);
    expect(state.error).toContain('未开始');
    expect(state.busy).toBe(false);
  });
  it('prevents duplicate actions and releases its guard when no task was started', async () => {
    const { scope, state } = harness();
    let finish!: () => void;
    const op = jest.fn(() => new Promise<void>((r) => (finish = r)));
    const first = scope.run(op);
    await scope.run(op);
    expect(op).toHaveBeenCalledTimes(1);
    expect(state.busy).toBe(true);
    finish();
    await first;
    expect(state.busy).toBe(false);
  });
  it('downloads selected listed image notes through the task API without creating a browser ZIP', async () => {
    const { scope, state } = harness();
    await evaluate('handleLocalSave', scope)();
    expect(scope.subscriptionApi.downloadNotes.mutate).toHaveBeenCalledWith({
      creatorId: 'a',
      noteIds: ['note-a'],
    });
    expect(scope.localApi).not.toHaveBeenCalled();
    expect(scope.exportNotes.mutateAsync).not.toHaveBeenCalled();
    expect(state.task).toMatchObject({
      kind: 'download',
      state: 'queued',
      total: 1,
    });
    expect(state.message).not.toContain('完成');
  });
  it('stops at native picker cancellation and never dispatches the download', async () => {
    const { scope, state } = harness();
    scope.saveSettings.askEveryTime = true;
    scope.localApi.mockResolvedValue({ cancelled: true });
    await evaluate('handleLocalSave', scope)();
    expect(scope.localApi.mock.calls).toEqual([['/directory', {}]]);
    expect(scope.subscriptionApi.downloadNotes.mutate).not.toHaveBeenCalled();
    expect(state.busy).toBe(false);
  });
  it('passes the native picker token for a bounded batch and does not accept a path parameter', async () => {
    const { scope } = harness();
    scope.saveSettings.askEveryTime = true;
    scope.localApi.mockResolvedValue({
      pickToken: 'native-grant',
      directory: 'synthetic-picked',
      askEveryTime: true,
    });
    await evaluate('handleLocalSave', scope)();
    expect(scope.subscriptionApi.downloadNotes.mutate).toHaveBeenCalledWith({
      creatorId: 'a',
      noteIds: ['note-a'],
      pickToken: 'native-grant',
    });
    expect(scope.setDirectory).toHaveBeenCalledWith('synthetic-picked');
  });
  it('does not retry a failed task submission or display an archive success', async () => {
    const { scope, state } = harness();
    scope.subscriptionApi.downloadNotes.mutate.mockRejectedValue(
      new Error('synthetic submit failure'),
    );
    await evaluate('handleLocalSave', scope)();
    expect(scope.subscriptionApi.downloadNotes.mutate).toHaveBeenCalledTimes(1);
    expect(state.task).toBeNull();
    expect(state.busy).toBe(false);
    expect(state.error).toContain('synthetic');
  });
  it('does not invent progress when the backend fails to return a task receipt', async () => {
    const { scope, state } = harness();
    scope.subscriptionApi.downloadNotes.mutate.mockResolvedValue({});
    await evaluate('handleLocalSave', scope)();
    expect(scope.localApi).not.toHaveBeenCalled();
    expect(scope.subscriptionApi.downloadNotes.mutate).toHaveBeenCalledTimes(1);
    expect(state.task).toBeNull();
    expect(scope.taskRunning.current).toBe(false);
    expect(state.busy).toBe(false);
  });
  it('clears remaining creator work on cancel, sends one request and retains the busy guard until confirmation', async () => {
    const { scope, state } = harness();
    await evaluate('handleRefreshAll', scope)();
    const cancel = evaluate('handleCancelTask', scope);
    await cancel();
    await cancel();
    expect(scope.queuedCreators.current).toEqual([]);
    expect(scope.subscriptionApi.cancelTask.mutate).toHaveBeenCalledTimes(1);
    expect(state.busy).toBe(true);
    watch(scope).onTask({ ...terminal('cancelled'), kind: 'list' });
    expect(state.busy).toBe(false);
  });
  it('keeps a failed cancellation unconfirmed and permits an explicit later retry', async () => {
    const { scope, state } = harness();
    scope.taskRunning.current = true;
    scope.subscriptionApi.cancelTask.mutate.mockRejectedValue(
      new Error('synthetic cancel failure'),
    );
    await evaluate('handleCancelTask', scope)();
    expect(scope.cancelPending.current).toBe(false);
    expect(state.error).toContain('取消未确认');
    expect(scope.taskRunning.current).toBe(true);
  });
  it('reports progress failure without resubmitting or unlocking an in-flight task', () => {
    const { scope, state } = harness();
    scope.taskRunning.current = true;
    scope.active.current = true;
    state.busy = true;
    watch(scope).onError(new Error('synthetic receipt loss'));
    expect(state.busy).toBe(true);
    expect(scope.subscriptionApi.downloadNotes.mutate).not.toHaveBeenCalled();
    expect(state.error).toBeTruthy();
  });
  it('polls queued/running receipts through a lost response until terminal state without resubmission', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce(terminal('queued'))
      .mockRejectedValueOnce(new Error('synthetic receipt loss'))
      .mockResolvedValueOnce(terminal());
    const onTask = jest.fn(),
      onError = jest.fn();
    await taskExports.watchSubscriptionTask({
      taskId: 'one',
      query,
      signal: new AbortController().signal,
      onTask,
      onError,
      interval: 1,
    });
    expect(query).toHaveBeenCalledTimes(3);
    expect(onTask).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
  });
  it('aborts polling on cleanup and ignores late receipts', async () => {
    const controller = new AbortController();
    let finish!: (v: unknown) => void;
    const onTask = jest.fn();
    const pending = taskExports.watchSubscriptionTask({
      taskId: 'one',
      query: () => new Promise((r) => (finish = r)),
      signal: controller.signal,
      onTask,
      onError: jest.fn(),
      interval: 1,
    });
    controller.abort();
    finish(terminal());
    await pending;
    expect(onTask).not.toHaveBeenCalled();
  });
  it.each(['completed', 'partial', 'blocked', 'cancelled', 'failed'])(
    'retains honest %s counters and releases terminal UI state',
    (state) => {
      const { scope, state: actual } = harness();
      scope.taskRunning.current = true;
      scope.active.current = true;
      const task = terminal(state);
      watch(scope).onTask(task);
      expect(actual.task).toEqual(task);
      expect(actual.message).toBe(taskExports.taskText(task));
      expect(scope.taskRunning.current).toBe(false);
    },
  );
  it('clears selection on search/creator/date changes and blocks changes during work', () => {
    const { scope, state } = harness();
    evaluate('handleSearch', scope)('search');
    expect(scope.setSearch).toHaveBeenCalledWith('search');
    expect(state.selected.size).toBe(0);
    evaluate('selectCreator', scope)('b');
    expect(state.creator).toBe('b');
    expect(state.dates).toEqual({ mode: 'range', start: '', end: '' });
    expect(scope.setMobileSidebarOpen).toHaveBeenCalledWith(false);
    scope.active.current = true;
    scope.setSearch.mockClear();
    evaluate('handleSearch', scope)('ignored');
    evaluate('selectCreator', scope)('a');
    evaluate('selectNote', scope)('ignored', true);
    expect(scope.setSearch).not.toHaveBeenCalled();
    expect(state.creator).toBe('b');
  });
  it('restricts first-release downloads to image notes while keeping existing video status/cover honest', () => {
    expect(
      taskExports
        .selectedImageNotes(
          [
            { id: 'image', kind: 'image-text' },
            { id: 'video', kind: 'video' },
          ],
          new Set(['image', 'video']),
        )
        .map((n: any) => n.id),
    ).toEqual(['image']);
    const status = evaluate('noteStatus', {});
    expect(status({ status: 'complete', kind: 'video' })).toContain('未验证');
    expect(status({ status: 'video-skipped', kind: 'video' })).toContain(
      '未归档',
    );
    expect(text).toContain('body.data.images.map');
    expect(text).not.toMatch(
      /<video\b|video\/mp4;base64|dangerouslySetInnerHTML/,
    );
  });
  it('exports only selected complete caches as ZIP and revokes its object URL', async () => {
    const { scope } = harness();
    scope.selectedNotes = [
      { id: 'complete', status: 'complete' },
      { id: 'listed', status: 'listed' },
    ];
    const link = { click: jest.fn(), remove: jest.fn() };
    scope.document = {
      createElement: jest.fn(() => link),
      body: { appendChild: jest.fn() },
    };
    scope.URL = {
      createObjectURL: jest.fn(() => 'blob:synthetic'),
      revokeObjectURL: jest.fn(),
    };
    scope.Blob = Blob;
    scope.atob = atob;
    scope.Uint8Array = Uint8Array;
    scope.exportNotes.mutateAsync.mockResolvedValue({
      base64: 'U1lOVEhFVElD',
      filename: 'synthetic.zip',
      mimeType: 'application/zip',
      notes: 1,
    });
    await evaluate('handleDownload', scope)();
    expect(scope.exportNotes.mutateAsync).toHaveBeenCalledWith({
      creatorId: 'a',
      noteIds: ['complete'],
    });
    expect(link.click).toHaveBeenCalledTimes(1);
    expect(link.remove).toHaveBeenCalled();
    expect(scope.URL.revokeObjectURL).toHaveBeenCalledWith('blob:synthetic');
  });
  it('preserves native directory selection, cancellation and preference-only updates', async () => {
    const { scope } = harness();
    scope.localApi.mockResolvedValueOnce({ cancelled: true });
    await evaluate('handleChooseDirectory', scope)();
    expect(scope.setDirectory).not.toHaveBeenCalled();
    scope.localApi.mockResolvedValueOnce({
      directory: 'chosen',
      askEveryTime: true,
    });
    await evaluate('handleChooseDirectory', scope)();
    expect(scope.setDirectory).toHaveBeenCalledWith('chosen');
    scope.localApi.mockResolvedValueOnce({
      directory: 'chosen',
      askEveryTime: false,
    });
    await evaluate('handleSaveSettings', scope)(false);
    expect(scope.localApi).toHaveBeenLastCalledWith('/settings', {
      askEveryTime: false,
    });
  });
  it('retains real navigation, groups, date filtering, cached preview and primary local-save actions', () => {
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
    for (const marker of [
      '<ManagementFolders',
      '<ArticleDateFilter',
      'dateSelectionFilter(dateSelection)',
      'trpc.xiaohongshu.body.useQuery',
      'trpc.xiaohongshu.export.useMutation',
      'compact-list',
      'mac-toolbar',
      'md:flex-row',
    ])
      expect(text).toContain(marker);
    expect(text.indexOf('onPress={handleLocalSave}')).toBeLessThan(
      text.indexOf('onPress={handleDownload}'),
    );
    expect(text).not.toMatch(/prototypes\/|toast\.success/);
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
      setSaving: jest.fn(),
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
    expect(scope.setSaving.mock.calls).toEqual([[true], [false]]);
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
    expect(feeds).toContain('moveFeeds.mutateAsync(');
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
      dragOrder: {
        current: [
          { id: 'a', order: 0, groupId: null },
          { id: 'b', order: 1, groupId: null },
        ],
      },
      dragSnapshot: {
        current: [
          { id: 'b', order: 1, groupId: null },
          { id: 'a', order: 0, groupId: null },
        ],
      },
      draggedItem: 0,
      acceptedFeedDrop: { current: true },
      setDraggedItem: jest.fn(),
      setOrderedFeeds: jest.fn(),
      setFolderBusy: jest.fn(),
      queryUtils: { feed: { list: { cancel: jest.fn() } } },
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
      { id: 'a', order: 0, expectedOrder: 0, expectedGroupId: null },
      { id: 'b', order: 1, expectedOrder: 1, expectedGroupId: null },
    ]);
  });
});
