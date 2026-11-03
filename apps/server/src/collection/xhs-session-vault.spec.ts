import childProcess = require('node:child_process');
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkedXhsCookies,
  XhsDpapiSessionVault,
  callWindowsDpapi,
} from './xhs-session-vault';

const cookies = {
  a1: 'synthetic-a1-never-real',
  web_session: 'synthetic-session-never-real',
};
describe('explicit CurrentUser DPAPI envelope (synthetic only)', () => {
  it('validates a minimal cookie set without accepting injected headers or logging values', () => {
    expect(checkedXhsCookies(cookies)).toEqual(cookies);
    for (const value of [
      { ...cookies, Authorization: 'synthetic' },
      { ...cookies, a1: 'bad; value' },
      { ...cookies, web_session: 'bad\nvalue' },
      {},
    ])
      expect(() => checkedXhsCookies(value)).toThrow(
        'XHS_SESSION_INPUT_INVALID',
      );
  });
  it('does not touch storage during construction and uses only a fixed child path', async () => {
    const root = path.join(tmpdir(), 'synthetic-vault-root'),
      call = jest.fn(
        async (action: string, _file: string, _cookies?: unknown) =>
          action === 'status'
            ? { stored: false }
            : action === 'load'
              ? { ...cookies }
              : {},
      );
    const vault = new XhsDpapiSessionVault(root, call);
    expect(call).not.toHaveBeenCalled();
    expect(await vault.status()).toEqual({ stored: false });
    expect(call.mock.calls[0][1]).toBe(
      path.join(root, '.wewe-xhs-session', 'session.dpapi'),
    );
    await vault.store(cookies);
    expect(await vault.load()).toEqual(cookies);
    await vault.disconnect();
    expect(call).toHaveBeenCalledTimes(4);
    expect(() => new XhsDpapiSessionVault('relative')).toThrow(
      'XHS_VAULT_DIRECTORY_INVALID',
    );
  });
  it('round trips only a newly created synthetic encrypted record under the current Windows account', async () => {
    if (process.platform !== 'win32') {
      await expect(callWindowsDpapi('status', 'synthetic')).rejects.toThrow(
        'XHS_VAULT_WINDOWS_REQUIRED',
      );
      return;
    }
    const root = await fs.mkdtemp(
      path.join(tmpdir(), 'wewe-xhs-dpapi-synthetic-'),
    );
    const vault = new XhsDpapiSessionVault(root);
    const stage = async <T>(name: string, run: () => Promise<T>) => {
      console.info('XHS_SYNTHETIC_DPAPI_STAGE_' + name);
      return run();
    };
    expect(await stage('INITIAL_STATUS', () => vault.status())).toEqual({
      stored: false,
    });
    await stage('STORE', () => vault.store(cookies));
    console.info('XHS_SYNTHETIC_DPAPI_STAGE_READ_CIPHERTEXT');
    const ciphertext = await fs.readFile(
      path.join(root, '.wewe-xhs-session', 'session.dpapi'),
    );
    expect(ciphertext.includes(Buffer.from(cookies.a1))).toBe(false);
    expect(ciphertext.includes(Buffer.from(cookies.web_session))).toBe(false);
    expect(await stage('LOAD_INITIAL', () => vault.load())).toEqual(cookies);
    await expect(
      stage('DUPLICATE_STORE', () => vault.store(cookies)),
    ).rejects.toThrow('XHS_VAULT_OPERATION_FAILED');
    expect(await stage('LOAD_AFTER_DUPLICATE', () => vault.load())).toEqual(
      cookies,
    );
    await stage('DISCONNECT', () => vault.disconnect());
    expect(await stage('FINAL_STATUS', () => vault.status())).toEqual({
      stored: false,
    });
  }, 60000);
});

describe('DPAPI child deadline (synthetic process only)', () => {
  it('kills at the original deadline, reports timeout, never retries and clears buffers', async () => {
    if (process.platform !== 'win32') return;
    jest.useFakeTimers();
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    let input: Buffer | undefined;
    child.stdin.end = jest.fn((bytes: Buffer) => {
      input = bytes;
    });
    child.kill = jest.fn(() => true);
    const spawn = jest.spyOn(childProcess, 'spawn').mockReturnValue(child);
    const output = Buffer.from('synthetic-output-never-real');
    try {
      const pending = callWindowsDpapi(
        'store',
        path.join(
          tmpdir(),
          'synthetic-deadline',
          '.wewe-xhs-session',
          'session.dpapi',
        ),
        cookies,
      );
      const rejected = expect(pending).rejects.toThrow(
        'XHS_VAULT_OPERATION_FAILED_TIMEOUT',
      );
      child.stdout.emit('data', output);
      jest.advanceTimersByTime(14999);
      expect(child.kill).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      const lateDiagnostic = Buffer.from(
        'XHS_VAULT_OPERATION_FAILED_LINE_1_Error',
      );
      child.stderr.emit('data', lateDiagnostic);
      child.emit('close', null);
      await rejected;
      expect(lateDiagnostic.every((byte) => byte === 0)).toBe(true);
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(input).toBeDefined();
      expect(input!.every((byte) => byte === 0)).toBe(true);
      expect(output.every((byte) => byte === 0)).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
      expect(spawn.mock.calls[0][1]).not.toContain(cookies.a1);
      expect(spawn.mock.calls[0][1]).not.toContain(cookies.web_session);
    } finally {
      spawn.mockRestore();
      jest.useRealTimers();
    }
  });
});
