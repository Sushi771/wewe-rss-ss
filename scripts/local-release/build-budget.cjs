// One cumulative release root; never evict an existing package.
const fs = require('./lib.cjs').hostEffects.fs;
const path = require('node:path');
const crypto = require('node:crypto');
const budget = require('./space-budget.cjs');
const {
  packageDir,
  fileHash,
  verifyRelease,
  releaseMetadata,
} = require('./lib.cjs');
const MAX_PACKAGES = 3;
const INFRASTRUCTURE = new Set([
  '.identity-tools',
  '.startup-acceptance',
  '.verification-cache',
  'worktrees',
]);
function packageDirectories(root) {
  if (!fs.existsSync(root)) return [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  if (entries.length > 4096) throw new Error('RELEASE_LAYOUT_REQUIRES_REVIEW');
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        !INFRASTRUCTURE.has(entry.name),
    )
    .map((entry) => path.join(root, entry.name))
    .sort();
}
function bytes(root, dependencies = false, ceiling = Number.MAX_SAFE_INTEGER) {
  let total = 0,
    entries = 0;
  const deadline = performance.now() + 10000;
  function visit(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (++entries > 100000 || performance.now() > deadline)
        throw new Error('RELEASE_USAGE_SCAN_LIMIT: inventory requires review');
      if (dependencies && entry.name === 'node_modules') continue;
      const file = path.join(directory, entry.name),
        stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) continue; // Count physical .store files, not junction aliases.
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) total += stat.size;
      else throw new Error('Unsupported build artifact: ' + file);
      if (total > ceiling) return;
    }
  }
  visit(root);
  return total;
}
function findReusable(root, key) {
  root = budget.canonical(root);
  const locked = () => {
    if (fs.existsSync(path.join(root, '.build-budget.lock')))
      throw new Error('Build budget is locked; review interrupted owner');
  };
  if (
    !/^[a-f0-9]{64}$/.test(key?.sourceHash) ||
    !/^[a-f0-9]{40}$/.test(key?.sourceCommit) ||
    !/^v\d+\.\d+\.\d+/.test(key?.nodeVersion) ||
    !/^[a-f0-9]{64}$/.test(key?.runtimeSha256) ||
    !['current', 'legacy-additive'].includes(key?.schemaCompatibility) ||
    ![undefined, 'compact-cjs-v1'].includes(key?.executionLayout)
  )
    throw new Error('Invalid release reuse key');
  locked();
  const directories = packageDirectories(root);
  if (directories.length > MAX_PACKAGES)
    throw new Error(
      'RELEASE_PACKAGE_LIMIT_EXCEEDED: review historical packages; nothing was deleted',
    );
  const matches = (m) =>
    m.format === 1 &&
    m.sourceHash === key.sourceHash &&
    m.sourceCommit === key.sourceCommit &&
    m.nodeVersion === key.nodeVersion &&
    m.schemaCompatibility === key.schemaCompatibility &&
    m.executionLayout === key.executionLayout &&
    m.files?.['runtime/node.exe'] === key.runtimeSha256;
  for (const directory of directories) {
    if (fs.realpathSync.native(directory) !== directory)
      throw new Error('RELEASE_LAYOUT_REQUIRES_REVIEW');
    const file = path.join(directory, 'release.json');
    if (!fs.existsSync(file)) continue;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 ** 2)
      throw new Error('RELEASE_MANIFEST_REQUIRES_REVIEW');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (manifest.id !== path.basename(directory))
      throw new Error('RELEASE_MANIFEST_REQUIRES_REVIEW');
    if (!matches(manifest)) continue;
    const before = JSON.stringify(releaseMetadata(directory)),
      sha = fileHash(file);
    const verified = verifyRelease(directory);
    if (
      !matches(verified) ||
      fileHash(file) !== sha ||
      JSON.stringify(releaseMetadata(directory)) !== before
    )
      throw new Error('Reusable release changed during verification');
    locked();
    return { directory, manifest: verified };
  }
  locked();
  return undefined;
}

function estimate(server, node = process.execPath) {
  const seen = new Set();
  let dependencies = 0;
  function visit(name, base) {
    const source = packageDir(name + '/', base);
    if (seen.has(source)) return;
    seen.add(source);
    dependencies += bytes(source, true);
    const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
    for (const dependency of Object.keys({
      ...pkg.peerDependencies,
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
    })) {
      try {
        packageDir(dependency + '/', source);
      } catch (error) {
        if (
          pkg.optionalDependencies?.[dependency] ||
          pkg.peerDependenciesMeta?.[dependency]?.optional
        )
          continue;
        throw error;
      }
      visit(dependency, source);
    }
  }
  for (const name of Object.keys(
    JSON.parse(fs.readFileSync(path.join(server, 'package.json'))).dependencies,
  )) {
    if (name !== '@wewe-rss/shared') visit(name, server);
  }
  // Full closure even for compact builds, plus generated client, compilation,
  // browser output and bounded subprocess log buffers. Final size is checked too.
  return dependencies * 2 + fs.statSync(node).size + 128 * 1024 ** 2;
}
function begin(root, requestedBytes, { packages = 1, shared } = {}) {
  require('./release-scope.cjs').assertWritableSession(['build', 'install']);
  shared?.assertWritable?.(['build', 'install']);
  root = budget.canonical(root);
  const max = Number(process.env.WEWE_RELEASE_MAX_BYTES || 768 * 1024 ** 2);
  const reserve = Number(
    process.env.WEWE_RELEASE_MIN_FREE_BYTES || 4 * 1024 ** 3,
  );
  if (
    ![max, reserve, requestedBytes].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  )
    throw new Error('Invalid release budget');
  if (!Number.isInteger(packages) || packages < 1 || packages > MAX_PACKAGES)
    throw new Error('Invalid release package reservation');
  fs.mkdirSync(root, { recursive: true });
  const lock = path.join(root, '.build-budget.lock');
  const owner = Buffer.from(
    JSON.stringify({ pid: process.pid, token: crypto.randomUUID() }),
  );
  try {
    fs.writeFileSync(lock, owner, { flag: 'wx' });
  } catch (error) {
    throw new Error('Build budget is locked; review interrupted owner', {
      cause: error,
    });
  }
  const unlock = () => {
    if (!fs.readFileSync(lock).equals(owner))
      throw new Error('Build lock ownership changed; preserve for review');
    fs.unlinkSync(lock);
  };
  const owned = [];
  let done = false;
  function check(additional = 0) {
    shared?.check();
    if (done || !Number.isSafeInteger(additional) || additional < 0)
      throw new Error('Invalid or completed release reservation');
    const existing = packageDirectories(root).length;
    if (existing + (additional > 0 ? packages : 0) > MAX_PACKAGES)
      throw new Error(
        'RELEASE_PACKAGE_LIMIT_EXCEEDED: review historical packages; nothing was deleted',
      );
    const disk = fs.statfsSync(root, { bigint: true });
    if (
      additional > max ||
      bytes(root, false, max - additional) + additional > max ||
      disk.bavail * disk.bsize - BigInt(additional) < BigInt(reserve)
    )
      throw new Error(
        'RELEASE_SPACE_BUDGET_EXCEEDED: review existing packages; nothing was deleted',
      );
  }

  try {
    check(requestedBytes);
  } catch (error) {
    unlock();
    throw error;
  }
  return {
    create(directory) {
      directory = path.resolve(directory);
      if (
        done ||
        owned.length >= packages ||
        path.dirname(directory) !== root ||
        INFRASTRUCTURE.has(path.basename(directory))
      )
        throw new Error('Invalid owned build directory');
      if (packageDirectories(root).length >= MAX_PACKAGES)
        throw new Error('RELEASE_PACKAGE_LIMIT_EXCEEDED');
      shared?.registerOutput(directory);
      fs.mkdirSync(directory);
      owned.push({
        directory,
        identity: fs.lstatSync(directory, { bigint: true }),
      });
      shared?.createdOutput(directory);
    },
    check,
    finish(error) {
      if (done) return;
      done = true;
      try {
        if (error) {
          shared?.allowCleanup(owned.map((row) => row.directory));
          // Validate the whole owned batch before removing any failed output.
          for (const { directory, identity } of owned) {
            const current = fs.lstatSync(directory, { bigint: true });
            if (
              current.isSymbolicLink() ||
              current.dev !== identity.dev ||
              current.ino !== identity.ino ||
              current.birthtimeNs !== identity.birthtimeNs
            )
              throw new Error(
                'Build directory identity changed; preserve for review',
              );
          }
          for (const { directory } of owned.reverse())
            fs.rmSync(directory, { recursive: true });
        }
      } finally {
        unlock();
      }
    },
  };
}
module.exports = {
  bytes,
  estimate,
  begin,
  findReusable,
  packageDirectories,
  MAX_PACKAGES,
};
