const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const pin = '9bdd1b22027c422761ba7a5aa9925855e0a3c8b88b08be43f5d88b40d889822e';
const migration =
  'server/prisma/migrations/20261106010000_xhs_unbound_round/migration.sql';
const digest =
  '05263fa79ce07a05f11dd243cd6c39d9158913127e8e229f4ed8cbc858e0d703';
function roles() {
  const files = {
    'runtime/node.exe': 'a'.repeat(64),
    'server/prisma/schema.prisma': 'b'.repeat(64),
  };
  for (let i = 0; i < 33; i++)
    files[
      `server/prisma/migrations/history${String(i).padStart(2, '0')}/migration.sql`
    ] = 'c'.repeat(64);
  const old = {
    format: 1,
    id: 'old',
    schemaCompatibility: 'current',
    sourceCommit: 'd'.repeat(40),
    sourceHash: 'e'.repeat(64),
    desktopHelperIncluded: false,
    files,
    prisma: {
      clientVersion: '5.22.0',
      cliVersion: '5.22.0',
      engineSha256: 'f'.repeat(64),
      engineCommit: 'a'.repeat(40),
    },
  };
  const next = structuredClone(old);
  next.id = 'candidate';
  next.files[migration] = digest;
  return {
    current: { manifest: old, manifestSha256: pin },
    rollback: { manifest: old, manifestSha256: pin },
    candidate: { manifest: next, manifestSha256: 'b'.repeat(64) },
  };
}
for (const name of [
  './switch-contract.cjs',
  './updater/install-binding/role-aware/switch-contract.cjs',
]) {
  const contract = require(name);
  test(name + ' permits only the exact additive unbound transition', () => {
    assert.doesNotThrow(() => contract.validateRoles(roles()));
    for (const mutate of [
      (r) => {
        r.current.manifestSha256 = '1'.repeat(64);
        r.rollback.manifestSha256 = '1'.repeat(64);
      },
      (r) => {
        r.candidate.manifest.files[migration] = '2'.repeat(64);
      },
      (r) => {
        r.candidate.manifest.files[
          'server/prisma/migrations/unreviewed/migration.sql'
        ] = '3'.repeat(64);
      },
      (r) => {
        r.candidate.manifest.files['server/prisma/schema.prisma'] = '4'.repeat(
          64,
        );
      },
      (r) => {
        r.candidate.manifest.files[
          'server/prisma/migrations/history00/migration.sql'
        ] = '5'.repeat(64);
      },
      (r) => {
        r.candidate.manifest.prisma.engineCommit = '6'.repeat(40);
      },
    ]) {
      const r = roles();
      mutate(r);
      assert.throws(() => contract.validateRoles(r));
    }
  });
}
test('allowlisted migration hash matches the actual additive SQL bytes', () => {
  const file = path.resolve(
    __dirname,
    '../../apps',
    migration.replace('server/prisma', 'server/prisma'),
  );
  const bytes = Buffer.from(
    fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'),
  );
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), digest);
});
