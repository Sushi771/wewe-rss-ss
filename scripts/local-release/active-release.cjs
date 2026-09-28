// The logon task reads this local pointer; only a verified production start may advance it.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { verifyRelease } = require('./lib.cjs');

const root = path.resolve(__dirname, '../..');
const releases = path.join(root, '.local-releases');
const pointer = path.join(releases, 'active.json');

function checkedRelease(candidate) {
  const release = fs.realpathSync(candidate);
  if (
    path.dirname(release).toLowerCase() !==
    fs.realpathSync(releases).toLowerCase()
  )
    throw new Error('当前产物必须位于本项目 .local-releases 的直接子目录');
  const manifest = verifyRelease(release);
  if (
    manifest.schemaCompatibility !== 'current' ||
    manifest.desktopHelperIncluded !== true
  )
    throw new Error('当前产物不兼容生产 schema 或缺少桌面 helper');
  if (manifest.id !== path.basename(release))
    throw new Error('产物目录与清单 ID 不一致');
  return { release, manifest };
}

function readActiveRelease() {
  const value = JSON.parse(fs.readFileSync(pointer, 'utf8'));
  if (value.format !== 1 || !/^[A-Za-z0-9T.Z-]+$/.test(value.id))
    throw new Error('开机产物指针格式无效');
  const result = checkedRelease(path.join(releases, value.id));
  if (result.manifest.id !== value.id)
    throw new Error('开机产物指针与清单不一致');
  return result;
}

function writeActiveRelease(candidate) {
  const { release, manifest } = checkedRelease(candidate);
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
  pointer,
};
