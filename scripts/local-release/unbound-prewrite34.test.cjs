'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('fs'),
  path = require('path'),
  os = require('os'),
  crypto = require('crypto'),
  { DatabaseSync } = require('node:sqlite');
const hash = (f) =>
    crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'),
  oldFolder = process.env.WEWE_SCHEMA34_CURRENT_RELEASE,
  oldPin = '9bdd1b22027c422761ba7a5aa9925855e0a3c8b88b08be43f5d88b40d889822e',
  name = '20261106010000_xhs_unbound_round';
test(
  'real prewrite gate admits exact schema33->34 and rejects schema/receipt/manifest drift',
  { skip: !oldFolder },
  (t) => {
    assert.equal(hash(path.join(oldFolder, 'release.json')), oldPin);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema34-prewrite-')),
      candidate = path.join(root, 'synthetic-candidate34');
    fs.mkdirSync(candidate);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const tools = __dirname,
      source = path.resolve(tools, '../../apps/server');
    fs.cpSync(
      path.join(source, 'prisma'),
      path.join(candidate, 'server/prisma'),
      { recursive: true },
    );
    const old = JSON.parse(
        fs.readFileSync(path.join(oldFolder, 'release.json')),
      ),
      manifest = structuredClone(old);
    manifest.id = 'synthetic-candidate34';
    for (const f of [
      'switch-prewrite.cjs',
      'switch-contract.cjs',
      'lib.cjs',
      'task-document-preflight.cjs',
      'switch-schema-contract.json',
    ]) {
      fs.writeFileSync(
        path.join(candidate, f),
        new TextDecoder('utf8', { fatal: true })
          .decode(fs.readFileSync(path.join(tools, f)))
          .replace(/\r\n/g, '\n'),
      );
      manifest.files[f] = hash(path.join(candidate, f));
    }
    const migration = path.join(
      candidate,
      'server/prisma/migrations',
      name,
      'migration.sql',
    );
    manifest.files['server/prisma/migrations/' + name + '/migration.sql'] =
      hash(migration);
    manifest.migrationContract =
      require('./switch-contract.cjs').migrationContract(manifest);
    manifest.prewriteSchemaContract = {
      format: 1,
      file: 'switch-schema-contract.json',
      sha256: manifest.files['switch-schema-contract.json'],
      gateSha256: manifest.files['switch-prewrite.cjs'],
    };
    fs.writeFileSync(
      path.join(candidate, 'release.json'),
      JSON.stringify(manifest),
    );
    const roles = {
      current: {
        folder: path.resolve(oldFolder),
        manifest: old,
        manifestSha256: oldPin,
      },
      rollback: {
        folder: path.resolve(oldFolder),
        manifest: old,
        manifestSha256: oldPin,
      },
      candidate: {
        folder: candidate,
        manifest,
        manifestSha256: hash(path.join(candidate, 'release.json')),
      },
    };
    const catalog = JSON.parse(
        fs.readFileSync(path.join(candidate, 'switch-schema-contract.json')),
      ),
      p = catalog.profiles.canonical33,
      dbfile = path.join(root, 'synthetic.db');
    const db = new DatabaseSync(dbfile);
    db.exec(
      p.objects.find(
        (x) => x.name === '_prisma_migrations' && x.type === 'table',
      ).sql,
    );
    for (const m of p.migrations) {
      db.exec(
        fs.readFileSync(
          path.join(
            candidate,
            'server/prisma/migrations',
            m.name,
            'migration.sql',
          ),
          'utf8',
        ),
      );
      db.prepare(
        'INSERT INTO _prisma_migrations(id,checksum,finished_at,migration_name,started_at,applied_steps_count) VALUES(?,?,?,?,?,1)',
      ).run(
        crypto.randomUUID(),
        m.receiptSha256,
        '2026-11-01T00:00:00Z',
        m.name,
        '2026-11-01T00:00:00Z',
      );
    }
    db.close();
    const gate = require(path.join(candidate, 'switch-prewrite.cjs')),
      operationId = crypto.randomUUID(),
      request = { database: dbfile, roles, operationId };
    const before = gate.inspectSwitchDatabase({
      ...request,
      stage: 'before-migration',
    });
    assert.equal(before.profile, 'canonical33');
    const writer = new DatabaseSync(dbfile);
    writer.exec(fs.readFileSync(migration, 'utf8'));
    writer
      .prepare(
        'INSERT INTO _prisma_migrations(id,checksum,finished_at,migration_name,started_at,applied_steps_count) VALUES(?,?,?,?,?,1)',
      )
      .run(
        crypto.randomUUID(),
        hash(migration),
        '2026-11-01T00:00:00Z',
        name,
        '2026-11-01T00:00:00Z',
      );
    writer.close();
    const after = gate.inspectSwitchDatabase({
      ...request,
      stage: 'after-migration',
    });
    assert.equal(after.profile, 'canonical34');
    assert.equal(gate.assertSwitchTransition(before, after), true);
    const alter = (sql) => {
      const d = new DatabaseSync(dbfile);
      d.exec(sql);
      d.close();
    };
    alter('CREATE TABLE unexpected_schema(id TEXT)');
    assert.throws(() =>
      gate.inspectSwitchDatabase({ ...request, stage: 'after-migration' }),
    );
    alter('DROP TABLE unexpected_schema');
    alter(
      "UPDATE _prisma_migrations SET checksum='" +
        '0'.repeat(64) +
        "' WHERE migration_name='" +
        name +
        "'",
    );
    assert.throws(() =>
      gate.inspectSwitchDatabase({ ...request, stage: 'after-migration' }),
    );
    alter(
      "UPDATE _prisma_migrations SET checksum='" +
        hash(migration) +
        "' WHERE migration_name='" +
        name +
        "'",
    );
    alter('DROP TRIGGER xhs_unbound_review_immutable_delete');
    assert.throws(() =>
      gate.inspectSwitchDatabase({ ...request, stage: 'after-migration' }),
    );
    const bad = structuredClone(roles);
    bad.candidate.manifest.files[
      'server/prisma/migrations/' + name + '/migration.sql'
    ] = 'a'.repeat(64);
    assert.throws(() =>
      gate.inspectSwitchDatabase({
        ...request,
        roles: bad,
        stage: 'before-migration',
      }),
    );
  },
);

test('canonical34 preserves all old schema and exact new SQL, and both packaged gates agree', () => {
  const c = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'switch-schema-contract.json')),
  );
  const p = c.profiles.canonical33,
    n = c.profiles.canonical34;
  assert.equal(n.migrations.length, 34);
  assert.equal(n.schemaPrismaSha256, p.schemaPrismaSha256);
  for (const m of p.migrations)
    assert.deepEqual(
      n.migrations.find((x) => x.name === m.name),
      m,
    );
  for (const o of p.objects)
    assert.deepEqual(
      n.objects.find((x) => x.name === o.name && x.type === o.type),
      o,
    );
  for (const [k, v] of Object.entries(p.tables))
    assert.deepEqual(n.tables[k], v);
  assert.equal(
    n.migrations.find((m) => m.name === name).sha256,
    '05263fa79ce07a05f11dd243cd6c39d9158913127e8e229f4ed8cbc858e0d703',
  );
  assert.deepEqual(
    c,
    JSON.parse(
      fs.readFileSync(
        path.join(
          __dirname,
          'updater/install-binding/role-aware/switch-schema-contract.json',
        ),
      ),
    ),
  );
  const normalized = (f) =>
    new TextDecoder('utf8', { fatal: true })
      .decode(fs.readFileSync(f))
      .replace(/\r\n/g, '\n');
  assert.equal(
    normalized(path.join(__dirname, 'switch-prewrite.cjs')),
    normalized(
      path.join(
        __dirname,
        'updater/install-binding/role-aware/switch-prewrite.cjs',
      ),
    ),
  );
});
