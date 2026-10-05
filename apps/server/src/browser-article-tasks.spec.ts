import { BrowserArticleTasks } from './browser-article-tasks';
import { BrowserTaskBroker } from './browser-task';
import {
  browserArticleTaskStatus,
  mergeBrowserArticleTaskStatus,
} from '../../../packages/shared/src/browser-article-task';
import {
  binding,
  config,
  observation,
  short,
} from '../test/browser-task-fixture';

describe('application article handoff lifecycle, no network or persistent data', () => {
  let broker: BrowserTaskBroker;
  let tasks: BrowserArticleTasks;
  const owner = 'synthetic-application-session';
  const ready = async () => {
    const task = tasks.issue(short, owner);
    const claim = broker.claim(task.taskId, binding);
    broker.complete(task.taskId, claim.nonce, binding, observation());
    await Promise.resolve();
    return task;
  };
  beforeEach(() => {
    broker = new BrowserTaskBroker(config);
    tasks = new BrowserArticleTasks(broker);
  });
  afterEach(() => {
    tasks.close();
    broker.close();
    jest.useRealTimers();
  });
  it('default remains disabled and refresh is never inferred from a single article', () => {
    const disabled = new BrowserArticleTasks(new BrowserTaskBroker());
    expect(disabled.capability()).toEqual({
      available: false,
      code: 'BROWSER_TASK_DISABLED',
      refreshAvailable: false,
      refreshCode: 'DIRECTORY_ROUTE_UNVERIFIED',
    });
    expect(() => disabled.issue(short, owner)).toThrow('BROWSER_TASK_DISABLED');
    expect(tasks.capability()).toEqual({
      available: true,
      refreshAvailable: false,
      refreshCode: 'DIRECTORY_ROUTE_UNVERIFIED',
    });
  });
  it('status is scoped to the issuing application session and exposes no Provider or transport secrets', async () => {
    const task = tasks.issue(short, owner);
    expect(() => tasks.status(task.taskId, 'other-session')).toThrow(
      'TASK_GONE',
    );
    expect(() => tasks.cancel(task.taskId, 'other-session')).toThrow(
      'TASK_GONE',
    );
    const claim = broker.claim(task.taskId, binding);
    expect(tasks.status(task.taskId, owner).state).toBe('claimed');
    broker.complete(task.taskId, claim.nonce, binding, observation());
    await Promise.resolve();
    const status = tasks.status(task.taskId, owner);
    expect(browserArticleTaskStatus(status)).toEqual(status);
    expect(Object.keys(status).sort()).toEqual([
      'expiresAt',
      'state',
      'taskId',
    ]);
    expect(JSON.stringify(status)).not.toContain(claim.nonce);
    expect(status.state).toBe('ready');
  });
  it('cancellation wins before claimed completion, revokes nonce and drops a ready body', async () => {
    const pending = tasks.issue(short, owner);
    const claim = broker.claim(pending.taskId, binding);
    expect(tasks.cancel(pending.taskId, owner).state).toBe('cancelled');
    expect(() =>
      broker.complete(pending.taskId, claim.nonce, binding, observation()),
    ).toThrow('TASK_GONE');
    const task = await ready();
    tasks.cancel(task.taskId, owner);
    expect(() => tasks.beginSave(task.taskId, owner)).toThrow('TASK_NOT_READY');
    expect(tasks.status(task.taskId, owner).state).toBe('cancelled');
  });
  it('expiry distinguishes timeout from user cancellation even after successful receipt', async () => {
    jest.useFakeTimers();
    const pending = tasks.issue(short, owner);
    const task = await ready();
    jest.advanceTimersByTime(300001);
    await Promise.resolve();
    for (const id of [pending.taskId, task.taskId])
      expect(tasks.status(id, owner)).toMatchObject({
        state: 'expired',
        code: 'TASK_EXPIRED',
      });
    expect(() => tasks.beginSave(task.taskId, owner)).toThrow('TASK_NOT_READY');
  });
  it('save reservation is exclusive; failures can retry locally within TTL and successes cannot replay', async () => {
    const task = await ready();
    expect(tasks.beginSave(task.taskId, owner).url).toBe(short);
    expect(() => tasks.beginSave(task.taskId, owner)).toThrow('TASK_NOT_READY');
    expect(() => tasks.cancel(task.taskId, owner)).toThrow('TASK_SAVING');
    tasks.saveFailed(task.taskId, owner);
    expect(tasks.status(task.taskId, owner)).toMatchObject({
      state: 'ready',
      code: 'SAVE_RETRY_REQUIRED',
    });
    tasks.beginSave(task.taskId, owner);
    tasks.saved(task.taskId, owner);
    expect(tasks.status(task.taskId, owner)).toMatchObject({ state: 'saved' });
    expect(tasks.status(task.taskId, owner).code).toBeUndefined();
    expect(() => tasks.beginSave(task.taskId, owner)).toThrow('TASK_NOT_READY');
  });
  it('an atomic save may finish beyond capture TTL; failed saves cannot retain stale content', async () => {
    jest.useFakeTimers();
    const success = await ready(),
      failure = await ready();
    tasks.beginSave(success.taskId, owner);
    tasks.beginSave(failure.taskId, owner);
    jest.advanceTimersByTime(300001);
    tasks.saved(success.taskId, owner);
    tasks.saveFailed(failure.taskId, owner);
    expect(tasks.status(success.taskId, owner).state).toBe('saved');
    expect(tasks.status(failure.taskId, owner).state).toBe('expired');
  });
  it('consumed invalid observations fail without publishing or replay, and a new explicit task can proceed', async () => {
    const task = tasks.issue(short, owner),
      claim = broker.claim(task.taskId, binding);
    const bad = observation();
    bad.images = [];
    expect(() =>
      broker.complete(task.taskId, claim.nonce, binding, bad),
    ).toThrow();
    await Promise.resolve();
    expect(tasks.status(task.taskId, owner)).toMatchObject({
      state: 'failed',
      code: 'OBSERVATION_REJECTED',
    });
    expect((await ready()).taskId).not.toBe(task.taskId);
  });
  it('ready bodies share the four-task memory bound; terminal metadata is bounded and pruned', async () => {
    jest.useFakeTimers();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await ready()).taskId);
    expect(() => tasks.issue(short, owner)).toThrow('TASK_CAPACITY');
    ids.forEach((id) => tasks.cancel(id, owner));
    for (let i = 4; i < 32; i++) {
      const t = tasks.issue(short, owner);
      tasks.cancel(t.taskId, owner);
    }
    expect(() => tasks.issue(short, owner)).toThrow('TASK_CAPACITY');
    jest.advanceTimersByTime(360001);
    expect(tasks.issue(short, owner).state).toBe('waiting');
  });
  it('client status schema refuses raw content, secrets, invalid identity or arbitrary failure text', () => {
    const task = tasks.issue(short, owner);
    for (const value of [
      { ...task, html: 'body' },
      { ...task, nonce: 'secret' },
      { ...task, state: 'available' },
      { ...task, taskId: 'bad' },
      { ...task, expiresAt: 'bad' },
      { ...task, code: 'raw-cookie' },
    ])
      expect(browserArticleTaskStatus(value)).toBeNull();
  });
  it('a late client poll cannot revive completed capture or replace a newer task', () => {
    const next = tasks.issue(short, owner);
    for (const state of [
      'saved',
      'cancelled',
      'expired',
      'failed',
      'ready',
      'saving',
    ] as const) {
      const current = { ...next, state };
      expect(mergeBrowserArticleTaskStatus(current, next)).toBe(current);
    }
    const newer = tasks.issue(short, owner);
    expect(mergeBrowserArticleTaskStatus(newer, next)).toBe(newer);
    expect(mergeBrowserArticleTaskStatus(null, next)).toBeNull();
    expect(
      mergeBrowserArticleTaskStatus(
        { ...next, state: 'waiting' },
        { ...next, state: 'claimed' },
      )?.state,
    ).toBe('claimed');
  });
});
