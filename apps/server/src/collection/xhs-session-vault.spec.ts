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
    expect(await vault.status()).toEqual({ stored: false });
    await vault.store(cookies);
    const ciphertext = await fs.readFile(
      path.join(root, '.wewe-xhs-session', 'session.dpapi'),
    );
    expect(ciphertext.includes(Buffer.from(cookies.a1))).toBe(false);
    expect(ciphertext.includes(Buffer.from(cookies.web_session))).toBe(false);
    expect(await vault.load()).toEqual(cookies);
    await expect(vault.store(cookies)).rejects.toThrow(
      'XHS_VAULT_OPERATION_FAILED',
    );
    expect(await vault.load()).toEqual(cookies);
    await vault.disconnect();
    expect(await vault.status()).toEqual({ stored: false });
  }, 60000);
});
