import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { XhsDpapiSessionVault } from './xhs-session-vault';

const synthetic = {
  a1: 'synthetic-only-a1',
  web_session: 'synthetic-only-session',
};
describe('explicit restore policy and atomic update (synthetic only)', () => {
  it('returns only validated booleans and never loads secrets while reading policy', async () => {
    const call = jest.fn(async () => ({
      autoRestore: false,
      needsReconnect: true,
      extra: 'not-returned',
    }));
    const vault = new XhsDpapiSessionVault(tmpdir(), call);
    expect(await vault.policy()).toEqual({
      autoRestore: false,
      needsReconnect: true,
    });
    expect(call).toHaveBeenCalledWith('policy', expect.any(String));
    call.mockResolvedValueOnce({
      autoRestore: 'true',
      needsReconnect: false,
    } as any);
    await expect(vault.policy()).rejects.toThrow('XHS_VAULT_OPERATION_FAILED');
  });
  it('uses explicit replacement, clears its private copy on failure and passes only boolean opt-in', async () => {
    let passed: any;
    const call = jest.fn(
      async (
        action: string,
        _file: string,
        cookies?: unknown,
        _restore?: boolean,
      ) => {
        if (action === 'replace') {
          passed = cookies;
          throw Error('synthetic failure');
        }
        return {};
      },
    );
    const vault = new XhsDpapiSessionVault(tmpdir(), call);
    await expect(vault.replace(synthetic)).rejects.toThrow('synthetic failure');
    expect(passed).toEqual({ a1: '', web_session: '' });
    expect(synthetic.a1).toBe('synthetic-only-a1');
    await vault.configureRestore(true);
    expect(call).toHaveBeenLastCalledWith(
      'configureRestore',
      expect.any(String),
      undefined,
      true,
    );
    await expect(vault.configureRestore('true' as any)).rejects.toThrow(
      'XHS_VAULT_INPUT_INVALID',
    );
    await vault.markExpired();
    expect(call).toHaveBeenLastCalledWith('markExpired', expect.any(String));
  });
  it('keeps legacy records opted out, updates ciphertext atomically, preserves opt-in and revokes on disconnect', async () => {
    if (process.platform !== 'win32') return;
    const root = await fs.mkdtemp(
      path.join(tmpdir(), 'wewe-xhs-policy-synthetic-'),
    );
    const vault = new XhsDpapiSessionVault(root);
    expect(await vault.policy()).toEqual({
      autoRestore: false,
      needsReconnect: false,
    });
    await vault.markExpired();
    await expect(
      fs.stat(path.join(root, '.wewe-xhs-session', 'restore-policy.json')),
    ).rejects.toThrow();
    await vault.store(synthetic);
    expect(await vault.policy()).toEqual({
      autoRestore: false,
      needsReconnect: false,
    });
    const ciphertextPath = path.join(
      root,
      '.wewe-xhs-session',
      'session.dpapi',
    );
    const original = await fs.readFile(ciphertextPath);
    await expect(vault.store(synthetic)).rejects.toThrow(
      'XHS_VAULT_OPERATION_FAILED',
    );
    expect(await fs.readFile(ciphertextPath)).toEqual(original);
    await vault.configureRestore(true);
    await vault.markExpired();
    expect(await vault.policy()).toEqual({
      autoRestore: true,
      needsReconnect: true,
    });
    await vault.configureRestore(true);
    expect(await vault.policy()).toEqual({
      autoRestore: true,
      needsReconnect: true,
    });
    const next = {
      a1: 'synthetic-next-a1',
      web_session: 'synthetic-next-session',
    };
    await vault.replace(next);
    expect(await vault.load()).toEqual(next);
    expect(await vault.policy()).toEqual({
      autoRestore: true,
      needsReconnect: false,
    });
    expect(
      (await fs.readFile(ciphertextPath)).includes(
        Buffer.from(next.web_session),
      ),
    ).toBe(false);
    expect(
      (await fs.readdir(path.dirname(ciphertextPath))).filter((name) =>
        name.endsWith('.tmp'),
      ),
    ).toEqual([]);
    await vault.disconnect();
    expect(await vault.status()).toEqual({ stored: false });
    expect(await vault.policy()).toEqual({
      autoRestore: false,
      needsReconnect: false,
    });
  }, 90000);
});
