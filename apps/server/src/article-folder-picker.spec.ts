import * as cp from 'node:child_process';
jest.mock('node:child_process', () => ({
  ...jest.requireActual('node:child_process'),
  execFile: jest.fn(),
}));
import { EventEmitter } from 'node:events';
import { pickArticleDirectory } from './article-folder-picker';
import { ArticleDownloadController } from './article-download.controller';
import { ConfigService } from '@nestjs/config';

describe('shared native directory picker lifecycle without opening a window', () => {
  let hostPlatform: PropertyDescriptor;
  let callback: any;
  let script: string;
  let launchOptions: any;
  let kill: jest.Mock;
  beforeEach(() => {
    hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    // All native process/window APIs below are mocked. Run the Windows protocol
    // on every CI host while separately asserting the non-Windows refusal.
    Object.defineProperty(process, 'platform', {
      ...hostPlatform,
      value: 'win32',
    });
    kill = jest.fn();
    jest
      .mocked(cp.execFile)
      .mockReset()
      .mockImplementation(((file: any, args: any, options: any, done: any) => {
        script = Buffer.from(args[args.length - 1], 'base64').toString(
          'utf16le',
        );
        launchOptions = options;
        callback = done;
        return { kill } as any;
      }) as any);
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', hostPlatform);
    jest.restoreAllMocks();
  });
  it('refuses non-Windows hosts before launching any native child', async () => {
    Object.defineProperty(process, 'platform', {
      ...hostPlatform,
      value: 'linux',
    });
    await expect(pickArticleDirectory('C:\\synthetic')).rejects.toMatchObject({
      status: 409,
    });
    expect(cp.execFile).not.toHaveBeenCalled();
  });
  it('keeps the one-argument WeChat API and disposes a topmost owner around the owned dialog', async () => {
    const pending = pickArticleDirectory('C:\\synthetic');
    expect(script).toContain('$owner.TopMost = $true');
    expect(script).toContain('$dialog.ShowDialog($owner)');
    expect(script).toContain('finally { $owner.Dispose() }');
    expect(script).toContain(
      Buffer.from('选择公众号文章保存文件夹').toString('base64'),
    );
    expect(launchOptions).toMatchObject({ windowsHide: true, timeout: 300000 });
    callback(null, Buffer.from('C:\\selected').toString('base64'));
    await expect(pending).resolves.toBe('C:\\selected');
  });
  it('uses an explicit XHS title and treats native Cancel as no selection', async () => {
    const pending = pickArticleDirectory('C:\\synthetic', {
      platform: 'xiaohongshu',
    });
    expect(script).toContain(
      Buffer.from('选择小红书内容保存文件夹').toString('base64'),
    );
    callback(null, '');
    await expect(pending).resolves.toBeNull();
  });
  it('rejects timeout/malformed replies without granting a directory', async () => {
    const first = pickArticleDirectory('C:\\synthetic');
    const rejected = expect(first).rejects.toMatchObject({
      diagnostic: { code: 'DIRECTORY_PICKER_FAILED' },
    });
    callback(Object.assign(Error('timeout'), { killed: true }), '');
    await rejected;
    const second = pickArticleDirectory('C:\\synthetic');
    const invalid = expect(second).rejects.toThrow();
    callback(null, 'not-base64!');
    await invalid;
  });
  it('does not launch after cancellation and waits for termination callback on disconnect', async () => {
    const before = new AbortController();
    before.abort();
    await expect(
      pickArticleDirectory('C:\\synthetic', { signal: before.signal }),
    ).rejects.toThrow();
    expect(cp.execFile).not.toHaveBeenCalled();
    const active = new AbortController();
    let settled = false;
    const pending = pickArticleDirectory('C:\\synthetic', {
      signal: active.signal,
    });
    const rejected = expect(pending).rejects.toMatchObject({
      diagnostic: { code: 'DIRECTORY_PICKER_CANCELLED' },
    });
    pending
      .finally(() => {
        settled = true;
      })
      .catch(() => {});
    active.abort();
    expect(kill).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(settled).toBe(false);
    callback(Error('terminated'), '');
    await rejected;
  });
  it('releases the controller lock after disconnect and creates no token/settings receipt', async () => {
    const controller = new ArticleDownloadController(new ConfigService());
    const internal = controller as any;
    jest.spyOn(internal, 'authorized').mockReturnValue(true);
    const remember = jest.fn();
    jest
      .spyOn(internal, 'localStore')
      .mockReturnValue({
        read: async () => ({ directory: 'C:\\synthetic', askEveryTime: true }),
        rememberPickedDirectory: remember,
      });
    const req: any = Object.assign(new EventEmitter(), {
      query: { target: 'xiaohongshu' },
      aborted: false,
    });
    const res: any = Object.assign(new EventEmitter(), {
      writableEnded: false,
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    });
    const pending = controller.selectDirectory(req, res);
    await new Promise(setImmediate);
    req.emit('aborted');
    expect(kill).toHaveBeenCalledTimes(1);
    expect(internal.pickerRunning).toBe(true);
    callback(Error('terminated'), '');
    await pending;
    expect(internal.pickerRunning).toBe(false);
    expect(internal.xhsPickerGrant).toBeUndefined();
    expect(remember).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(req.listenerCount('aborted')).toBe(0);
    expect(res.listenerCount('close')).toBe(0);
  });

  it.each(['false', 'throw'])(
    'AUDIT: failed kill %s retains pending state until callback',
    async (mode) => {
      const a = new AbortController();
      let settled = false;
      kill.mockImplementation(() => {
        if (mode === 'throw') throw Error('synthetic kill failure');
        return false;
      });
      const pending = pickArticleDirectory('C:\\synthetic', {
        signal: a.signal,
      });
      pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const rejected = expect(pending).rejects.toMatchObject({
        diagnostic: { code: 'DIRECTORY_PICKER_CANCELLED' },
      });
      a.abort();
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(kill).toHaveBeenCalledTimes(1);
      callback(
        Error('bounded timeout'),
        Buffer.from('C:\\selected').toString('base64'),
      );
      await rejected;
    },
  );
  it('AUDIT: aborting one picker never kills another child or changes its result', async () => {
    const records: any[] = [];
    jest.mocked(cp.execFile).mockImplementation(((
      f: any,
      a: any,
      o: any,
      cb: any,
    ) => {
      const record = { cb, kill: jest.fn() };
      records.push(record);
      return { kill: record.kill };
    }) as any);
    const a = new AbortController(),
      b = new AbortController();
    const first = pickArticleDirectory('C:\\one', { signal: a.signal });
    const rejected = expect(first).rejects.toThrow();
    const second = pickArticleDirectory('C:\\two', { signal: b.signal });
    a.abort();
    expect(records[0].kill).toHaveBeenCalledTimes(1);
    expect(records[1].kill).not.toHaveBeenCalled();
    records[0].cb(Error('terminated'), '');
    await rejected;
    records[1].cb(null, Buffer.from('C:\\two').toString('base64'));
    await expect(second).resolves.toBe('C:\\two');
    b.abort();
    expect(records[1].kill).not.toHaveBeenCalled();
  });
  function auditController() {
    const c = new ArticleDownloadController(new ConfigService()),
      internal = c as any;
    jest.spyOn(internal, 'authorized').mockReturnValue(true);
    const remember = jest.fn(async () => ({
      directory: 'C:\\selected',
      askEveryTime: true,
    }));
    jest.spyOn(internal, 'localStore').mockReturnValue({
      read: async () => ({ directory: 'C:\\synthetic', askEveryTime: true }),
      rememberPickedDirectory: remember,
    });
    const req: any = Object.assign(new EventEmitter(), {
      query: { target: 'xiaohongshu' },
      aborted: false,
    });
    const res: any = Object.assign(new EventEmitter(), {
      writableEnded: false,
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    });
    return { c, internal, remember, req, res };
  }
  it('AUDIT: concurrent selector is rejected and cancel clears only the selected platform grant', async () => {
    const h = auditController();
    h.internal.pickerGrant = 'wechat';
    h.internal.xhsPickerGrant = 'old-xhs';
    const first = h.c.selectDirectory(h.req, h.res);
    await new Promise(setImmediate);
    expect(h.internal.xhsPickerGrant).toBeUndefined();
    expect(h.internal.pickerGrant).toBe('wechat');
    await h.c.selectDirectory(h.req, h.res);
    expect(h.res.status).toHaveBeenLastCalledWith(409);
    expect(cp.execFile).toHaveBeenCalledTimes(1);
    callback(null, '');
    await first;
    expect(h.remember).not.toHaveBeenCalled();
    expect(h.res.json).toHaveBeenLastCalledWith({ cancelled: true });
    expect(h.internal.pickerRunning).toBe(false);
  });
  it('AUDIT: unfinished response close suppresses a late successful selection and releases listeners', async () => {
    const h = auditController();
    const pending = h.c.selectDirectory(h.req, h.res);
    await new Promise(setImmediate);
    h.res.emit('close');
    expect(kill).toHaveBeenCalledTimes(1);
    expect(h.internal.pickerRunning).toBe(true);
    callback(null, Buffer.from('C:\\selected').toString('base64'));
    await pending;
    expect(h.remember).not.toHaveBeenCalled();
    expect(h.internal.xhsPickerGrant).toBeUndefined();
    expect(h.res.json).not.toHaveBeenCalled();
    expect(h.req.listenerCount('aborted')).toBe(0);
    expect(h.res.listenerCount('close')).toBe(0);
  });
  it('AUDIT: disconnect during persistence never grants and retains lock until persistence completes', async () => {
    const h = auditController();
    let release: any;
    h.remember.mockImplementation(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    const pending = h.c.selectDirectory(h.req, h.res);
    await new Promise(setImmediate);
    callback(null, Buffer.from('C:\\selected').toString('base64'));
    await new Promise(setImmediate);
    h.res.emit('close');
    expect(kill).not.toHaveBeenCalled();
    expect(h.internal.pickerRunning).toBe(true);
    release({ directory: 'C:\\selected', askEveryTime: true });
    await pending;
    expect(h.internal.xhsPickerGrant).toBeUndefined();
    expect(h.res.json).not.toHaveBeenCalled();
    expect(h.internal.pickerRunning).toBe(false);
  });
  it('AUDIT: synchronous spawn error unlocks controller and removes listeners without a grant', async () => {
    jest.mocked(cp.execFile).mockImplementation((() => {
      throw Error('synthetic spawn failure');
    }) as any);
    const h = auditController();
    await h.c.selectDirectory(h.req, h.res);
    expect(h.internal.pickerRunning).toBe(false);
    expect(h.internal.xhsPickerGrant).toBeUndefined();
    expect(h.remember).not.toHaveBeenCalled();
    expect(h.req.listenerCount('aborted')).toBe(0);
    expect(h.res.listenerCount('close')).toBe(0);
  });
  it('AUDIT: an already destroyed unfinished response cannot open a picker or receive a grant', async () => {
    const h = auditController();
    h.res.destroyed = true;
    const pending = h.c.selectDirectory(h.req, h.res);
    await new Promise(setImmediate);
    const launched = jest.mocked(cp.execFile).mock.calls.length;
    if (launched)
      callback(null, Buffer.from('C:\\selected').toString('base64'));
    await pending;
    expect(launched).toBe(0);
    expect(h.remember).not.toHaveBeenCalled();
    expect(h.internal.xhsPickerGrant).toBeUndefined();
    expect(h.internal.pickerRunning).toBe(false);
  });
  it('AUDIT: early execFile error callback cannot release a still live child lock', async () => {
    const child: any = Object.assign(new EventEmitter(), {
      pid: 12345,
      exitCode: null,
      signalCode: null,
      kill: jest.fn(),
    });
    let done: any;
    jest.mocked(cp.execFile).mockImplementation(((
      f: any,
      a: any,
      o: any,
      cb: any,
    ) => {
      done = cb;
      return child;
    }) as any);
    child.kill.mockImplementation(() => {
      done(Object.assign(Error('kill denied'), { code: 'EPERM' }), '');
      return false;
    });
    const h = auditController();
    const pending = h.c.selectDirectory(h.req, h.res);
    await new Promise(setImmediate);
    h.req.emit('aborted');
    await new Promise(setImmediate);
    const held = h.internal.pickerRunning;
    child.emit('close', 1, null);
    await pending;
    expect(held).toBe(true);
    expect(h.internal.pickerRunning).toBe(false);
    expect(h.internal.xhsPickerGrant).toBeUndefined();
    expect(h.remember).not.toHaveBeenCalled();
  });
});
