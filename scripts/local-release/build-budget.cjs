// One cumulative release root; never evict an existing package.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const budget = require('./space-budget.cjs');
const { packageDir } = require('./lib.cjs');
function bytes(root, dependencies = false) {
  let total = 0;
  if (!fs.existsSync(root)) return total;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (dependencies && entry.name === 'node_modules') continue;
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue; // Physical bytes counted at .store, not junction aliases.
    if (entry.isDirectory()) total += bytes(file, dependencies);
    else if (entry.isFile()) total += fs.statSync(file).size;
    else throw new Error('Unsupported build artifact: ' + file);
  }
  return total;
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
function begin(root, requestedBytes) {
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
  let release,
    identity,
    done = false;
  function check(additional = 0) {
    const disk = fs.statfsSync(root, { bigint: true });
    if (
      bytes(root) + additional > max ||
      Number(disk.bavail * disk.bsize) - additional < reserve
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
      if (release || path.dirname(directory) !== root)
        throw new Error('Invalid owned build directory');
      fs.mkdirSync(directory);
      release = directory;
      identity = fs.lstatSync(release, { bigint: true });
    },
    check,
    finish(error) {
      if (done) return;
      done = true;
      try {
        if (error && release) {
          const current = fs.lstatSync(release, { bigint: true });
          if (
            current.isSymbolicLink() ||
            current.dev !== identity.dev ||
            current.ino !== identity.ino ||
            current.birthtimeNs !== identity.birthtimeNs
          )
            throw new Error(
              'Build directory identity changed; preserve for review',
            );
          fs.rmSync(release, { recursive: true }); // Only this invocation's failed directory.
        }
      } finally {
        unlock();
      }
    },
  };
}
module.exports = { bytes, estimate, begin };
