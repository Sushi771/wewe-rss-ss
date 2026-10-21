// 校验展开的旧源码与固定 Git 提交逐文件一致；额外的 node_modules junction 不参与提交。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

// Exact Git blob bytes for apps/server/.env in the two reviewed source commits.
// This returns only a digest; it grants no general environment-file read.
const BUILD_ENVIRONMENT_SHA256 =
  'efdafcfb690eb12efe9a7fa2a8bcf0977b1d4d31f31096123ae42e21fe6e28d6';
function hashCommittedBuildEnvironment(sourceRoot, commit, expectedSha256) {
  if (
    ![
      '3a36428210f22ea1986f0a96a6066e7fdc9baf46',
      'f618e48f48ff0e3df1c646cb8a666a2461815732',
    ].includes(commit) ||
    expectedSha256 !== BUILD_ENVIRONMENT_SHA256
  )
    throw Error('BUILD_ENVIRONMENT_FIXTURE_BINDING_REQUIRED');
  const root = fs.realpathSync.native(sourceRoot),
    file = path.join(root, 'apps/server/.env');
  const before = fs.lstatSync(file, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size !== 444n ||
    fs.realpathSync.native(file) !== file
  )
    throw Error('BUILD_ENVIRONMENT_FIXTURE_CHANGED');
  const actual = crypto
    .createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex');
  const after = fs.lstatSync(file, { bigint: true });
  if (
    actual !== expectedSha256 ||
    ['dev', 'ino', 'birthtimeNs', 'size', 'mtimeNs', 'ctimeNs'].some(
      (key) => before[key] !== after[key],
    )
  )
    throw Error('BUILD_ENVIRONMENT_FIXTURE_CHANGED');
  return actual;
}

function verifySourceSnapshot(sourceRoot, commit, repository) {
  const tree = execFileSync(
    'git',
    ['ls-tree', '-r', '-z', '--full-tree', commit],
    {
      cwd: repository,
      encoding: 'buffer',
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  let verified = 0;
  const expectedFiles = new Set();
  for (const entry of tree.toString('utf8').split('\0').filter(Boolean)) {
    const match = entry.match(/^(\d+) blob ([0-9a-f]{40})\t(.+)$/s);
    if (!match || match[1] === '120000')
      throw new Error('旧源码含未支持的 Git 条目');
    const file = path.resolve(sourceRoot, match[3]);
    if (
      !file.startsWith(path.resolve(sourceRoot) + path.sep) ||
      !fs.statSync(file).isFile()
    )
      throw new Error('旧源码文件缺失或越界: ' + match[3]);
    const content = fs.readFileSync(file);
    const gitHash = (bytes) =>
      crypto
        .createHash('sha1')
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest('hex');
    if (gitHash(content) !== match[2]) {
      // Windows archive 展开后可能按仓库文本规则使用 CRLF；只接受这一种等价转换。
      const normalized = Buffer.from(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
          .decode(content)
          .replace(/\r\n/g, '\n'),
      );
      if (gitHash(normalized) !== match[2])
        throw new Error('旧源码与固定提交不符: ' + match[3]);
    }
    expectedFiles.add(match[3].replace(/\\/g, '/'));
    verified++;
  }
  if (verified === 0) throw new Error('固定提交没有源码文件');
  for (const directory of [
    'apps/server/src',
    'apps/server/prisma',
    'apps/web/src',
    'apps/web/public',
    'packages/shared/src',
  ]) {
    const visit = (folder) => {
      if (!fs.existsSync(folder)) return;
      for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
        const file = path.join(folder, item.name);
        if (item.isDirectory()) visit(file);
        else if (
          !item.isFile() ||
          !expectedFiles.has(
            path.relative(sourceRoot, file).replace(/\\/g, '/'),
          )
        )
          throw new Error('旧源码目录含提交外文件: ' + file);
      }
    };
    visit(path.join(sourceRoot, directory));
  }
  return verified;
}

if (require.main === module) {
  try {
    console.log(
      JSON.stringify({
        files: verifySourceSnapshot(
          process.argv[2],
          process.argv[3],
          process.argv[4],
        ),
      }),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { verifySourceSnapshot, hashCommittedBuildEnvironment };
