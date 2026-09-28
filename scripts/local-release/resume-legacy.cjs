// 仅对保留的演练副本重试旧版进程回滚；始终只结束本脚本创建的子进程。
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { parseArgs } = require('node:util');
const {
  verifyRelease,
  readJson,
  writeJson,
  cleanEnvironment,
  inside,
  run,
} = require('./lib.cjs');

async function unusedPort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function main() {
  const { values } = parseArgs({
    options: {
      legacy: { type: 'string' },
      audit: { type: 'string' },
    },
  });
  if (!values.legacy || !values.audit)
    throw new Error('须指定 --legacy 与 --audit');
  const legacy = fs.realpathSync(values.legacy);
  const audit = fs.realpathSync(values.audit);
  const root = path.resolve(__dirname, '../..');
  assert(
    inside(path.join(root, 'output/playwright/local-release-audit'), audit),
  );
  const manifest = verifyRelease(legacy);
  assert.equal(manifest.schemaCompatibility, 'legacy-additive');
  assert.equal(
    manifest.sourceCommit,
    '9755d166e398f77baf52317f63ef36024037881d',
  );
  const database = path.join(audit, 'rehearsal.db');
  assert.equal(
    fs.realpathSync(readJson(database + '.rehearsal.json').database),
    fs.realpathSync(database),
  );
  run(process.env.SQLITE_BACKUP_PYTHON || 'python', [
    path.join(legacy, 'inspect-sqlite.py'),
    '--database',
    database,
    '--migrations',
    path.join(legacy, 'known-migrations'),
    '--baseline',
    path.join(audit, 'copy-before.json'),
    '--require-current',
  ]);
  fs.writeFileSync(
    database + '.rehearsal.json',
    JSON.stringify({ releaseId: manifest.id, database }),
  );
  const pauseFile = path.join(root, 'tools/wechat-desktop-collector/.paused');
  const guardReport = path.join(
    audit,
    `legacy-resume-${manifest.id}-guard.json`,
  );
  const log = fs.openSync(
    path.join(audit, `legacy-resume-${manifest.id}.log`),
    'wx',
  );
  const port = await unusedPort();
  const child = spawn(
    path.join(legacy, 'runtime/node.exe'),
    [
      path.join(legacy, 'runtime.cjs'),
      'start',
      '--database',
      database,
      '--port',
      String(port),
      '--pause-file',
      pauseFile,
      '--rehearsal',
      '--obsidian-root',
      path.join(audit, 'legacy-resume-vault'),
      '--guard-report',
      guardReport,
    ],
    {
      cwd: audit,
      windowsHide: true,
      shell: false,
      env: { ...cleanEnvironment(), CRON_EXPRESSION: '0 0 1 1 *' },
      stdio: ['ignore', log, log],
    },
  );
  const closed = once(child, 'close');
  let ready = false;
  try {
    const deadline = Date.now() + 360000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null)
        throw new Error('旧版回滚进程提前退出，查看 legacy-resume.log');
      try {
        const response = await fetch(`http://127.0.0.1:${port}/dash`, {
          signal: AbortSignal.timeout(1000),
        });
        ready = response.ok;
      } catch {
        /* 等待启动 */
      }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    assert(ready, '旧版回滚进程启动超时');
    const dash = await fetch(`http://127.0.0.1:${port}/dash`);
    const html = await dash.text();
    const asset = html.match(/(?:src|href)="(\/dash\/assets\/[^"?#]+\.js)"/)[1];
    const assetResponse = await fetch(`http://127.0.0.1:${port}${asset}`);
    assert.equal(assetResponse.status, 200);
    assert((await assetResponse.text()).length > 1000);
    const rss = await fetch(
      `http://127.0.0.1:${port}/feeds/MP_WXS_3895431412.rss?limit=20&mode=summary`,
    );
    assert.equal(rss.status, 200);
    assert.equal(((await rss.text()).match(/<item>/g) || []).length, 20);
    assert.deepEqual(readJson(guardReport), {
      installed: true,
      blockedNetwork: 0,
      blockedChildren: 0,
    });
  } finally {
    if (child.exitCode === null) child.kill();
    await closed;
    fs.closeSync(log);
  }
  const result = {
    passed: true,
    audit,
    legacy,
    migratedDatabase: database,
    processStopped: true,
    staticAsset: true,
    rssItems: 20,
  };
  writeJson(
    path.join(audit, `legacy-resume-${manifest.id}-summary.json`),
    result,
  );
  console.log(JSON.stringify(result));
}

if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { main };
