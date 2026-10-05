const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');

const slash = (value) => value.replace(/\\/g, '/');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const fileHash = (file) => hash(fs.readFileSync(file));
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
};

function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return (
    relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  );
}

function packageDir(name, base) {
  const local = createRequire(path.join(base, 'package.json'));
  for (const directory of local.resolve.paths(name) || []) {
    const candidate = path.join(directory, name);
    if (fs.existsSync(path.join(candidate, 'package.json')))
      return fs.realpathSync(candidate);
  }
  throw new Error(`缺少本机依赖 ${name}`);
}

function walk(root, callback, relative = '') {
  for (const item of fs
    .readdirSync(path.join(root, relative), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const next = path.join(relative, item.name);
    if (item.isSymbolicLink()) callback(next, 'link');
    else if (item.isDirectory()) walk(root, callback, next);
    else if (item.isFile()) callback(next, 'file');
    else throw new Error(`不支持的产物文件: ${next}`);
  }
}

function fingerprint(directory) {
  const files = {},
    links = {};
  walk(directory, (relative, kind) => {
    if (relative === 'release.json') return;
    const target = path.join(directory, relative);
    if (kind === 'file') files[slash(relative)] = fileHash(target);
    else {
      const resolved = fs.realpathSync.native(target);
      if (!inside(directory, resolved))
        throw new Error(`产物链接指向目录外: ${relative}`);
      links[slash(relative)] = slash(path.relative(directory, resolved));
    }
  });
  return { files, links };
}

// A launch receipt reuses a successful byte audit only while every file/link and
// directory identity is unchanged. Deployment verification remains a full audit.
function releaseMetadata(directory) {
  const entries = {};
  function visit(relative) {
    const target = path.join(directory, relative);
    const stat = fs.lstatSync(target, { bigint: true });
    entries[slash(relative)] = [
      stat.dev,
      stat.ino,
      stat.mode,
      stat.size,
      stat.mtimeNs,
      stat.ctimeNs,
    ].map(String);
    if (stat.isSymbolicLink()) {
      const resolved = fs.realpathSync.native(target);
      if (!inside(directory, resolved))
        throw new Error('Release link escapes directory');
      entries[slash(relative)].push(slash(path.relative(directory, resolved)));
    } else if (stat.isDirectory()) {
      for (const name of fs.readdirSync(target).sort())
        visit(path.join(relative, name));
    } else if (!stat.isFile()) throw new Error('Unsupported release entry');
  }
  visit('');
  return entries;
}

function verifyRunningRelease(directory) {
  directory = fs.realpathSync(directory);
  const manifest = readJson(path.join(directory, 'release.json'));
  if (
    manifest.format !== 1 ||
    manifest.platform !== process.platform ||
    manifest.arch !== process.arch
  )
    throw new Error('Running release platform/format mismatch');
  // Use the established full-package receipt for the compact layout. Every
  // entry's identity, timestamps and canonical link still match before reuse;
  // a missing, changed or invalid receipt falls back to the strict byte audit.
  if (manifest.executionLayout === 'compact-cjs-v1')
    return verifyRelease(directory, { reuseVerified: true });
  for (const file of ['runtime.cjs', 'lib.cjs', 'runtime/node.exe']) {
    const target = path.join(directory, file);
    if (
      !inside(directory, fs.realpathSync(target)) ||
      fileHash(target) !== manifest.files[file]
    )
      throw new Error('Running release boot file integrity mismatch');
  }
  // Already loaded dependencies need no re-execution. The app and served assets
  // are small and must still match before the browser opens them.
  for (const folder of ['server/dist', 'server/client']) {
    const actual = fingerprint(path.join(directory, folder));
    for (const field of ['files', 'links']) {
      const expected = Object.fromEntries(
        Object.entries(manifest[field])
          .filter(([file]) => file.startsWith(folder + '/'))
          .map(([file, value]) => [file.slice(folder.length + 1), value]),
      );
      const sorted = (object) =>
        JSON.stringify(
          Object.entries(object).sort(([a], [b]) => a.localeCompare(b)),
        );
      if (sorted(actual[field]) !== sorted(expected))
        throw new Error('Running release app integrity mismatch');
    }
  }
  return manifest;
}

// Enumerate the same complete tree in stable order, then overlap up to eight
// file/link lstat requests through Node's existing I/O pool. Every identity/time/size and
// canonical link destination remains in the receipt; no directory is trusted
// merely because a Dirent said it was a directory during enumeration.
async function releaseMetadataAsync(directory) {
  const paths = [];
  function list(relative = '', kind = 'directory') {
    // Preserve the original pre-descent lstat check. A stale directory Dirent
    // must not let enumeration follow a replacement junction outside the tree.
    const stat = fs.lstatSync(path.join(directory, relative), { bigint: true });
    if (!stat.isDirectory())
      throw new Error('Release entry changed during enumeration');
    paths.push({ relative, kind, stat });
    for (const item of fs
      .readdirSync(path.join(directory, relative), { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const next = path.join(relative, item.name);
      if (item.isDirectory()) list(next);
      else if (item.isSymbolicLink())
        paths.push({ relative: next, kind: 'link' });
      else if (item.isFile()) paths.push({ relative: next, kind: 'file' });
      else throw new Error('Unsupported release entry');
    }
  }
  list();
  let cursor = 0;
  const rows = new Array(paths.length);
  await Promise.all(
    Array.from({ length: Math.min(8, paths.length) }, async () => {
      while (cursor < paths.length) {
        const index = cursor++;
        const { relative, kind, stat: directoryStat } = paths[index];
        const target = path.join(directory, relative);
        const stat =
          directoryStat || (await fs.promises.lstat(target, { bigint: true }));
        const actualKind = stat.isSymbolicLink()
          ? 'link'
          : stat.isDirectory()
            ? 'directory'
            : stat.isFile()
              ? 'file'
              : 'unsupported';
        if (actualKind !== kind)
          throw new Error('Release entry changed during enumeration');
        const values = [
          stat.dev,
          stat.ino,
          stat.mode,
          stat.size,
          stat.mtimeNs,
          stat.ctimeNs,
        ].map(String);
        if (kind === 'link') {
          const resolved = fs.realpathSync.native(target);
          if (!inside(directory, resolved))
            throw new Error('Release link escapes directory');
          values.push(slash(path.relative(directory, resolved)));
        }
        rows[index] = [slash(relative), values];
      }
    }),
  );
  return Object.fromEntries(rows);
}

function verificationContext(directory) {
  directory = fs.realpathSync(directory);
  const manifest = readJson(path.join(directory, 'release.json'));
  if (
    manifest.format !== 1 ||
    manifest.platform !== process.platform ||
    manifest.arch !== process.arch
  )
    throw new Error('产物平台或清单版本不匹配');
  const receipt = path.join(
    path.dirname(directory),
    '.verification-cache',
    hash(directory) + '.json',
  );
  const key = hash(
    fileHash(__filename) +
      fileHash(path.join(directory, 'release.json')) +
      directory,
  );
  return { directory, manifest, receipt, key };
}

// Only an unchanged successful receipt uses asynchronous metadata. Missing,
// altered or damaged receipts still run the original complete byte audit and
// its before/after metadata check before any package code may execute.
async function verifyReleaseAsync(directory, { reuseVerified = false } = {}) {
  if (!reuseVerified) return verifyRelease(directory);
  const context = verificationContext(directory);
  const metadata = await releaseMetadataAsync(context.directory);
  try {
    const cached = readJson(context.receipt);
    if (
      cached.format === 1 &&
      cached.key === context.key &&
      JSON.stringify(cached.metadata) === JSON.stringify(metadata)
    )
      return context.manifest;
  } catch {
    /* Preserve the full audit on cache miss. */
  }
  return verifyRelease(context.directory, { reuseVerified: true });
}

function verifyRelease(directory, { reuseVerified = false } = {}) {
  const context = verificationContext(directory);
  const { manifest, receipt, key } = context;
  directory = context.directory;
  let metadata;
  if (reuseVerified) {
    metadata = releaseMetadata(directory);
    try {
      const cached = readJson(receipt);
      if (
        cached.format === 1 &&
        cached.key === key &&
        JSON.stringify(cached.metadata) === JSON.stringify(metadata)
      )
        return manifest;
    } catch {
      /* A missing or damaged receipt requires a full byte audit. */
    }
  }
  const current = fingerprint(directory);
  for (const field of ['files', 'links']) {
    if (JSON.stringify(current[field]) !== JSON.stringify(manifest[field]))
      throw new Error(`产物完整性核验失败: ${field}`);
  }
  if (reuseVerified) {
    const after = releaseMetadata(directory);
    if (JSON.stringify(metadata) !== JSON.stringify(after))
      throw new Error('Release changed during verification');
    fs.mkdirSync(path.dirname(receipt), { recursive: true });
    const temporary = receipt + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(
        temporary,
        JSON.stringify({ format: 1, key, metadata: after }),
        { flag: 'wx' },
      );
      fs.renameSync(temporary, receipt);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  return manifest;
}

function cleanEnvironment(extra = {}) {
  const env = { ...process.env };
  // 构建、迁移、运行只能加载所核验的本地产物，不能继承任意注入/引擎覆盖。
  for (const key of Object.keys(env)) {
    if (/^(NODE_OPTIONS|NODE_PATH|PRISMA_.*|DATABASE_URL)$/i.test(key))
      delete env[key];
  }
  return {
    ...env,
    CHECKPOINT_DISABLE: '1',
    PRISMA_HIDE_UPDATE_MESSAGE: '1',
    ...extra,
  };
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

module.exports = {
  slash,
  readJson,
  fileHash,
  hash,
  writeJson,
  inside,
  packageDir,
  walk,
  fingerprint,
  verifyRelease,
  verifyReleaseAsync,
  verifyRunningRelease,
  releaseMetadata,
  releaseMetadataAsync,
  cleanEnvironment,
  run,
};
