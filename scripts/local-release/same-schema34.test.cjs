'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  crypto = require('node:crypto'),
  { DatabaseSync } = require('node:sqlite');
const currentFolder = process.env.WEWE_SCHEMA34_PATCH_CURRENT;
const pin = process.env.WEWE_SCHEMA34_PATCH_MANIFEST || '0dba566d9be5b7765d648a16aea69acf5efd18c7fb4b389bd87d24fd8d0b229d';
const sha = (f) =>
  crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
test(
  'exact deployed schema34 allows unchanged application patch and rejects migration, engine and rollback drift',
  { skip: !currentFolder },
  (t) => {
    assert.equal(sha(path.join(currentFolder, 'release.json')), pin);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'same-schema34-')),
      folder = path.join(root, 'candidate');
    fs.mkdirSync(folder);
    t.after(() => {
      assert(
        path.resolve(root).startsWith(path.join(os.tmpdir(), 'same-schema34-')),
      );
      fs.rmSync(root, { recursive: true, force: true });
    });
    fs.cpSync(
      path.join(currentFolder, 'server/prisma'),
      path.join(folder, 'server/prisma'),
      { recursive: true },
    );
    const current = JSON.parse(
        fs.readFileSync(path.join(currentFolder, 'release.json')),
      ),
      m = structuredClone(current);
    m.id = 'synthetic-same-schema34';
    const names = [
      'switch-contract.cjs',
      'switch-prewrite.cjs',
      'lib.cjs',
      'task-document-preflight.cjs',
      'switch-schema-contract.json',
    ];
    for (const relative of ['', 'updater/install-binding/role-aware'])
      for (const n of names) {
        const to = path.join(folder, relative, n);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.writeFileSync(
          to,
          fs
            .readFileSync(path.join(__dirname, relative, n), 'utf8')
            .replace(/\r\n/g, '\n'),
        );
        m.files[(relative ? relative + '/' : '') + n] = sha(to);
      }
    m.migrationContract = require('./switch-contract.cjs').migrationContract(m);
    m.prewriteSchemaContract = {
      format: 1,
      file: 'switch-schema-contract.json',
      sha256: sha(path.join(folder, 'switch-schema-contract.json')),
      gateSha256: sha(path.join(folder, 'switch-prewrite.cjs')),
    };
    fs.writeFileSync(path.join(folder, 'release.json'), JSON.stringify(m));
    const roles = {
      current: {
        folder: currentFolder,
        manifest: current,
        manifestSha256: pin,
      },
      rollback: {
        folder: currentFolder,
        manifest: current,
        manifestSha256: pin,
      },
      candidate: {
        folder,
        manifest: m,
        manifestSha256: sha(path.join(folder, 'release.json')),
      },
    };
    const catalog = JSON.parse(
      fs.readFileSync(path.join(folder, 'switch-schema-contract.json')),
    ).profiles.canonical34;
    const file = path.join(root, 'fixture.db'),
      db = new DatabaseSync(file);
    db.exec(
      catalog.objects.find(
        (x) => x.name === '_prisma_migrations' && x.type === 'table',
      ).sql,
    );
    for (const migration of catalog.migrations) {
      db.exec(
        fs.readFileSync(
          path.join(
            folder,
            'server/prisma/migrations',
            migration.name,
            'migration.sql',
          ),
          'utf8',
        ),
      );
      db.prepare(
        'INSERT INTO _prisma_migrations(id,checksum,finished_at,migration_name,started_at,applied_steps_count) VALUES(?,?,?,?,?,1)',
      ).run(
        crypto.randomUUID(),
        migration.receiptSha256,
        '2026-11-01T00:00:00Z',
        migration.name,
        '2026-11-01T00:00:00Z',
      );
    }
    db.close();
    for (const relative of ['', 'updater/install-binding/role-aware']) {
      const gate = require(path.join(folder, relative, 'switch-prewrite.cjs')),
        contract = require(path.join(folder, relative, 'switch-contract.cjs')),
        request = { database: file, roles, operationId: crypto.randomUUID() };
      const before = gate.inspectSwitchDatabase({
          ...request,
          stage: 'before-migration',
        }),
        after = gate.inspectSwitchDatabase({
          ...request,
          stage: 'after-migration',
        });
      assert.equal(before.profile, 'canonical34');
      assert.equal(after.profile, 'canonical34');
      assert.equal(gate.assertSwitchTransition(before, after), true);
      const badEngine = structuredClone(roles);
      badEngine.candidate.manifest.prisma.engineCommit = 'a'.repeat(40);
      assert.throws(() => contract.validateRoles(badEngine));
      const badRollback = structuredClone(roles);
      badRollback.rollback.manifestSha256 = 'a'.repeat(64);
      assert.throws(() =>
        gate.inspectSwitchDatabase({
          ...request,
          roles: badRollback,
          stage: 'before-migration',
        }),
      );
      const badMigration = structuredClone(roles);
      badMigration.candidate.manifest.files[
        'server/prisma/migrations/20261106010000_xhs_unbound_round/migration.sql'
      ] = 'a'.repeat(64);
      assert.throws(() => contract.validateRoles(badMigration));
    }
    const d = new DatabaseSync(file);
    d.exec('DROP TRIGGER xhs_unbound_review_immutable_delete');
    d.close();
    assert.throws(() =>
      require(path.join(folder, 'switch-prewrite.cjs')).inspectSwitchDatabase({
        database: file,
        roles,
        operationId: crypto.randomUUID(),
        stage: 'before-migration',
      }),
    );
  },
);
