'use strict';
// Same child-process fault scenarios, with Prisma for fixture setup/inspection.
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { isolatedClient } = require('./resolve-run.cjs');
const { PrismaClient } = require(isolatedClient());
const server = path.resolve(__dirname, '../..');
const { splitSqliteStatements } = require(
  path.resolve(server, '../../scripts/sqlite-statements.cjs'),
);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redbook-process-fixture-'));
const client = (file) =>
  new PrismaClient({
    datasources: { db: { url: 'file:' + file.replace(/\\/g, '/') } },
  });
const stable = (value) =>
  JSON.stringify(value, (_key, v) =>
    typeof v === 'bigint' ? v.toString() : v,
  );
async function setup(name) {
  const file = path.join(root, name + '.sqlite');
  if (path.dirname(file) !== path.resolve(root))
    throw Error('FIXTURE_PATH_INVALID');
  const db = client(file);
  try {
    const migrations = path.join(server, 'prisma/migrations');
    for (const d of fs
      .readdirSync(migrations, { withFileTypes: true })
      .filter((x) => x.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const sql = path.join(migrations, d.name, 'migration.sql');
      if (fs.existsSync(sql))
        for (const statement of splitSqliteStatements(
          fs.readFileSync(sql, 'utf8'),
        ))
          await db.$executeRawUnsafe(statement);
    }
    for (const [id, author] of [
      ['a', 'author-a'],
      ['b', 'author-b'],
    ])
      await db.$executeRawUnsafe(
        'INSERT INTO xhs_creators(id,profile_url,display_name,external_author_id,enabled) VALUES(?,?,?,?,1)',
        id,
        'https://example.invalid/' + id,
        'Synthetic ' + id,
        author,
      );
    await db.$executeRawUnsafe(
      "INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0)",
    );
  } finally {
    await db.$disconnect();
  }
  return file;
}
const jest = require.resolve('jest/bin/jest', { paths: [server] });
function run(file, mode) {
  return spawnSync(
    process.execPath,
    [
      jest,
      '--config',
      'jest.redbook-isolated.cjs',
      'xhs-p0-process-exit.worker.ts',
      '--runInBand',
    ],
    {
      cwd: server,
      encoding: 'utf8',
      timeout: 90000,
      env: {
        SystemRoot: process.env.SystemRoot || 'C:\\Windows',
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        NODE_ENV: 'test',
        REDBOOK_TEST_RUN: process.env.REDBOOK_TEST_RUN,
        XHS_FIXTURE_ROOT: root,
        XHS_FIXTURE_DB: file,
        XHS_FIXTURE_MODE: mode,
      },
    },
  );
}
async function inspect(file, fn) {
  const db = client(file);
  try {
    return await fn(db);
  } finally {
    await db.$disconnect();
  }
}
async function main() {
  const file = await setup('during');
  const crashed = run(file, 'crash-read');
  assert.equal(
    crashed.status,
    73,
    `crash child status ${crashed.status}; ${crashed.stderr}`,
  );
  const reopen = run(file, 'inspect');
  assert.equal(
    reopen.status,
    0,
    `inspect child status ${reopen.status}; ${reopen.stderr}`,
  );
  assert.equal(
    await inspect(file, async (db) =>
      Number(
        (
          await db.$queryRawUnsafe(
            "SELECT count(*) n FROM xhs_subscription_tasks WHERE creator_id='b'",
          )
        )[0].n,
      ),
    ),
    0,
  );
  const transaction = await setup('transaction');
  const killed = run(transaction, 'crash-transaction');
  if (process.platform === 'win32')
    assert.equal(
      killed.status,
      1,
      `unexpected Windows kill status: ${killed.status}`,
    );
  else
    assert.equal(
      killed.signal,
      'SIGKILL',
      `unexpected kill signal: ${killed.signal}`,
    );
  assert.doesNotMatch(killed.stderr, /\bFAIL\b|Test Suites:|KILL_RETURNED/);
  assert.equal(
    fs.existsSync(transaction + '.kill-ready'),
    true,
    'transaction kill failpoint not reached',
  );
  assert.equal(
    await inspect(transaction, async (db) =>
      Number(
        (
          await db.$queryRawUnsafe(
            "SELECT count(*) n FROM xhs_notes WHERE creator_id='a'",
          )
        )[0].n,
      ),
    ),
    0,
  );
  const transactionReopen = run(transaction, 'inspect');
  assert.equal(
    transactionReopen.status,
    0,
    `transaction inspect status ${transactionReopen.status}; ${transactionReopen.stderr}`,
  );
  const committed = await setup('committed');
  const after = run(committed, 'crash-commit');
  assert.equal(
    after.status,
    74,
    `commit child status ${after.status}; ${after.stderr}`,
  );
  const before = await inspect(committed, async (db) => ({
    notes: stable(
      await db.$queryRawUnsafe(
        "SELECT * FROM xhs_notes WHERE creator_id='a' ORDER BY id",
      ),
    ),
    task: (
      await db.$queryRawUnsafe(
        "SELECT document FROM xhs_subscription_tasks WHERE creator_id='a' AND state='completed'",
      )
    )[0].document,
    pending: Number(
      (
        await db.$queryRawUnsafe(
          "SELECT count(*) n FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%'",
        )
      )[0].n,
    ),
  }));
  assert.equal(before.pending, 0);
  assert.equal(JSON.parse(before.task).sourceActive == null, true);
  const replay = run(committed, 'inspect-complete');
  assert.equal(
    replay.status,
    0,
    `replay child status ${replay.status}; ${replay.stderr}`,
  );
  const afterState = await inspect(committed, async (db) => ({
    notes: stable(
      await db.$queryRawUnsafe(
        "SELECT * FROM xhs_notes WHERE creator_id='a' ORDER BY id",
      ),
    ),
    task: (
      await db.$queryRawUnsafe(
        "SELECT document FROM xhs_subscription_tasks WHERE creator_id='a' AND state='completed'",
      )
    )[0].document,
  }));
  assert.equal(afterState.notes, before.notes);
  assert.equal(afterState.task, before.task);
  const continuation = run(committed, 'inspect-continue');
  assert.equal(
    continuation.status,
    0,
    `continuation child status ${continuation.status}; ${continuation.stderr}`,
  );
  console.log(
    'PASS portable scheduled service: process exit during synthetic detail and after committed task; restart blocks replay',
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
