'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createArtifacts, mutationEvents } = require('./artifact-intents.cjs');

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-artifact-intents-'));
  const root = path.join(base, 'output');
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, root, tracker: createArtifacts(root) };
}
function compiler(root, code) {
  const result = spawnSync(process.execPath, ['-e', code], {
    env: {
      ...process.env,
      NODE_OPTIONS:
        '--require ' +
        JSON.stringify(path.join(__dirname, 'artifact-producer-hook.cjs')),
      WEWE_ARTIFACT_ROOT: root,
      WEWE_ARTIFACT_FD: '3',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const rows = result.output[3].trim().split('\n').map(JSON.parse);
  assert(rows.some((row) => row.producer === result.pid));
  return rows.filter((row) => !row.producer);
}

test('the single pinned generator shell request becomes a direct current-Node child with a working intent pipe', (t) => {
  const { base, root, tracker } = fixture(t),
    generator = path.join(base, 'generator with spaces.cjs');
  fs.writeFileSync(
    generator,
    `const m=require('node:module');if(m.enableCompileCache&&m.enableCompileCache().status!==m.constants.compileCacheStatus.DISABLED)throw Error('native cache must stay disabled');require('node:fs').writeFileSync(require('node:path').join(process.env.WEWE_ARTIFACT_ROOT,'generated'),'synthetic generator bytes');`,
  );
  const hash = require('node:crypto')
    .createHash('sha256')
    .update(fs.readFileSync(generator))
    .digest('hex');
  const command =
    JSON.stringify(process.execPath.replace(/\\/g, '/')) +
    ' ' +
    JSON.stringify(generator.replace(/\\/g, '/'));
  const env = {
    ...process.env,
    NODE_OPTIONS:
      '--require ' +
      JSON.stringify(path.join(__dirname, 'artifact-producer-hook.cjs')),
    WEWE_ARTIFACT_ROOT: root,
    WEWE_ARTIFACT_FD: '3',
    WEWE_PRISMA_GENERATOR_ENTRY: generator,
    WEWE_PRISMA_GENERATOR_SHA256: hash,
    WEWE_PRISMA_GENERATOR_COMMAND: command,
  };
  const code = `const result=require('node:child_process').spawnSync; const child=require('node:child_process').spawn(process.env.WEWE_PRISMA_GENERATOR_COMMAND,[],{shell:true,stdio:['pipe','pipe','pipe']}); child.on('error',error=>{console.error(error);process.exitCode=1;});child.on('exit',code=>{process.exitCode=code;});`;
  const result = spawnSync(process.execPath, ['-e', code], {
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  tracker.apply(
    result.output[3]
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse)
      .filter((row) => !row.producer),
  );
  tracker.verify();
  fs.unlinkSync(path.join(root, 'generated'));
  fs.writeFileSync(generator, 'process.exit(0);');
  const changed = spawnSync(process.execPath, ['-e', code], {
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /PRISMA_GENERATOR_BINDING_REQUIRED/);
});

test('compiler intent pipe binds synchronous, callback, promise and nested generator bytes without a disk receipt', (t) => {
  const { root, tracker } = fixture(t);
  const rows = compiler(
    root,
    `
    const fs = require('node:fs'), path = require('node:path');
    const root = process.env.WEWE_ARTIFACT_ROOT;
    fs.writeFileSync(path.join(root, 'sync'), 'sync');
    fs.writeFile(path.join(root, 'callback'), 'callback', error => { if(error) throw error; });
    fs.promises.writeFile(path.join(root, 'promise'), 'promise');
    const result = require('node:child_process').spawnSync(process.execPath, ['-e', "require('node:fs').writeFileSync(require('node:path').join(process.env.WEWE_ARTIFACT_ROOT,'generator'),'generator')"]);
    if(result.status !== 0) throw Error(result.stderr);
  `,
  );
  tracker.apply(rows);
  tracker.verify();
  assert.deepEqual(Object.keys(tracker.fingerprint().files).sort(), [
    'callback',
    'generator',
    'promise',
    'sync',
  ]);
});

test('producer declarations do not absorb an injected file or replacement before acceptance', (t) => {
  const { root, tracker } = fixture(t);
  const rows = compiler(
    root,
    `require('node:fs').writeFileSync(require('node:path').join(process.env.WEWE_ARTIFACT_ROOT,'artifact'),'expected')`,
  );
  tracker.apply(rows);
  fs.writeFileSync(path.join(root, 'external'), 'preserve');
  assert.throws(() => tracker.verify(), /UNREQUESTED/);
  assert.equal(
    fs.readFileSync(path.join(root, 'external'), 'utf8'),
    'preserve',
  );
  // Test-only fixture cleanup exposes the independent expected-content check.
  fs.unlinkSync(path.join(root, 'external'));
  fs.writeFileSync(path.join(root, 'artifact'), 'rewritten');
  assert.throws(() => tracker.verify(), /CHANGED/);
});

test('static copies bind source bytes before copying and manifests contain only declared files', (t) => {
  const { base, root, tracker } = fixture(t);
  const source = path.join(base, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'asset'), 'source bytes');
  const destination = path.join(root, 'copied'),
    args = [source, destination, { recursive: true }];
  const events = mutationEvents('cp', args);
  fs.cpSync(...args);
  tracker.apply(events);
  tracker.verify();
  assert.deepEqual(Object.keys(tracker.fingerprint().files), ['copied/asset']);
  fs.writeFileSync(path.join(destination, 'asset'), 'external bytes');
  assert.throws(() => tracker.verify(), /CHANGED/);
});

test('compiler write attempts outside its owned output fail before creating the target', (t) => {
  const { base, root } = fixture(t),
    outside = path.join(base, 'forbidden');
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(outside)},'forbidden')`,
    ],
    {
      env: {
        ...process.env,
        NODE_OPTIONS:
          '--require ' +
          JSON.stringify(path.join(__dirname, 'artifact-producer-hook.cjs')),
        WEWE_ARTIFACT_ROOT: root,
        WEWE_ARTIFACT_FD: '3',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WRITE_OUTSIDE_OUTPUT/);
  assert(!fs.existsSync(outside));
});
