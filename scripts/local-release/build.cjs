// 只创建新版本，不停服务、不改已安装的依赖、旧 dist/client 或数据库。
const fs = require('node:fs');
const path = require('node:path');
const { isBuiltin } = require('node:module');
const {
  slash,
  readJson,
  fileHash,
  hash,
  writeJson,
  packageDir,
  walk,
  fingerprint,
  cleanEnvironment,
  run,
} = require('./lib.cjs');
const root = path.resolve(__dirname, '../..');
const server = path.join(root, 'apps/server');

function copyPackages(destination, generatedClient) {
  const seen = new Map();
  const versions = [];
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
    const source = packageDir(name, base);
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
      if (isBuiltin(dependency)) continue;
      try {
        packageDir(dependency, source);
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
    readJson(path.join(server, 'package.json')).dependencies,
  ).sort()) {
    if (name === '@wewe-rss/shared') continue; // 源码与服务端一起编译，并改写为产物内相对路径。
    link(name, copy(name, server), destination);
  }
  return versions;
}

function build() {
  if (process.platform !== 'win32')
    throw new Error('此入口只验证 Windows 本机 SQLite 部署');
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
    if (!fs.existsSync(path.join(root, directory))) continue;
    walk(path.join(root, directory), (relative, kind) => {
      if (
        kind !== 'file' ||
        relative.includes('__pycache__') ||
        relative.endsWith('.pyc')
      )
        return;
      inputs[slash(path.join(directory, relative))] = fileHash(
        path.join(root, directory, relative),
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
    'tools/wechat-desktop-collector/collect.ps1',
  ])
    inputs[file] = fileHash(path.join(root, file));
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
    .readFileSync(path.join(server, 'prisma/schema.prisma'), 'utf8')
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
    '@server/*': [slash(path.join(server, 'src/*'))],
    '@wewe-rss/shared': [
      slash(path.join(root, 'packages/shared/src/index.ts')),
    ],
    '@prisma/client': [slash(client)],
  };
  const tsconfig = path.join(workspace, 'tsconfig.json');
  writeJson(tsconfig, {
    extends: slash(path.join(server, 'tsconfig.build.json')),
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
  run(process.execPath, [tsc, '-p', tsconfig], { cwd: server, env });
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
  const web = path.join(root, 'apps/web');
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
  fs.cpSync(path.join(server, 'prisma'), path.join(target, 'prisma'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(target, 'scripts'));
  for (const file of ['backup-sqlite.py', 'verify-preservation.py'])
    fs.copyFileSync(
      path.join(server, 'scripts', file),
      path.join(target, 'scripts', file),
    );
  fs.copyFileSync(
    path.join(server, 'package.json'),
    path.join(target, 'package.json'),
  );
  for (const file of [
    'lib.cjs',
    'runtime.cjs',
    'inspect-sqlite.py',
    'offline-guard.cjs',
  ])
    fs.copyFileSync(path.join(__dirname, file), path.join(release, file));
  fs.mkdirSync(path.join(release, 'runtime'));
  fs.copyFileSync(process.execPath, path.join(release, 'runtime/node.exe'));
  const dependencies = copyPackages(target, client);
  // 固定 helper 代码随应用发布；.paused 是跨版本共享的运行状态，绝不复制进产物。
  const helperDir = path.join(release, 'tools/wechat-desktop-collector');
  fs.mkdirSync(helperDir, { recursive: true });
  fs.copyFileSync(
    path.join(root, 'tools/wechat-desktop-collector/collect.ps1'),
    path.join(helperDir, 'collect.ps1'),
  );
  const manifest = {
    format: 1,
    id,
    createdAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    sourceHash,
    inputs,
    prisma: {
      clientVersion: readJson(path.join(installed, 'package.json')).version,
      cliVersion: readJson(
        path.join(packageDir('prisma', server), 'package.json'),
      ).version,
      engineSha256: fileHash(engine),
    },
    dependencies,
    desktopHelperIncluded: true,
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
    build();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { build, copyPackages };
