// 只创建新版本，不停服务、不改已安装的依赖、旧 dist/client 或数据库。
const fs = require('./lib.cjs').hostEffects.fs;
const path = require('node:path');
const crypto = require('node:crypto');
const { parseArgs } = require('node:util');
const { verifySourceSnapshot } = require('./verify-source.cjs');
const { bundleServer } = require('./compact.cjs');
const { actualEngineCommit } = require('./engine-audit.cjs');
const buildBudget = require('./build-budget.cjs');
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
const SERVER_HELPERS = Object.freeze([
  'backup-sqlite.py',
  'backup-space-status.py',
  'sqlite-retention-plan.py',
  'periodic-lifecycle.py',
  'query-retention-resources.ps1',
  'sqlite-snapshot-guard.py',
  'article_history.py',
  'article_history_host.py',
  'article-history-browser.cjs',
  'article-history-runtime.cjs',
  'article-history-resources.ps1',
  'verify-preservation.py',
  'watch-wechat2rss-cache.py',
  'read-wechat2rss-cache.py',
]);
const RUNTIME_WRAPPERS = Object.freeze([
  'lib.cjs',
  'runtime.cjs',
  'engine-audit.cjs',
  'inspect-sqlite.py',
  'prepare-start.py',
  'startup-sqlite.cjs',
  'space-budget.cjs',
  'startup-audit.cjs',
  'offline-guard.cjs',
]);

function isolatedViteConfig(web, workspace) {
  let config = fs.readFileSync(path.join(web, 'vite.config.ts'), 'utf8');
  for (const anchor of [
    "import { defineConfig } from 'vite';",
    "import react from '@vitejs/plugin-react';",
    'export default defineConfig({',
    '__dirname',
  ])
    if (!config.includes(anchor))
      throw new Error('Unsupported isolated Vite configuration');
  // A native package resolver avoids bundling either installed CJS or ESM
  // dependency internals into the generated configuration's module format.
  config = config
    .replace(
      "import { defineConfig } from 'vite';",
      "const { defineConfig } = packageRequire('vite');",
    )
    .replace(
      "import react from '@vitejs/plugin-react';",
      "const react = packageRequire('@vitejs/plugin-react');",
    )
    .replaceAll('__dirname', JSON.stringify(slash(web)))
    .replace(
      'export default defineConfig({',
      `export default defineConfig({\n root: ${JSON.stringify(slash(web))},\n envDir: ${JSON.stringify(slash(workspace))},\n cacheDir: ${JSON.stringify(slash(path.join(workspace, '.vite')))},`,
    );
  return (
    `import { createRequire } from 'node:module';\nconst packageRequire = createRequire(${JSON.stringify(path.join(web, 'package.json'))});\n` +
    config
  );
}

function copyRuntimeClosure(sourceRoot, release, { legacy = false } = {}) {
  const helpers = legacy
    ? SERVER_HELPERS.filter(
        (name) =>
          ![
            'sqlite-snapshot-guard.py',
            'article_history.py',
            'article_history_host.py',
            'article-history-browser.cjs',
            'article-history-runtime.cjs',
            'article-history-resources.ps1',
          ].includes(name),
      )
    : SERVER_HELPERS;
  const entries = [
    ...helpers.map((name) => [
      `apps/server/scripts/${name}`,
      `server/scripts/${name}`,
    ]),
    ...RUNTIME_WRAPPERS.map((name) => [`scripts/local-release/${name}`, name]),
  ];
  const copied = {};
  for (const [source, destination] of entries) {
    const file = path.join(sourceRoot, source);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Invalid runtime source: ' + source);
    const bytes = Buffer.from(
      new TextDecoder('utf-8', { fatal: true })
        .decode(fs.readFileSync(file))
        .replace(/\r\n/g, '\n'),
    );
    const target = path.join(release, destination);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { flag: 'wx' });
    copied[destination] = { source, sha256: fileHash(target) };
  }
  return copied;
}

function copyPackages(
  destination,
  generatedClient,
  packageSource = server,
  checkpoint = () => {},
) {
  require('./lib.cjs').hostEffects.assertWritable();
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
    checkpoint();
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

// Validate tracked fixtures without parsing or passing their values to compilers.
function verifyBuildEnvironment(sourceRoot, commit, repository) {
  const result = [];
  for (const directory of [
    sourceRoot,
    path.join(sourceRoot, 'apps/server'),
    path.join(sourceRoot, 'apps/web'),
  ])
    for (const name of [
      '.env',
      '.env.local',
      '.env.production',
      '.env.production.local',
    ]) {
      const file = path.join(directory, name);
      if (!fs.existsSync(file)) continue;
      const relative = slash(path.relative(sourceRoot, file));
      try {
        const wanted = run('git', ['rev-parse', `${commit}:${relative}`], {
          cwd: repository,
        }).trim();
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink())
          throw new Error('environment link');
        const bytes = fs.readFileSync(file);
        const blob = (value) =>
          crypto
            .createHash('sha1')
            .update(`blob ${value.length}\0`)
            .update(value)
            .digest('hex');
        if (
          blob(bytes) !== wanted &&
          blob(Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'))) !==
            wanted
        )
          throw new Error('environment changed');
      } catch {
        throw new Error(
          'Build-only refuses private or changed build environment files',
        );
      }
      result.push(relative);
    }
  return result;
}

function build(options = {}) {
  require('./release-scope.cjs').assertWritableSession(['build']);
  if (options.plan && !options.buildOnly)
    throw new Error('--plan requires --build-only');
  if (!options.buildOnly && options.outputRoot)
    throw new Error('An output root requires --build-only');
  if (process.platform !== 'win32')
    throw new Error('此入口只验证 Windows 本机 SQLite 部署');
  const sourceRoot = options.sourceRoot
    ? fs.realpathSync(options.sourceRoot)
    : root;
  const historical = sourceRoot !== root;
  const legacy = historical && !options.searchRollback;
  if (
    options.searchRollback &&
    (!options.buildOnly ||
      !historical ||
      ![
        '48fdf73f4d770001bbb6de3e2383189811e56ccb',
        'f618e48f48ff0e3df1c646cb8a666a2461815732',
      ].includes(options.sourceCommit) ||
      !options.compact)
  )
    throw new Error(
      'Search rollback requires the fixed deployed source and compact runtime',
    );
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
  if (historical) verifySourceSnapshot(sourceRoot, options.sourceCommit, root);
  const sourceServer = path.join(sourceRoot, 'apps/server');
  const sourceWeb = path.join(sourceRoot, 'apps/web');
  if (options.buildOnly && !options.outputRoot)
    throw new Error('Build-only requires an explicit isolated output root');
  const committedEnvironmentFiles = options.buildOnly
    ? verifyBuildEnvironment(
        sourceRoot,
        historical ? options.sourceCommit : 'HEAD',
        root,
      )
    : [];
  if (historical && !options.buildOnly) {
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
    ...committedEnvironmentFiles,
  ])
    inputs[file] = fileHash(
      path.join(file.startsWith('tools/') ? root : sourceRoot, file),
    );
  if (legacy)
    inputs['tools/wechat-desktop-collector/collect.ps1'] = fileHash(
      path.join(sourceRoot, 'tools/wechat-desktop-collector/collect.ps1'),
    );
  const extensionNames = [
    '20261020100000_article_global_sort_index',
    '20261020160000_local_body_search',
  ];
  if (options.searchRollback)
    for (const name of extensionNames) {
      const file = `apps/server/prisma/migrations/${name}/migration.sql`;
      inputs[file] = fileHash(path.join(root, file));
    }
  let currentCommit = null;
  {
    currentCommit = run('git', ['rev-parse', 'HEAD'], { cwd: root }).trim();
    const tree = run(
      'git',
      ['ls-tree', '-r', '-z', '--full-tree', currentCommit],
      { cwd: root },
    );
    const blobs = new Map(
      tree
        .split('\0')
        .filter(Boolean)
        .map((row) => {
          const match = row.match(/^\d+ blob ([a-f0-9]{40})\t(.+)$/s);
          if (!match) throw new Error('Unsupported release source entry');
          return [match[2], match[1]];
        }),
    );
    const blobHash = (bytes) =>
      crypto
        .createHash('sha1')
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest('hex');
    for (const file of Object.keys(inputs)) {
      const tooling =
        file.startsWith('scripts/local-release/') ||
        (options.searchRollback &&
          extensionNames.some(
            (name) =>
              file === `apps/server/prisma/migrations/${name}/migration.sql`,
          ));
      if (historical && !tooling) continue; // Pinned snapshot was verified in full above.
      const content = fs.readFileSync(
        path.join(tooling ? root : sourceRoot, file),
      );
      const normalized = Buffer.from(
        content.toString('utf8').replace(/\r\n/g, '\n'),
      );
      if (
        !blobs.has(file) ||
        (blobHash(content) !== blobs.get(file) &&
          blobHash(normalized) !== blobs.get(file))
      )
        throw new Error('Release input differs from committed source: ' + file);
    }
  }
  const sourceHash = hash(
    JSON.stringify({ inputs, searchRollback: options.searchRollback === true }),
  );
  if (options.plan && !options.buildOnly)
    throw new Error('--plan requires --build-only');
  const releaseRoot = options.buildOnly
    ? fs.realpathSync.native(options.outputRoot)
    : path.join(root, '.local-releases');
  if (!options.buildOnly && options.outputRoot)
    throw new Error('An output root requires --build-only');
  const commands = options.buildOnly
    ? ['prisma', 'typescript', 'vite'].map((name, i) => {
        const file = path.join(
          packageDir(name, name === 'vite' ? sourceWeb : server),
          ['build/index.js', 'bin/tsc', 'bin/vite.js'][i],
        );
        return { path: file, sha256: fileHash(file) };
      })
    : [];
  if (options.plan) {
    const plan = {
      phase: 'build-only',
      buildOnly: {
        sourceCommit: historical ? options.sourceCommit : currentCommit,
        sourceHash,
        outputRoot: releaseRoot,
        runtimeSha256: fileHash(process.execPath),
        commands,
      },
      reserveBytes: buildBudget.estimate(sourceServer),
      runtimeCopies: 1,
    };
    console.log(JSON.stringify(plan));
    return plan;
  }
  const reusable = buildBudget.findReusable(releaseRoot, {
    sourceHash,
    sourceCommit: historical ? options.sourceCommit : currentCommit,
    nodeVersion: process.version,
    runtimeSha256: fileHash(process.execPath),
    schemaCompatibility: legacy ? 'legacy-additive' : 'current',
    executionLayout: options.compact ? 'compact-cjs-v1' : undefined,
  });
  const requestedBytes = reusable ? 1 : buildBudget.estimate(sourceServer);
  const shared = require('./release-scope.cjs').open(
    {
      kind: 'build',
      root: releaseRoot,
      reserveBytes: requestedBytes,
      runtimeCopies: reusable ? 0 : 1,
      buildOnly: options.buildOnly === true,
      sourceCommit: historical ? options.sourceCommit : currentCommit,
      sourceHash,
    },
    options.scopeOptions,
  );
  return require('./lib.cjs').hostEffects.context.run(shared, () => {
    let reservation;
    let failure;
    try {
      if (reusable) {
        console.log(
          JSON.stringify({
            release: reusable.directory,
            id: reusable.manifest.id,
            sourceHash,
            reused: true,
            sourceCommit: reusable.manifest.sourceCommit,
          }),
        );
        return reusable.directory;
      }
      const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${sourceHash.slice(0, 12)}`;
      const release = path.join(releaseRoot, id);
      reservation = buildBudget.begin(path.dirname(release), requestedBytes, {
        shared,
      });
      reservation.create(release);
      if (options.buildOnly)
        writeJson(path.join(release, 'package.json'), {
          name: 'wewe-isolated-release',
          version: '0.0.0',
          private: true,
        });
      const target = path.join(release, 'server');
      fs.mkdirSync(target);
      const workspace = path.join(release, 'build');
      fs.mkdirSync(workspace);
      if (options.buildOnly)
        writeJson(path.join(workspace, 'package.json'), {
          name: 'wewe-isolated-build',
          version: '0.0.0',
          private: true,
        });
      const temporary = path.join(workspace, 'tmp');
      fs.mkdirSync(temporary);
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
      let env = cleanEnvironment({
        NODE_ENV: 'production',
        PRISMA_GENERATE_SKIP_AUTOINSTALL: '1',
      });
      if (options.buildOnly)
        env = Object.fromEntries(
          Object.entries(env).filter(([key]) =>
            /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|NODE_ENV|CHECKPOINT_DISABLE|PRISMA_HIDE_UPDATE_MESSAGE|PRISMA_GENERATE_SKIP_AUTOINSTALL)$/i.test(
              key,
            ),
          ),
        );
      if (options.buildOnly)
        Object.assign(env, {
          TEMP: temporary,
          TMP: temporary,
          JITI_CACHE: 'false',
        });
      const cli = path.join(packageDir('prisma', server), 'build/index.js');
      fs.writeFileSync(
        path.join(workspace, 'generate.log'),
        run(
          process.execPath,
          [cli, 'generate', '--schema', path.join(workspace, 'schema.prisma')],
          {
            cwd: options.buildOnly ? workspace : server,
            env: { ...env, PRISMA_QUERY_ENGINE_LIBRARY: engine },
          },
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
      reservation.check();
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
      reservation.check();
      run(process.execPath, [tsc, '-p', webConfig, '--noEmit'], {
        cwd: web,
        env,
      });
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
        const isolatedConfig = path.join(workspace, 'vite.config.mts');
        if (options.buildOnly) {
          fs.writeFileSync(isolatedConfig, isolatedViteConfig(web, workspace));
        }
        fs.writeFileSync(
          path.join(workspace, 'web.log'),
          run(
            process.execPath,
            [
              path.join(packageDir('vite', web), 'bin/vite.js'),
              'build',
              ...(options.buildOnly ? ['--config', isolatedConfig] : []),
              '--outDir',
              path.join(target, 'client'),
            ],
            { cwd: web, env },
          ),
        );
      }
      reservation.check();
      fs.cpSync(
        path.join(sourceServer, 'prisma'),
        path.join(target, 'prisma'),
        {
          recursive: true,
        },
      );
      if (options.searchRollback) {
        for (const name of [
          '20261020100000_article_global_sort_index',
          '20261020160000_local_body_search',
        ])
          fs.cpSync(
            path.join(server, 'prisma/migrations', name),
            path.join(target, 'prisma/migrations', name),
            { recursive: true, errorOnExist: true, force: false },
          );
        writeJson(path.join(target, 'prisma/migrations/search-rollback.json'), {
          format: 1,
          baseSourceCommit: options.sourceCommit,
          optionalMigration: '20261020160000_local_body_search',
        });
      }
      if (legacy)
        fs.cpSync(
          path.join(server, 'prisma/migrations'),
          path.join(release, 'known-migrations'),
          { recursive: true },
        );
      // Current releases have one declared source tree. Historical rollback
      // remains an explicitly labelled composition with current safety tooling.
      const runtimeSources = copyRuntimeClosure(root, release, { legacy });
      fs.copyFileSync(
        path.join(sourceServer, 'package.json'),
        path.join(target, 'package.json'),
      );
      fs.mkdirSync(path.join(release, 'runtime'));
      reservation.check();
      fs.copyFileSync(process.execPath, path.join(release, 'runtime/node.exe'));
      let compact;
      const previousEnvironment = process.env;
      try {
        if (options.buildOnly) process.env = env;
        compact = options.compact
          ? bundleServer(target, sourceServer, sourceWeb)
          : undefined;
      } finally {
        process.env = previousEnvironment;
      }
      reservation.check();
      const dependencies = options.compact
        ? compact.dependencies
        : copyPackages(target, client, sourceServer, () => reservation.check());
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
        ...(options.buildOnly ? { buildStage: 'build-only' } : {}),
        sourceCommit: historical ? options.sourceCommit : currentCommit,
        toolingCommit: currentCommit,
        provenance: {
          format: 'declared-release-source-v1',
          composition: historical
            ? 'historical-app-current-tooling'
            : 'single-source',
          runtimeTextEncoding: 'utf8-crlf-to-lf-v1',
          runtimeSources,
          node: {
            version: process.version,
            sha256: fileHash(process.execPath),
          },
          buildTools: ['prisma', 'typescript', 'vite'].map((name) => {
            const directory = packageDir(
              name,
              name === 'vite' ? sourceWeb : server,
            );
            const entry = {
              prisma: 'build/index.js',
              typescript: 'bin/tsc',
              vite: 'bin/vite.js',
            }[name];
            return {
              name,
              version: readJson(path.join(directory, 'package.json')).version,
              entrySha256: fileHash(path.join(directory, entry)),
            };
          }),
          python: {
            bundled: false,
            configuration: 'SQLITE_BACKUP_PYTHON',
            bytecode: 'disabled',
          },
        },
        ...(options.searchRollback
          ? { rollbackCompatibility: 'search-additive-21-v1' }
          : {}),
        schemaCompatibility: legacy ? 'legacy-additive' : 'current',
        startupInspection: legacy ? 'full' : 'schema-only-v1',
        ...(compact
          ? {
              executionLayout: 'compact-cjs-v1',
              startupPreparation: 'node-background-backup-v1',
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
          engineCommit: actualEngineCommit(engine),
        },
        dependencies,
        desktopHelperIncluded: legacy,
        ...fingerprint(release),
      };
      reservation.check();
      writeJson(path.join(release, 'release.json'), manifest);
      reservation.check();
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
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      const cleanupErrors = [];
      try {
        reservation?.finish(failure);
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        shared.close(failure || cleanupErrors[0]);
      } catch (error) {
        cleanupErrors.push(error);
      }
      // Keep the first compiler/copy failure visible even if a later scope
      // deadline or preservation check also holds cleanup for review.
      if (cleanupErrors.length)
        throw new AggregateError(
          [...(failure ? [failure] : []), ...cleanupErrors],
          'Release build/cleanup failed',
          { cause: failure || cleanupErrors[0] },
        );
    }
  });
}

if (require.main === module) {
  try {
    const { values } = parseArgs({
      options: {
        'source-root': { type: 'string' },
        'source-commit': { type: 'string' },
        compact: { type: 'boolean', default: false },
        'build-only': { type: 'boolean', default: false },
        'output-root': { type: 'string' },
        'search-rollback': { type: 'boolean', default: false },
        plan: { type: 'boolean', default: false },
      },
    });
    build({
      sourceRoot: values['source-root'],
      sourceCommit: values['source-commit'],
      compact: values.compact,
      buildOnly: values['build-only'],
      outputRoot: values['output-root'],
      searchRollback: values['search-rollback'],
      plan: values.plan,
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = {
  build,
  copyPackages,
  verifyBuildEnvironment,
  copyRuntimeClosure,
  SERVER_HELPERS,
  RUNTIME_WRAPPERS,
  isolatedViteConfig,
};
