const fs = require('node:fs');
const path = require('node:path');
const { packageDir, readJson, inside } = require('./lib.cjs');

// Compile TypeScript with the existing tsc step first: Nest's emitted decorator
// metadata is required. This packages its CommonJS output, not TypeScript.
function bundleServer(target, packageSource, builderSource) {
  const esbuildDirectory = packageDir(
    'esbuild',
    packageDir('vite', builderSource),
  );
  const esbuild = require(esbuildDirectory);
  const external = [
    '@prisma/client',
    'hbs',
    'uglify-js',
    '@nestjs/microservices',
    '@nestjs/websockets',
    'class-transformer/storage',
  ];
  const entries = {
    main: path.join(target, 'dist/apps/server/src/main.js'),
    hbs: require.resolve('hbs', { paths: [packageSource] }),
  };
  const inputs = new Set();
  const versions = new Map();
  const licenses = new Map();
  const recordPackage = (directory) => {
    const pkg = readJson(path.join(directory, 'package.json'));
    if (!pkg.name || !pkg.version) return;
    const key = pkg.name + '@' + pkg.version;
    versions.set(key, { name: pkg.name, version: pkg.version });
    if (licenses.has(key)) return;
    const notices = [
      `${key}\nDeclared license: ${JSON.stringify(pkg.license || 'not specified')}`,
    ];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (
        !entry.isFile() ||
        !/^(licen[cs]e|copying|notice)([.\-_]|$)/i.test(entry.name)
      )
        continue;
      const file = fs.realpathSync.native(path.join(directory, entry.name));
      if (!inside(fs.realpathSync.native(directory), file))
        throw new Error('Dependency notice escaped its package');
      notices.push(`${entry.name}\n${fs.readFileSync(file, 'utf8')}`);
    }
    licenses.set(key, notices.join('\n\n'));
  };
  for (const [name, entry] of Object.entries(entries)) {
    const result = esbuild.buildSync({
      entryPoints: [entry],
      outfile: path.join(target, name + '.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      keepNames: true,
      minify: true,
      nodePaths: [path.join(packageSource, 'node_modules')],
      external: external.filter((item) => name !== 'hbs' || item !== 'hbs'),
      metafile: true,
      logLevel: 'silent',
    });
    if (result.warnings.length)
      throw new Error('Compact bundle has unresolved build warnings');
    for (const file of Object.keys(result.metafile.inputs)) inputs.add(file);
  }
  // Retain dependency provenance even though runtime files are now embedded.
  for (const input of inputs) {
    let directory = path.dirname(path.resolve(input));
    while (directory !== path.dirname(directory)) {
      const manifest = path.join(directory, 'package.json');
      if (fs.existsSync(manifest)) {
        recordPackage(directory);
        break;
      }
      directory = path.dirname(directory);
    }
  }
  // Uglify's established Node loader reads its own source files at runtime.
  // Preserve that small package instead of rewriting its dynamic code loader.
  const uglify = packageDir(
    'uglify-js',
    packageDir('html-minifier', packageSource),
  );
  const uglifyPackage = readJson(path.join(uglify, 'package.json'));
  recordPackage(uglify);
  if (Object.keys(uglifyPackage.dependencies || {}).length)
    throw new Error('Compact uglify closure changed; review before packaging');
  fs.cpSync(uglify, path.join(target, 'node_modules/uglify-js'), {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (file) =>
      !path.relative(uglify, file).split(path.sep).includes('node_modules'),
  });
  const generated = path.join(target, 'node_modules/.store/generated-prisma');
  recordPackage(generated);
  fs.writeFileSync(
    path.join(target, 'THIRD_PARTY_NOTICES.txt'),
    [...licenses.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, text]) => text)
      .join('\n\n' + '='.repeat(72) + '\n\n'),
    { flag: 'wx' },
  );
  const linked = path.join(target, 'node_modules/@prisma/client');
  fs.mkdirSync(path.dirname(linked), { recursive: true });
  fs.symlinkSync(
    generated,
    linked,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const compiled = fs.realpathSync(path.join(target, 'dist'));
  if (!inside(fs.realpathSync(target), compiled))
    throw new Error('Compiled staging directory escaped the new package');
  fs.rmSync(compiled, { recursive: true });
  return {
    tool: 'esbuild',
    version: readJson(path.join(esbuildDirectory, 'package.json')).version,
    inputFiles: inputs.size,
    dependencies: [...versions.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
    external,
  };
}

module.exports = { bundleServer };
