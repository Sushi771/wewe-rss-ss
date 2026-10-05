// 只创建新版本，不停服务、不改已安装的依赖、旧 dist/client 或数据库。
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { verifySourceSnapshot } = require('./verify-source.cjs');
const { bundleServer } = require('./compact.cjs');
const {
  slash,
  readJson,
  fileHash,
  hash,
  writeJson,
  packageDir,
  walk,
  fingerprint,
  inside,
  cleanEnvironment,
  run,
} = require('./lib.cjs');
const root = path.resolve(__dirname, '../..');
const server = path.join(root, 'apps/server');

function copyPackages(destination, generatedClient, packageSource = server) {
  const seen = new Map();
  const versions = [];
  // resolve.paths('buffer') returns null for Node core names. A trailing slash
  // explicitly asks for the installed npm package and retains the real pnpm tree.
  const installedPackage = (name, base) => packageDir(name + '/', base);
  function link(name, target, parent) {
    const at = path.join(parent, 'node_modules', name);
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.symlinkSync(
      target,
      at,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
  function copy(name, base) {
    if (name === '@prisma/client') return generatedClient;
    const source = installedPackage(name, base);
    if (seen.has(source)) return seen.get(source);
    const pkg = readJson(path.join(source, 'package.json'));
    const target = path.join(
      destination,
      'node_modules/.store',
      `${pkg.name.replace(/[^a-zA-Z0-9_.-]/g, '_')}-${pkg.version}-${hash(source).slice(0, 8)}`,
    );
    seen.set(source, target);
    fs.cpSync(source, target, {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: (file) =>
        !path.relative(source, file).split(path.sep).includes('node_modules'),
    });
    versions.push({ name: pkg.name, version: pkg.version });
    const dependencies = {
      ...pkg.peerDependencies,
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
    };
    for (const dependency of Object.keys(dependencies).sort()) {
      // A package.json dependency names an installed npm package, even when
      // its name also matches a Node core module. Shims such as process,
      // buffer and string_decoder are required through trailing-slash paths
      // by readable-stream; skipping them breaks the isolated release.
      try {
        installedPackage(dependency, source);
      } catch (error) {
        if (
          pkg.optionalDependencies?.[dependency] ||
          pkg.peerDependenciesMeta?.[dependency]?.optional
        )
          continue;
        throw error;
      }
      // peer 依赖按实际安装树固定，不下载或选择不同版本。
      link(dependency, copy(dependency, source), target);
    }
    return target;
  }
  for (const name of Object.keys(
    readJson(path.join(packageSource, 'package.json')).dependencies,
  ).sort()) {
    if (name === '@wewe-rss/shared') continue; // 源码与服务端一起编译，并改写为产物内相对路径。
    link(name, copy(name, packageSource), destination);
  }
  return versions;
}

function build(options = {}) {
  if (process.platform !== 'win32')
    throw new Error('此入口只验证 Windows 本机 SQLite 部署');
  const sourceRoot = options.sourceRoot
    ? fs.realpathSync(options.sourceRoot)
    : root;
  const legacy = sourceRoot !== root;
  if (legacy && options.compact)
    throw new Error('Compact packages only support the current schema');
  if (options.compact && Number(process.versions.node.split('.')[0]) < 24)
    throw new Error(
      'Compact startup SQLite checks require the fixed Node 24 runtime',
    );
  if (legacy && !inside(path.join(root, '.local-releases'), sourceRoot))
    throw new Error('旧版源码快照必须位于本项目忽略的 .local-releases 目录');
  if (
    legacy &&
    options.sourceCommit !== '9755d166e398f77baf52317f63ef36024037881d'
  )
    throw new Error('旧版源码必须显式固定为已知可连接旧 schema 的提交');
  if (legacy) verifySourceSnapshot(sourceRoot, options.sourceCommit, root);
  const sourceServer = path.join(sourceRoot, 'apps/server');
  const sourceWeb = path.join(sourceRoot, 'apps/web');
  if (legacy) {
    // 旧源码留在忽略目录，只借用已安装依赖；不覆盖运行中的 dist、Client 或 DLL。
    for (const [local, installed] of [
      [path.join(sourceRoot, 'node_modules'), path.join(root, 'node_modules')],
      [
        path.join(sourceServer, 'node_modules'),
        path.join(server, 'node_modules'),
      ],
      [
        path.join(sourceWeb, 'node_modules'),
        path.join(root, 'apps/web/node_modules'),
      ],
      [
        path.join(sourceRoot, 'packages/shared/node_modules'),
        path.join(root, 'packages/shared/node_modules'),
      ],
    ]) {
      if (!fs.existsSync(local))
        fs.symlinkSync(
          installed,
          local,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      if (fs.realpathSync(local) !== fs.realpathSync(installed))
        throw new Error('旧源码依赖链接不指向本项目已安装依赖');
    }
  }
  const inputs = {};
  for (const directory of [
    'apps/server/src',
    'apps/server/prisma',
    'apps/server/scripts',
    'apps/web/src',
    'apps/web/public',
    'packages/shared/src',
    'scripts/local-release',
  ]) {
    const base = directory === 'scripts/local-release' ? root : sourceRoot;
    if (!fs.existsSync(path.join(base, directory))) continue;
    walk(path.join(base, directory), (relative, kind) => {
      if (
        kind !== 'file' ||
        relative.includes('__pycache__') ||
        relative.endsWith('.pyc')
      )
        return;
      inputs[slash(path.join(directory, relative))] = fileHash(
        path.join(base, directory, relative),
      );
    });
  }
  for (const file of [
    'package.json',
    'pnpm-lock.yaml',
    'tsconfig.base.json',
    'apps/server/package.json',
    'apps/server/tsconfig.json',
    'apps/server/tsconfig.build.json',
    'apps/web/package.json',
    'apps/web/index.html',
    'apps/web/tsconfig.json',
    'apps/web/vite.config.ts',
    'apps/web/tailwind.config.ts',
    'apps/web/postcss.config.js',
  ])
    inputs[file] = fileHash(
      path.join(file.startsWith('tools/') ? root : sourceRoot, file),
    );
  if (legacy)
    inputs['tools/wechat-desktop-collector/collect.ps1'] = fileHash(
      path.join(sourceRoot, 'tools/wechat-desktop-collector/collect.ps1'),
    );
  const sourceHash = hash(JSON.stringify(inputs));
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${sourceHash.slice(0, 12)}`;
  const release = path.join(root, '.local-releases', id);
  fs.mkdirSync(release, { recursive: false });
  const target = path.join(release, 'server');
  fs.mkdirSync(target);
  const workspace = path.join(release, 'build');
  fs.mkdirSync(workspace);
  const client = path.join(target, 'node_modules/.store/generated-prisma');
  const installed = packageDir('@prisma/client', server);
  const originalClient = path.dirname(
    require.resolve('.prisma/client', { paths: [installed] }),
  );
  const engine = path.join(originalClient, 'query_engine-windows.dll.node');
  const schema = fs
    .readFileSync(path.join(sourceServer, 'prisma/schema.prisma'), 'utf8')
    .replace(
      'provider      = "prisma-client-js"',
      `provider = "node ${slash(path.join(installed, 'generator-build/index.js'))}"\n  output = "${slash(client)}"`,
    )
    .replace(
      'binaryTargets = ["native", "linux-musl"]',
      'binaryTargets = ["native"]',
    );
  fs.writeFileSync(path.join(workspace, 'schema.prisma'), schema);
  const env = cleanEnvironment({
    NODE_ENV: 'production',
    PRISMA_GENERATE_SKIP_AUTOINSTALL: '1',
  });
  const cli = path.join(packageDir('prisma', server), 'build/index.js');
  fs.writeFileSync(
    path.join(workspace, 'generate.log'),
    run(
      process.execPath,
      [cli, 'generate', '--schema', path.join(workspace, 'schema.prisma')],
      { cwd: server, env: { ...env, PRISMA_QUERY_ENGINE_LIBRARY: engine } },
    ),
  );
  if (
    fileHash(path.join(client, 'query_engine-windows.dll.node')) !==
    fileHash(engine)
  )
    throw new Error('生成的 Prisma 引擎与现有 Client 不匹配');
  const paths = {
    '@server/*': [slash(path.join(sourceServer, 'src/*'))],
    '@wewe-rss/shared': [
      slash(path.join(sourceRoot, 'packages/shared/src/index.ts')),
    ],
    '@prisma/client': [slash(client)],
  };
  const tsconfig = path.join(workspace, 'tsconfig.json');
  writeJson(tsconfig, {
    extends: slash(path.join(sourceServer, 'tsconfig.build.json')),
    compilerOptions: {
      paths,
      typeRoots: [slash(path.join(server, 'node_modules/@types'))],
      incremental: false,
      sourceMap: false,
      declaration: false,
      outDir: slash(path.join(target, 'dist')),
    },
  });
  const tsc = path.join(packageDir('typescript', server), 'bin/tsc');
  run(process.execPath, [tsc, '-p', tsconfig], { cwd: sourceServer, env });
  const compiledRoot = path.join(target, 'dist/apps/server/src');
  walk(path.join(target, 'dist'), (relative, kind) => {
    if (kind !== 'file' || !relative.endsWith('.js')) return;
    const file = path.join(target, 'dist', relative);
    const rewritten = fs
      .readFileSync(file, 'utf8')
      .replace(
        /require\(["'](@server\/[^"']+|@wewe-rss\/shared)["']\)/g,
        (_, name) => {
          const resolved =
            name === '@wewe-rss/shared'
              ? path.join(target, 'dist/packages/shared/src/index')
              : path.join(compiledRoot, name.slice('@server/'.length));
          let local = slash(path.relative(path.dirname(file), resolved));
          if (!local.startsWith('.')) local = './' + local;
          if (!fs.existsSync(resolved + '.js'))
            throw new Error(`编译别名未找到: ${name}`);
          return `require(${JSON.stringify(local)})`;
        },
      );
    fs.writeFileSync(file, rewritten);
  });
  const web = sourceWeb;
  const webConfig = path.join(workspace, 'tsconfig.web.json');
  writeJson(webConfig, {
    extends: slash(path.join(web, 'tsconfig.json')),
    compilerOptions: {
      paths: { ...paths, '@web/*': [slash(path.join(web, 'src/*'))] },
      typeRoots: [
        slash(path.join(web, 'node_modules/@types')),
        slash(path.join(server, 'node_modules/@types')),
      ],
      incremental: false,
    },
  });
  run(process.execPath, [tsc, '-p', webConfig, '--noEmit'], { cwd: web, env });
  if (legacy) {
    fs.writeFileSync(
      path.join(workspace, 'web.log'),
      run(
        process.execPath,
        [
          path.join(__dirname, 'build-legacy-web.cjs'),
          sourceWeb,
          path.join(target, 'client'),
        ],
        { cwd: root, env },
      ),
    );
  } else {
    fs.writeFileSync(
      path.join(workspace, 'web.log'),
      run(
        process.execPath,
        [
          path.join(packageDir('vite', web), 'bin/vite.js'),
          'build',
          '--outDir',
          path.join(target, 'client'),
        ],
        { cwd: web, env },
      ),
    );
  }
  fs.cpSync(path.join(sourceServer, 'prisma'), path.join(target, 'prisma'), {
    recursive: true,
  });
  if (legacy)
    fs.cpSync(
      path.join(server, 'prisma/migrations'),
      path.join(release, 'known-migrations'),
      { recursive: true },
    );
  fs.mkdirSync(path.join(target, 'scripts'));
  for (const file of ['backup-sqlite.py', 'verify-preservation.py'])
    fs.copyFileSync(
      path.join(server, 'scripts', file),
      path.join(target, 'scripts', file),
    );
  fs.copyFileSync(
    path.join(sourceServer, 'package.json'),
    path.join(target, 'package.json'),
  );
  for (const file of [
    'lib.cjs',
    'runtime.cjs',
    'inspect-sqlite.py',
    'prepare-start.py',
    'startup-sqlite.cjs',
    'offline-guard.cjs',
  ])
    fs.copyFileSync(path.join(__dirname, file), path.join(release, file));
  fs.mkdirSync(path.join(release, 'runtime'));
  fs.copyFileSync(process.execPath, path.join(release, 'runtime/node.exe'));
  const compact = options.compact
    ? bundleServer(target, sourceServer, sourceWeb)
    : undefined;
  const dependencies = options.compact
    ? compact.dependencies
    : copyPackages(target, client, sourceServer);
  // Historical rollback packages retain their own helper. Current packages
  // contain no desktop collector code or executable.
  if (legacy) {
    const helperDir = path.join(release, 'tools/wechat-desktop-collector');
    fs.mkdirSync(helperDir, { recursive: true });
    fs.copyFileSync(
      path.join(sourceRoot, 'tools/wechat-desktop-collector/collect.ps1'),
      path.join(helperDir, 'collect.ps1'),
    );
  }
  const manifest = {
    format: 1,
    id,
    createdAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    sourceHash,
    sourceCommit: legacy ? options.sourceCommit : null,
    schemaCompatibility: legacy ? 'legacy-additive' : 'current',
    startupInspection: legacy ? 'full' : 'schema-only-v1',
    ...(compact
      ? {
          executionLayout: 'compact-cjs-v1',
          startupPreparation: 'node-pinned-backup-v1',
          compact,
        }
      : {}),
    inputs,
    prisma: {
      clientVersion: readJson(path.join(installed, 'package.json')).version,
      cliVersion: readJson(
        path.join(packageDir('prisma', server), 'package.json'),
      ).version,
      engineSha256: fileHash(engine),
    },
    dependencies,
    desktopHelperIncluded: legacy,
    ...fingerprint(release),
  };
  writeJson(path.join(release, 'release.json'), manifest);
  console.log(
    JSON.stringify({
      release,
      id,
      sourceHash,
      dependencies: dependencies.length,
      files: Object.keys(manifest.files).length,
    }),
  );
  return release;
}

if (require.main === module) {
  try {
    fs.mkdirSync(path.join(root, '.local-releases'), { recursive: true });
    const { values } = parseArgs({
      options: {
        'source-root': { type: 'string' },
        'source-commit': { type: 'string' },
        compact: { type: 'boolean', default: false },
      },
    });
    build({
      sourceRoot: values['source-root'],
      sourceCommit: values['source-commit'],
      compact: values.compact,
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { build, copyPackages };
