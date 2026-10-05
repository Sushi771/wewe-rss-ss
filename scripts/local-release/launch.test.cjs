const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  fingerprint,
  verifyRelease,
  verifyReleaseAsync,
  releaseMetadata,
  releaseMetadataAsync,
  verifyRunningRelease,
  run,
} = require('./lib.cjs');
const { installDesktop } = require('./install-desktop.cjs');
const { processIdentity } = require('./switch.cjs');
const net = require('node:net');

function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-launch-test-'));
  const release = path.join(parent, 'release');
  fs.mkdirSync(release);
  fs.writeFileSync(path.join(release, 'runtime.cjs'), 'trusted');
  for (const file of [
    'lib.cjs',
    'runtime/node.exe',
    'server/client/index.hbs',
    'server/dist/main.js',
  ]) {
    fs.mkdirSync(path.dirname(path.join(release, file)), { recursive: true });
    fs.writeFileSync(path.join(release, file), 'trusted');
  }
  fs.writeFileSync(
    path.join(release, 'release.json'),
    JSON.stringify({
      format: 1,
      platform: process.platform,
      arch: process.arch,
      ...fingerprint(release),
    }),
  );
  return { parent, release };
}
test(
  'WSH wrapper runs a fixture hidden in its own root and forwards --check',
  { skip: process.platform !== 'win32' },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-wsh-test-'));
    const folder = path.join(root, 'scripts/local-release');
    fs.mkdirSync(folder, { recursive: true });
    const entry = path.join(folder, 'launch-desktop.vbs');
    fs.copyFileSync(path.join(__dirname, 'launch-desktop.vbs'), entry);
    const programFiles = path.join(root, 'programfiles');
    fs.mkdirSync(programFiles);
    fs.symlinkSync(
      path.dirname(process.execPath),
      path.join(programFiles, 'nodejs'),
      'junction',
    );
    fs.writeFileSync(
      path.join(folder, 'desktop-start.cjs'),
      `require('node:fs').writeFileSync('result.json', JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));`,
    );
    try {
      run(
        path.join(process.env.SystemRoot, 'System32/cscript.exe'),
        ['//nologo', entry, '--check'],
        { env: { ...process.env, ProgramFiles: programFiles } },
      );
      const result = JSON.parse(
        fs.readFileSync(path.join(root, 'result.json')),
      );
      assert.equal(result.cwd.toLowerCase(), root.toLowerCase());
      assert.deepEqual(result.args, ['--check']);
    } finally {
      fs.rmSync(root, { recursive: true });
    }
  },
);
const cached = { reuseVerified: true };
test('asynchronous pointer activation preserves location, ID, schema and byte checks before atomic write', async () => {
  const {
    writeActiveReleaseAsync,
    readActiveRelease,
    pointer,
  } = require('./active-release.cjs');
  const previous = fs.existsSync(pointer)
    ? fs.readFileSync(pointer)
    : undefined;
  const { parent, release: source } = fixture();
  const release = path.join(
    path.dirname(pointer),
    `activation-test-${require('node:crypto').randomUUID()}`,
  );
  fs.mkdirSync(path.dirname(pointer), { recursive: true });
  fs.cpSync(source, release, { recursive: true });
  const file = path.join(release, 'release.json');
  const good = {
    ...JSON.parse(fs.readFileSync(file)),
    id: path.basename(release),
    schemaCompatibility: 'current',
    desktopHelperIncluded: false,
  };
  try {
    await assert.rejects(writeActiveReleaseAsync(source));
    fs.writeFileSync(file, JSON.stringify(good));
    await writeActiveReleaseAsync(release, { runningOnly: true });
    assert.equal(readActiveRelease().release, fs.realpathSync(release));
    const saved = fs.readFileSync(pointer);
    for (const change of [
      { id: 'mismatch' },
      { schemaCompatibility: 'legacy-additive' },
      { desktopHelperIncluded: undefined },
    ]) {
      fs.writeFileSync(file, JSON.stringify({ ...good, ...change }));
      await assert.rejects(writeActiveReleaseAsync(release));
      assert.deepEqual(fs.readFileSync(pointer), saved);
    }
    fs.writeFileSync(file, JSON.stringify(good));
    fs.writeFileSync(path.join(release, 'runtime.cjs'), 'altered');
    await assert.rejects(
      writeActiveReleaseAsync(release, { runningOnly: true }),
    );
    assert.deepEqual(fs.readFileSync(pointer), saved);
  } finally {
    if (previous) fs.writeFileSync(pointer, previous);
    else if (fs.existsSync(pointer)) fs.unlinkSync(pointer);
    fs.rmSync(release, { recursive: true });
    fs.rmSync(parent, { recursive: true });
  }
});

test('parallel metadata keeps exact ordered identities and bounds outstanding lstat requests', async () => {
  const { parent, release } = fixture();
  const original = fs.promises.lstat;
  let active = 0,
    peak = 0;
  try {
    for (let index = 0; index < 32; index++)
      fs.writeFileSync(path.join(release, `entry-${index}`), 'fixture');
    const expected = JSON.stringify(releaseMetadata(release));
    fs.promises.lstat = async (...args) => {
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        return await original(...args);
      } finally {
        active--;
      }
    };
    assert.equal(JSON.stringify(await releaseMetadataAsync(release)), expected);
    assert.ok(peak > 1 && peak <= 8);
  } finally {
    fs.promises.lstat = original;
    fs.rmSync(parent, { recursive: true });
  }
});

test('parallel traversal checks directory identity before following a stale Dirent', async () => {
  const { parent, release } = fixture();
  const original = fs.readdirSync;
  const switched = path.join(release, 'switch-dir');
  const outside = path.join(parent, 'outside');
  fs.mkdirSync(switched);
  fs.mkdirSync(outside);
  let followed = false,
    changed = false;
  try {
    fs.readdirSync = (directory, options) => {
      if (directory === switched) {
        followed = true;
        throw new Error('Unexpected junction traversal');
      }
      const result = original(directory, options);
      if (directory === release && !changed) {
        changed = true;
        fs.rmdirSync(switched);
        fs.symlinkSync(outside, switched, 'junction');
      }
      return result;
    };
    await assert.rejects(releaseMetadataAsync(release), /entry changed/);
    assert.equal(followed, false);
  } finally {
    fs.readdirSync = original;
    fs.rmSync(parent, { recursive: true });
  }
});

for (const change of ['same-size', 'extra', 'missing', 'manifest', 'escape']) {
  test(`asynchronous cached release refuses ${change} just like the full audit`, async () => {
    const { parent, release } = fixture();
    try {
      verifyRelease(release, cached);
      assert.deepEqual(
        await verifyReleaseAsync(release, cached),
        verifyRelease(release),
      );
      if (change === 'same-size') {
        const file = path.join(release, 'runtime.cjs');
        const stat = fs.statSync(file);
        fs.writeFileSync(file, 'altered');
        fs.utimesSync(file, stat.atime, stat.mtime);
      } else if (change === 'extra')
        fs.writeFileSync(path.join(release, 'unexpected.cjs'), 'extra');
      else if (change === 'missing')
        fs.unlinkSync(path.join(release, 'runtime.cjs'));
      else if (change === 'manifest') {
        const file = path.join(release, 'release.json');
        const manifest = JSON.parse(fs.readFileSync(file));
        manifest.files['runtime.cjs'] = 'changed';
        fs.writeFileSync(file, JSON.stringify(manifest));
      } else fs.symlinkSync(parent, path.join(release, 'escape'), 'junction');
      await assert.rejects(verifyReleaseAsync(release, cached));
    } finally {
      fs.rmSync(parent, { recursive: true });
    }
  });
}

test('asynchronous cache miss retains strict byte auditing and primes the normal receipt', async () => {
  const { parent, release } = fixture();
  try {
    assert.deepEqual(
      await verifyReleaseAsync(release, cached),
      verifyRelease(release),
    );
    const folder = path.join(parent, '.verification-cache');
    const receipt = path.join(folder, fs.readdirSync(folder)[0]);
    fs.writeFileSync(receipt, 'broken');
    await verifyReleaseAsync(release, cached);
    assert.equal(JSON.parse(fs.readFileSync(receipt)).format, 1);
    fs.writeFileSync(path.join(release, 'runtime.cjs'), 'altered');
    await assert.rejects(verifyReleaseAsync(release));
  } finally {
    fs.rmSync(parent, { recursive: true });
  }
});
for (const change of ['boot', 'app', 'asset', 'extra-asset']) {
  test(`live reuse refuses ${change} modification`, () => {
    const { parent, release } = fixture();
    try {
      assert.equal(verifyRunningRelease(release).format, 1);
      const file = {
        boot: 'lib.cjs',
        app: 'server/dist/main.js',
        asset: 'server/client/index.hbs',
        'extra-asset': 'server/client/extra.js',
      }[change];
      fs.writeFileSync(path.join(release, file), 'changed');
      assert.throws(() => verifyRunningRelease(release));
    } finally {
      fs.rmSync(parent, { recursive: true });
    }
  });
}
test('verified receipt reuses unchanged bytes; strict verification still hashes', () => {
  const { parent, release } = fixture();
  try {
    const manifest = verifyRelease(release, cached);
    assert.deepEqual(verifyRelease(release, cached), manifest);
    assert.deepEqual(verifyRelease(release), manifest);
    const cacheDir = path.join(parent, '.verification-cache');
    fs.writeFileSync(
      path.join(cacheDir, fs.readdirSync(cacheDir)[0]),
      '{broken',
    );
    assert.deepEqual(verifyRelease(release, cached), manifest);
  } finally {
    fs.rmSync(parent, { recursive: true });
  }
});
for (const change of ['same-size', 'extra', 'missing', 'manifest', 'escape']) {
  test(`cached release refuses ${change} after verification`, () => {
    const { parent, release } = fixture();
    try {
      verifyRelease(release, cached);
      const file = path.join(release, 'runtime.cjs');
      const stat = fs.statSync(file);
      if (change === 'same-size') {
        fs.writeFileSync(file, 'changed');
        fs.utimesSync(file, stat.atime, stat.mtime);
      } else if (change === 'extra')
        fs.writeFileSync(path.join(release, 'evil.cjs'), 'extra');
      else if (change === 'missing') fs.unlinkSync(file);
      else if (change === 'manifest') {
        const manifest = JSON.parse(
          fs.readFileSync(path.join(release, 'release.json')),
        );
        manifest.files['runtime.cjs'] = '0'.repeat(64);
        fs.writeFileSync(
          path.join(release, 'release.json'),
          JSON.stringify(manifest),
        );
      } else
        fs.symlinkSync(
          parent,
          path.join(release, 'escape'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      assert.throws(() => verifyRelease(release, cached));
    } finally {
      fs.rmSync(parent, { recursive: true });
    }
  });
}

test(
  'desktop installer refuses a temporary checkout on the real desktop',
  { skip: process.platform !== 'win32' },
  () => {
    assert.throws(
      () => installDesktop({ root: os.tmpdir() }),
      /stable checkout/,
    );
  },
);
test(
  'desktop shortcut is verified and cannot overwrite an unrelated shortcut',
  { skip: process.platform !== 'win32' },
  () => {
    const desktop = fs.mkdtempSync(
      path.join(os.tmpdir(), 'wewe-desktop-test-'),
    );
    try {
      const root = path.resolve(__dirname, '../..');
      assert.equal(
        installDesktop({ root, testDesktop: desktop }).verified,
        true,
      );
      assert.equal(
        installDesktop({ root, testDesktop: desktop }).verified,
        true,
      );
      fs.unlinkSync(path.join(desktop, 'WeWe-RSS.lnk'));
      fs.writeFileSync(path.join(desktop, 'WeWe-RSS.lnk'), 'unrelated');
      assert.throws(() => installDesktop({ root, testDesktop: desktop }));
      assert.equal(
        fs.readFileSync(path.join(desktop, 'WeWe-RSS.lnk'), 'utf8'),
        'unrelated',
      );
    } finally {
      fs.rmSync(desktop, { recursive: true });
    }
  },
);
test(
  'Discover returns a verified listener identity or null for a free port',
  { skip: process.platform !== 'win32' },
  async () => {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      assert.equal(
        processIdentity('Discover', undefined, port).pid,
        process.pid,
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    assert.equal(processIdentity('Discover', undefined, port), null);
  },
);
