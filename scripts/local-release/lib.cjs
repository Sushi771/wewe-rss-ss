const nativeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const nativeProcesses = require('node:child_process');
const { AsyncLocalStorage } = require('node:async_hooks');

// Shared by source copies/aliases in this process, without a policy, filesystem
// write or dependency on a release-scope file in standalone packaged runtimes.
const contextKey = Symbol.for('wewe-rss.host-release-context.v1');
if (!Object.prototype.hasOwnProperty.call(globalThis, contextKey))
  Object.defineProperty(globalThis, contextKey, {
    value: new AsyncLocalStorage(),
  });
const hostContext = globalThis[contextKey];
function currentHostLease() {
  return hostContext.getStore();
}
function assertHostWrite() {
  currentHostLease()?.assertWritable();
}
function assertUnscopedHostEffect() {
  if (currentHostLease())
    throw new Error('RELEASE_SCOPE_UNREGISTERED_HOST_EFFECT');
}
const readOnlyFiles = new Set([
  'access',
  'close',
  'exists',
  'fstat',
  'glob',
  'lstat',
  'opendir',
  'read',
  'readFile',
  'readdir',
  'readlink',
  'readv',
  'realpath',
  'stat',
  'statfs',
  'createReadStream',
  'openAsBlob',
  'watch',
  'watchFile',
  'unwatchFile',
  'Dir',
  'Dirent',
  'Stats',
  'StatFs',
  'ReadStream',
]);
function writesOnOpen(flags = 'r') {
  if (typeof flags === 'string') return /[wa+]/.test(flags);
  if (typeof flags !== 'number') return true;
  return Boolean(
    flags &
    (nativeFs.constants.O_WRONLY |
      nativeFs.constants.O_RDWR |
      nativeFs.constants.O_APPEND |
      nativeFs.constants.O_CREAT |
      nativeFs.constants.O_TRUNC),
  );
}
function guardedFileHandle(handle) {
  const readOnly = new Set([
    'close',
    'read',
    'readv',
    'readFile',
    'stat',
    'readLines',
    'readableWebStream',
    'createReadStream',
    Symbol.asyncDispose,
  ]);
  return new Proxy(handle, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      return (...args) => {
        if (!readOnly.has(key)) assertHostWrite();
        return Reflect.apply(value, target, args);
      };
    },
  });
}
function guardedFiles(target, promises = false) {
  return new Proxy(target, {
    get(object, key) {
      if (key === 'promises') return guardedPromises;
      const value = Reflect.get(object, key, object);
      const method = typeof key === 'string' ? key.replace(/Sync$/, '') : '';
      if (typeof value !== 'function' || readOnlyFiles.has(method))
        return value;
      return function (...args) {
        if (method !== 'open' || writesOnOpen(args[1])) assertHostWrite();
        // Resolve dynamically so the existing offline preloader and test stubs
        // cannot be bypassed by an earlier captured native function.
        const result = new.target
          ? Reflect.construct(object[key], args)
          : Reflect.apply(object[key], object, args);
        return promises && method === 'open'
          ? result.then(guardedFileHandle)
          : result;
      };
    },
  });
}
const guardedPromises = guardedFiles(nativeFs.promises, true);
const fs = guardedFiles(nativeFs);
const processes = new Proxy(nativeProcesses, {
  get(target, key) {
    const value = Reflect.get(target, key, target);
    if (
      ![
        'exec',
        'execFile',
        'execFileSync',
        'execSync',
        'fork',
        'spawn',
        'spawnSync',
      ].includes(key)
    )
      return value;
    const dispatch = (...args) => {
      assertHostWrite();
      return Reflect.apply(target[key], target, args);
    };
    Object.defineProperty(dispatch, require('node:util').promisify.custom, {
      get() {
        const custom = target[key][require('node:util').promisify.custom];
        return (
          custom &&
          ((...args) => {
            assertHostWrite();
            return Reflect.apply(custom, target, args);
          })
        );
      },
    });
    return dispatch;
  },
});
const hostEffects = Object.freeze({
  context: hostContext,
  fs,
  processes,
  currentLease: currentHostLease,
  assertWritable: assertHostWrite,
  assertUnscoped: assertUnscopedHostEffect,
});

const slash = (value) => value.replace(/\\/g, '/');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const fileHash = (file) => {
  const digest = crypto.createHash('sha256'),
    buffer = Buffer.alloc(1024 * 1024);
  const descriptor = fs.openSync(file, 'r');
  try {
    let read;
    while ((read = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0)
      digest.update(buffer.subarray(0, read));
    return digest.digest('hex');
  } finally {
    fs.closeSync(descriptor);
  }
};
const writeJson = (file, value) => {
  assertHostWrite();
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
  reuseVerified = reuseVerified && !currentHostLease();
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
  reuseVerified = reuseVerified && !currentHostLease();
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
  return processes.execFileSync(command, args, {
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

module.exports = {
  hostEffects,
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
