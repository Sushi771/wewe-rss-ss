const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test, before, after } = require('node:test');

const server = path.resolve(__dirname, '..');
const prismaRoot = path.join(server, 'prisma');
const manifest = require('./fixtures/aeb-schema-compatibility.json');
const digest = (bytes) =>
  crypto
    .createHash('sha256')
    .update(bytes.toString().replace(/\r\n/g, '\n'))
    .digest('hex');
const schema = fs.readFileSync(path.join(prismaRoot, 'schema.prisma'), 'utf8');
const names = Object.keys(manifest.migrations);
const mainNames = manifest.mainMigrations;
const cli = require.resolve('prisma/build/index.js');
const previousLibrary = process.env.PRISMA_QUERY_ENGINE_LIBRARY;
let owned;
let PrismaClient;

function command(args, database) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: server,
    env: {
      ...process.env,
      DATABASE_URL: `file:${database.replace(/\\/g, '/')}`,
      PRISMA_GENERATE_SKIP_AUTOINSTALL: '1',
      CHECKPOINT_DISABLE: '1',
    },
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
}
function client(database) {
  return new PrismaClient({
    datasources: {
      db: { url: `file:${database.replace(/\\/g, '/')}?connection_limit=1` },
    },
  });
}
function layout(label, selected) {
  const directory = path.join(owned, label);
  fs.mkdirSync(path.join(directory, 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'schema.prisma'), schema);
  fs.copyFileSync(
    path.join(prismaRoot, 'migrations/migration_lock.toml'),
    path.join(directory, 'migrations/migration_lock.toml'),
  );
  for (const name of selected) {
    const destination = path.join(directory, 'migrations', path.dirname(name));
    fs.mkdirSync(destination, { recursive: true });
    fs.copyFileSync(
      path.join(prismaRoot, 'migrations', name),
      path.join(destination, 'migration.sql'),
    );
  }
  return path.join(directory, 'schema.prisma');
}
async function seeded(database, compatibility) {
  const db = client(database);
  await db.$executeRawUnsafe(
    `INSERT INTO accounts(id,token,name,status,created_at) VALUES ('synthetic-account','synthetic-token','synthetic',1,1767225600000)`,
  );
  await db.$executeRawUnsafe(
    `INSERT INTO feeds(id,mp_name,mp_cover,mp_intro,update_time,created_at) VALUES ('synthetic-feed','synthetic','','',1,1767225600000)`,
  );
  await db.$executeRawUnsafe(
    `INSERT INTO articles(id,mp_id,title,pic_url,publish_time,content_html,created_at) VALUES ('synthetic-article','synthetic-feed','retained','',1767225600,'<p>retained synthetic body</p>',1767225600000)`,
  );
  if (compatibility) {
    await db.managementGroup.create({
      data: {
        id: 'synthetic-group',
        name: 'retained group',
        platform: 'wechat',
      },
    });
    await db.feed.update({
      where: { id: 'synthetic-feed' },
      data: { groupId: 'synthetic-group' },
    });
    // Existing opaque compatibility rows must survive too; no XHS API is invoked.
    await db.xhsCreator.create({
      data: {
        id: 'synthetic-creator',
        profileUrl: 'https://synthetic.invalid/creator',
        displayName: 'retained compatibility row',
      },
    });
    await db.xhsNote.create({
      data: {
        id: 'synthetic-note',
        creatorId: 'synthetic-creator',
        title: 'retained',
        publishTime: 1,
        status: 'pending',
        contentHtml: '<p>retained compatibility body</p>',
      },
    });
    await db.$executeRawUnsafe(
      `INSERT INTO refresh_submission_claims VALUES ('synthetic-unknown','synthetic-feed','unknown',1,0,1)`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO cache_refresh_commits VALUES ('synthetic-commit','synthetic-feed','{"retained":true}',1)`,
    );
  }
  await db.$disconnect();
}
async function rows(database, tables) {
  const db = client(database);
  try {
    const result = {};
    for (const table of tables) {
      assert.match(table, /^[a-z_]+$/);
      result[table] = await db.$queryRawUnsafe(
        `SELECT * FROM "${table}" ORDER BY id`,
      );
    }
    return JSON.parse(
      JSON.stringify(result, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    );
  } finally {
    await db.$disconnect();
  }
}
before(() => {
  assert.equal(
    digest(schema),
    manifest.schemaSha256,
    'Pinned deployed schema changed',
  );
  assert.equal(names.length, 20);
  assert.equal(mainNames.length, 12);
  for (const name of mainNames)
    assert.ok(Object.prototype.hasOwnProperty.call(manifest.migrations, name));
  const actual = fs
    .readdirSync(path.join(prismaRoot, 'migrations'))
    .filter((name) =>
      fs.statSync(path.join(prismaRoot, 'migrations', name)).isDirectory(),
    )
    .sort();
  assert.deepEqual(actual, names.map((name) => path.dirname(name)).sort());
  for (const name of names)
    assert.equal(
      digest(fs.readFileSync(path.join(prismaRoot, 'migrations', name))),
      manifest.migrations[name],
      `Historical migration changed: ${name}`,
    );
  fs.mkdirSync(path.join(server, '.cache'), { recursive: true });
  owned = fs.mkdtempSync(path.join(server, '.cache', 'main-schema-compat-'));
  // Keep the loaded native library outside the owned fixture tree on Windows;
  // the OS cannot remove an in-process DLL even after Prisma disconnects.
  const installedClient = path.dirname(
    require.resolve('.prisma/client/default', {
      paths: [require.resolve('@prisma/client/package.json')],
    }),
  );
  const libraries = fs
    .readdirSync(installedClient)
    .filter((name) =>
      process.platform === 'win32'
        ? name === 'query_engine-windows.dll.node'
        : process.platform === 'darwin'
          ? /^libquery_engine-darwin.*\.node$/.test(name)
          : /^libquery_engine-.*\.so\.node$/.test(name),
    );
  const nativeLibrary =
    libraries.find((name) => !name.includes('musl')) || libraries[0];
  assert.ok(
    nativeLibrary,
    'Reuse an installed native engine; never install one for this fixture',
  );
  process.env.PRISMA_QUERY_ENGINE_LIBRARY = path.join(
    installedClient,
    nativeLibrary,
  );
  const output = path.join(owned, 'client').replace(/\\/g, '/');
  const generatedSchema = schema
    .replace(/binaryTargets\s*=\s*\[[^\]]+\]/, 'binaryTargets = ["native"]')
    .replace(
      /provider\s*=\s*"prisma-client-js"/,
      `provider = "prisma-client-js"\n  output = ${JSON.stringify(output)}`,
    );
  const generatedPath = path.join(owned, 'generated.prisma');
  fs.writeFileSync(generatedPath, generatedSchema);
  command(
    ['generate', '--schema', generatedPath],
    path.join(owned, 'unused.db'),
  );
  PrismaClient = require(path.join(output, 'index.js')).PrismaClient;
});
after(() => {
  if (previousLibrary === undefined)
    delete process.env.PRISMA_QUERY_ENGINE_LIBRARY;
  else process.env.PRISMA_QUERY_ENGINE_LIBRARY = previousLibrary;
  if (!owned) return;
  const allowed = fs.realpathSync(path.join(server, '.cache'));
  const resolved = fs.realpathSync(owned);
  assert.equal(path.dirname(resolved), allowed);
  assert.match(path.basename(resolved), /^main-schema-compat-/);
  fs.rmSync(resolved, { recursive: true, force: true });
});

test('fresh empty database applies every original migration with empty compatibility tables', async () => {
  const database = path.join(owned, 'fresh.db');
  command(
    ['migrate', 'deploy', '--schema', path.join(prismaRoot, 'schema.prisma')],
    database,
  );
  const snapshot = await rows(database, [
    '_prisma_migrations',
    'accounts',
    'feeds',
    'articles',
    'management_groups',
    'xhs_creators',
    'xhs_notes',
    'refresh_submission_claims',
    'cache_refresh_commits',
  ]);
  assert.equal(snapshot._prisma_migrations.length, 20);
  for (const row of snapshot._prisma_migrations)
    assert.equal(
      row.checksum,
      crypto
        .createHash('sha256')
        .update(
          fs.readFileSync(
            path.join(
              prismaRoot,
              'migrations',
              row.migration_name,
              'migration.sql',
            ),
          ),
        )
        .digest('hex'),
    );
  for (const [table, records] of Object.entries(snapshot))
    if (table !== '_prisma_migrations') assert.deepEqual(records, []);
  assert.ok(fs.statSync(database).size < 1024 * 1024);
});

test('an existing deployed-schema database retains every row and migration checksum', async () => {
  const database = path.join(owned, 'existing-aeb.db');
  const baseline = layout(
    'aeb-original-history',
    names.filter((name) => !name.startsWith('20261020100000_')),
  );
  command(['migrate', 'deploy', '--schema', baseline], database);
  await seeded(database, true);
  const tables = [
    '_prisma_migrations',
    'accounts',
    'feeds',
    'articles',
    'management_groups',
    'xhs_creators',
    'xhs_notes',
    'cache_insert_batches',
    'refresh_submission_claims',
    'cache_refresh_commits',
  ];
  const before = await rows(database, tables);
  command(
    ['migrate', 'deploy', '--schema', path.join(prismaRoot, 'schema.prisma')],
    database,
  );
  const after = await rows(database, tables);
  for (const table of tables.filter((name) => name !== '_prisma_migrations'))
    assert.deepEqual(after[table], before[table]);
  assert.equal(before._prisma_migrations.length, 19);
  assert.equal(after._prisma_migrations.length, 20);
  for (const record of before._prisma_migrations)
    assert.deepEqual(
      after._prisma_migrations.find((row) => row.id === record.id),
      record,
    );
  command(
    ['migrate', 'deploy', '--schema', path.join(prismaRoot, 'schema.prisma')],
    database,
  );
  assert.deepEqual(await rows(database, tables), after);
  assert.equal(before.refresh_submission_claims[0].state, 'unknown');
});

test('an existing main-schema database upgrades additively and preserves bodies and accounts', async () => {
  const database = path.join(owned, 'existing-main.db');
  command(
    [
      'migrate',
      'deploy',
      '--schema',
      layout('main-original-history', mainNames),
    ],
    database,
  );
  await seeded(database, false);
  const before = await rows(database, [
    'accounts',
    'articles',
    '_prisma_migrations',
  ]);
  command(
    ['migrate', 'deploy', '--schema', path.join(prismaRoot, 'schema.prisma')],
    database,
  );
  const after = await rows(database, [
    'accounts',
    'articles',
    '_prisma_migrations',
  ]);
  assert.deepEqual(after.accounts, before.accounts);
  assert.deepEqual(after.articles, before.articles);
  assert.equal(after._prisma_migrations.length, 20);
  for (const record of before._prisma_migrations)
    assert.deepEqual(
      after._prisma_migrations.find((row) => row.id === record.id),
      record,
    );
  const db = client(database);
  try {
    assert.equal(
      (await db.feed.findUniqueOrThrow({ where: { id: 'synthetic-feed' } }))
        .groupId,
      null,
    );
    assert.equal(await db.xhsCreator.count(), 0);
  } finally {
    await db.$disconnect();
  }
});

test('schema compatibility registers no XHS, Rnote or paid application entry points', () => {
  for (const file of [
    'src/app.module.ts',
    'src/trpc/trpc.module.ts',
    'src/trpc/trpc.router.ts',
    '../web/src/App.tsx',
    '../web/src/components/Nav.tsx',
  ]) {
    const source = fs.readFileSync(path.resolve(server, file), 'utf8');
    assert.doesNotMatch(
      source,
      /XiaohongshuService|xiaohongshuRouter|rnote-public|paid-subscriptions|\/xiaohongshu/,
    );
  }
});
