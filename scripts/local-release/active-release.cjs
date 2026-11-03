// The logon task reads this local pointer; only a verified production start may advance it.
const fs = require('./lib.cjs').hostEffects.fs;
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const {
  verifyRelease,
  verifyReleaseAsync,
  verifyRunningRelease,
} = require('./lib.cjs');

const root = path.resolve(__dirname, '../..');
const releases = path.join(root, '.local-releases');
const pointer = path.join(releases, 'active.json');

function checkedDirectory(candidate) {
  const release = fs.realpathSync(candidate);
  if (
    path.dirname(release).toLowerCase() !==
    fs.realpathSync(releases).toLowerCase()
  )
    throw new Error('当前产物必须位于本项目 .local-releases 的直接子目录');
  return release;
}

function checkedRelease(candidate, options) {
  const release = checkedDirectory(candidate);
  // Reusing a live, exactly matched runtime does not execute package code.
  // Its immutable boot files still must match the manifest; cold starts audit
  // the entire dependency closure before executing anything.
  const manifest = options?.runningOnly
    ? verifyRunningRelease(release)
    : verifyRelease(release, options);
  return checkedManifest(release, manifest);
}

function checkedManifest(release, manifest) {
  if (
    manifest.schemaCompatibility !== 'current' ||
    typeof manifest.desktopHelperIncluded !== 'boolean'
  )
    throw new Error('当前产物不兼容生产 schema 或缺少来源标识');
  if (manifest.id !== path.basename(release))
    throw new Error('产物目录与清单 ID 不一致');
  return { release, manifest };
}

function readActiveRelease(options) {
  const value = JSON.parse(fs.readFileSync(pointer, 'utf8'));
  if (value.format !== 1 || !/^[A-Za-z0-9T.Z-]+$/.test(value.id))
    throw new Error('开机产物指针格式无效');
  const result = checkedRelease(path.join(releases, value.id), options);
  if (result.manifest.id !== value.id)
    throw new Error('开机产物指针与清单不一致');
  return result;
}

function writeActiveRelease(candidate, options) {
  require('./release-scope.cjs').assertWritableSession(
    ['activate', 'restart', 'switch'],
    4096,
  );
  // Seed a validated receipt during activation, before the user's next launch.
  return storePointer(
    checkedRelease(candidate, {
      ...options,
      reuseVerified: !require('./release-scope.cjs').session(),
      runningOnly: false,
    }),
    options,
  );
}

async function writeActiveReleaseAsync(candidate, options) {
  require('./release-scope.cjs').assertWritableSession(
    ['activate', 'restart', 'switch'],
    4096,
  );
  const release = checkedDirectory(candidate);
  const manifest = await verifyReleaseAsync(release, {
    ...options,
    reuseVerified: !require('./release-scope.cjs').session(),
  });
  return storePointer(checkedManifest(release, manifest), options);
}

function storePointer({ release, manifest }, options = {}) {
  // All current publication paths share the retain-only update's publication
  // lock. Historical packages are never rewritten to acquire this cooperation.
  // Fixed administrative mutex beside the release root, not a package output.
  // Creating it inside a frozen inventory would invalidate that inventory.
  const lock = path.join(root, '.active-release.lock');
  const token = randomUUID();
  fs.writeFileSync(lock, token, { flag: 'wx', mode: 0o600 });
  try {
    return storePointerLocked({ release, manifest }, options);
  } finally {
    if (fs.readFileSync(lock, 'utf8') !== token)
      throw new Error('ACTIVE_RELEASE_LOCK_OWNER_CHANGED');
    fs.unlinkSync(lock);
  }
}

function storePointerLocked({ release, manifest }, options = {}) {
  const scope = require('./release-scope.cjs').session();
  const preserving = scope?.policy?.preservingUpdate;
  if (preserving) {
    const active = preserving.active;
    if (preserving.operation !== 'restart' || active.pointer !== pointer ||
        fs.realpathSync(pointer) !== pointer || fs.lstatSync(pointer).isSymbolicLink())
      throw new Error('RELEASE_PRESERVING_ACTIVE_BINDING_CHANGED');
    const currentHash = require('./lib.cjs').fileHash(pointer);
    const nextHash = require('node:crypto').createHash('sha256')
      .update(JSON.stringify({ format: 1, id: active.candidateId }) + '\n').digest('hex');
    if (options.recovery === true) {
      if (manifest.id !== active.currentId || ![active.pointerSha256, nextHash].includes(currentHash))
        throw new Error('RELEASE_PRESERVING_ACTIVE_BINDING_CHANGED');
    } else if (manifest.id !== active.candidateId || currentHash !== active.pointerSha256)
      throw new Error('RELEASE_PRESERVING_ACTIVE_BINDING_CHANGED');
  }
  if (scope) {
    if (options.recovery === true) scope.authorizeRecoveryPackage(release);
    else {
      scope.authorizePublication(release);
      scope.check(true);
    }
  }
  const temporary = path.join(releases, `active-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(
      temporary,
      JSON.stringify({ format: 1, id: manifest.id }) + '\n',
      {
        flag: 'wx',
      },
    );
    scope?.authorizePointerCommit?.(temporary, pointer, manifest.id, options.recovery === true);
    fs.renameSync(temporary, pointer);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return { release, id: manifest.id };
}

module.exports = {
  checkedRelease,
  readActiveRelease,
  writeActiveRelease,
  writeActiveReleaseAsync,
  pointer,
};
