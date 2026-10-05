// The logon task reads this local pointer; only a verified production start may advance it.
const fs = require('node:fs');
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
  // Seed a validated receipt during activation, before the user's next launch.
  return storePointer(
    checkedRelease(candidate, {
      ...options,
      reuseVerified: true,
      runningOnly: false,
    }),
  );
}

async function writeActiveReleaseAsync(candidate, options) {
  const release = checkedDirectory(candidate);
  const manifest = await verifyReleaseAsync(release, {
    ...options,
    reuseVerified: true,
  });
  return storePointer(checkedManifest(release, manifest));
}

function storePointer({ release, manifest }) {
  const temporary = path.join(releases, `active-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(
      temporary,
      JSON.stringify({ format: 1, id: manifest.id }) + '\n',
      {
        flag: 'wx',
      },
    );
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
