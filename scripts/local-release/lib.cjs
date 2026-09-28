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
      const resolved = fs.realpathSync(target);
      if (!inside(directory, resolved))
        throw new Error(`产物链接指向目录外: ${relative}`);
      links[slash(relative)] = slash(path.relative(directory, resolved));
    }
  });
  return { files, links };
}

function verifyRelease(directory) {
  directory = fs.realpathSync(directory);
  const manifest = readJson(path.join(directory, 'release.json'));
  if (
    manifest.format !== 1 ||
    manifest.platform !== process.platform ||
    manifest.arch !== process.arch
  )
    throw new Error('产物平台或清单版本不匹配');
  const current = fingerprint(directory);
  for (const field of ['files', 'links']) {
    if (JSON.stringify(current[field]) !== JSON.stringify(manifest[field]))
      throw new Error(`产物完整性核验失败: ${field}`);
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
  cleanEnvironment,
  run,
};
