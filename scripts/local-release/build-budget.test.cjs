const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const guard = require('./build-budget.cjs');
function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-build-budget-'));
  const previous = process.env.WEWE_RELEASE_MAX_BYTES;
  process.env.WEWE_RELEASE_MAX_BYTES = '4096';
  try {
    run(root);
  } finally {
    if (previous === undefined) delete process.env.WEWE_RELEASE_MAX_BYTES;
    else process.env.WEWE_RELEASE_MAX_BYTES = previous;
    assert(path.basename(root).startsWith('wewe-build-budget-'));
    fs.rmSync(root, { recursive: true });
  }
}
test('repeated builds count previous packages and reject before generation', () =>
  fixture((root) => {
    const first = guard.begin(root, 2048);
    first.create(path.join(root, 'old'));
    fs.writeFileSync(path.join(root, 'old/package'), Buffer.alloc(3000));
    first.check();
    first.finish();
    assert.throws(
      () => guard.begin(root, 2048),
      /RELEASE_SPACE_BUDGET_EXCEEDED/,
    );
    assert.equal(fs.statSync(path.join(root, 'old/package')).size, 3000);
    assert(!fs.existsSync(path.join(root, '.build-budget.lock')));
  }));
test('failed build removes only its new directory and releases shared lease', () =>
  fixture((root) => {
    fs.mkdirSync(path.join(root, 'old'));
    fs.writeFileSync(path.join(root, 'old/package'), 'unchanged');
    const run = guard.begin(root, 2048);
    run.create(path.join(root, 'new'));
    fs.writeFileSync(path.join(root, 'new/partial'), 'partial');
    assert.throws(() => guard.begin(root, 1), /locked/);
    run.finish(new Error('injected compiler failure'));
    assert(!fs.existsSync(path.join(root, 'new')));
    assert.equal(
      fs.readFileSync(path.join(root, 'old/package'), 'utf8'),
      'unchanged',
    );
    const retry = guard.begin(root, 2048);
    retry.finish();
  }));
test('final overflow refuses success and cleans only failed build', () =>
  fixture((root) => {
    const run = guard.begin(root, 1024);
    run.create(path.join(root, 'new'));
    fs.writeFileSync(path.join(root, 'new/overflow'), Buffer.alloc(5000));
    assert.throws(() => run.check(), /RELEASE_SPACE_BUDGET_EXCEEDED/);
    run.finish(new Error('quota'));
    assert(!fs.existsSync(path.join(root, 'new')));
  }));
test('replaced failed-build directory is preserved for review', () =>
  fixture((root) => {
    const run = guard.begin(root, 1024);
    run.create(path.join(root, 'new'));
    fs.renameSync(path.join(root, 'new'), path.join(root, 'original'));
    fs.mkdirSync(path.join(root, 'new'));
    fs.writeFileSync(path.join(root, 'new/unknown'), 'preserve');
    assert.throws(() => run.finish(new Error('failure')), /identity changed/);
    assert(fs.existsSync(path.join(root, 'new/unknown')));
  }));

test('foreign replacement of build lock is preserved', () =>
  fixture((root) => {
    const run = guard.begin(root, 1024);
    const lock = path.join(root, '.build-budget.lock');
    fs.writeFileSync(lock, 'foreign owner');
    assert.throws(() => run.finish(), /ownership changed/);
    assert.equal(fs.readFileSync(lock, 'utf8'), 'foreign owner');
  }));
