const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fingerprint, verifyRelease } = require('./lib.cjs');
const { controlledRestart } = require('./restart.cjs');

test('full RSS acceptance is bound to canonical package origin, manifest, verifier and privacy mode', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-acceptance-'));
  const previous = process.env.PRIVATE_ONLINE_MODE;
  process.env.PRIVATE_ONLINE_MODE = '0';
  try {
    const scripts = path.join(root, 'scripts/local-release');
    fs.mkdirSync(scripts, { recursive: true });
    for (const file of ['lib.cjs', 'startup-acceptance.cjs'])
      fs.copyFileSync(path.join(__dirname, file), path.join(scripts, file));
    for (const file of ['restart.cjs', 'switch.cjs'])
      fs.writeFileSync(path.join(scripts, file), '// verified controller');
    const policy = require(path.join(scripts, 'startup-acceptance.cjs'));
    const release = path.join(root, '.local-releases/A');
    fs.mkdirSync(release, { recursive: true });
    fs.writeFileSync(path.join(release, 'main.cjs'), 'verified');
    const manifest = {
      format: 1,
      platform: process.platform,
      arch: process.arch,
      ...fingerprint(release),
    };
    fs.writeFileSync(
      path.join(release, 'release.json'),
      JSON.stringify(manifest),
    );
    assert.equal(policy.accepted(release), false);
    verifyRelease(release);
    policy.recordAcceptance(release);
    assert.equal(policy.accepted(release), true);
    const other = path.join(root, '.local-releases/B');
    fs.cpSync(release, other, { recursive: true });
    assert.equal(policy.accepted(other), false);
    process.env.PRIVATE_ONLINE_MODE = '1';
    assert.equal(policy.accepted(release), false);
    process.env.PRIVATE_ONLINE_MODE = '0';
    assert.equal(policy.accepted(release), true);
    fs.appendFileSync(path.join(scripts, 'switch.cjs'), '// changed verifier');
    assert.equal(policy.accepted(release), false);
    policy.recordAcceptance(release);
    assert.equal(policy.accepted(release), true);
    fs.appendFileSync(path.join(release, 'release.json'), ' ');
    assert.equal(policy.accepted(release), false);
    // Acceptance never replaces byte authentication before any new execution.
    policy.recordAcceptance(release);
    fs.writeFileSync(path.join(release, 'main.cjs'), 'modified');
    assert.throws(() => verifyRelease(release));
    const receipts = path.join(root, '.local-releases/.startup-acceptance');
    for (const file of fs.readdirSync(receipts))
      fs.writeFileSync(path.join(receipts, file), '{broken');
    assert.equal(policy.accepted(release), false);
  } finally {
    if (previous === undefined) delete process.env.PRIVATE_ONLINE_MODE;
    else process.env.PRIVATE_ONLINE_MODE = previous;
    assert.equal(path.dirname(root), os.tmpdir());
    assert(path.basename(root).startsWith('wewe-acceptance-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('prepared/cold fixture flags cannot target production or restart paths', async () => {
  for (const flag of ['preparedRehearsal', 'coldLaunchRehearsal']) {
    await assert.rejects(
      controlledRestart({
        production: true,
        rehearsal: false,
        mode: 'start',
        [flag]: true,
      }),
      /require rehearsal/,
    );
    await assert.rejects(
      controlledRestart({
        production: false,
        rehearsal: true,
        mode: 'restart',
        [flag]: true,
      }),
      /only measure a cold start/,
    );
  }
});
