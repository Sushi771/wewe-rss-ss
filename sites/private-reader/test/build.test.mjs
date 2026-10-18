import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildReader } from '../build.mjs';

test('single Worker ESM bundle has no test adapter or third-party runtime dependency and stays closed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-sites-build-'));
  try {
    const result = await buildReader(root);
    assert(result.bytes < 200000);
    assert(
      result.inputs.some((name) =>
        name.endsWith('scripts/sites-local-contract.mjs'),
      ),
    );
    assert(result.inputs.every((name) => !name.includes('/test/')));
    const code = await fs.readFile(result.file, 'utf8');
    assert.doesNotMatch(
      code,
      /Synthetic owner article|PRIVATE_TOKEN|syntheticLocalChannel/,
    );
    const built = await import(
      'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
    );
    const page = await built.default.fetch(
      new Request('https://reader.invalid/'),
    );
    assert.equal(page.status, 200);
    const script = await built.default.fetch(
      new Request('https://reader.invalid/reader.js'),
    );
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);
    const denied = await built.default.fetch(
      new Request('https://reader.invalid/api/subscriptions', {
        method: 'POST',
        headers: {
          origin: 'https://reader.invalid',
          'content-type': 'application/json',
          'oai-authenticated-user-id': 'owner',
        },
        body: JSON.stringify({ action: 'authors', platform: 'wechat' }),
      }),
    );
    assert.equal(denied.status, 503);
    assert.equal((await denied.json()).code, 'IDENTITY_UNCONFIGURED');
    assert.deepEqual(await fs.readdir(root), ['server']);
  } finally {
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert(path.basename(root).startsWith('wewe-sites-build-'));
    await fs.rm(root, { recursive: true, force: true });
  }
});
