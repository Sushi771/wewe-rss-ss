const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { bundleServer } = require('./compact.cjs');
const { guardNativePath } = require('./runtime.cjs');
const {
  fileHash,
  fingerprint,
  verifyRelease,
  verifyRunningRelease,
  run,
} = require('./lib.cjs');

test('compact bundles render hbs, preserve reflected class identity and create a real ZIP with source dependencies disconnected', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-compact-'));
  const target = path.join(temporary, 'server');
  const compiled = path.join(target, 'dist/apps/server/src');
  const generated = path.join(target, 'node_modules/.store/generated-prisma');
  fs.mkdirSync(compiled, { recursive: true });
  fs.mkdirSync(generated, { recursive: true });
  fs.writeFileSync(
    path.join(generated, 'package.json'),
    JSON.stringify({ name: '@prisma/client', version: 'fixture' }),
  );
  fs.writeFileSync(path.join(generated, 'index.js'), 'exports.fixture = true;');
  fs.writeFileSync(
    path.join(compiled, 'main.js'),
    `
    require('reflect-metadata');
    const { PassThrough } = require('node:stream');
    const { ZipArchive } = require('archiver');
    const assert = require('node:assert/strict');
    class ReflectedService {}
    class ReflectedController {}
    Reflect.defineMetadata('design:paramtypes', [ReflectedService], ReflectedController);
    assert.equal(ReflectedController.name, 'ReflectedController');
    assert.equal(Reflect.getMetadata('design:paramtypes', ReflectedController)[0], ReflectedService);
    const zip = new ZipArchive();
    const stream = new PassThrough();
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => {
      const bytes = Buffer.concat(chunks);
      assert.equal(bytes.readUInt32LE(0), 0x04034b50);
      assert(bytes.includes(Buffer.from('article.html')));
      console.log('zip-ok');
    });
    zip.pipe(stream);
    zip.append('<html>offline</html>', {name:'article.html'});
    zip.finalize();
  `,
  );
  try {
    const root = path.resolve(__dirname, '../..');
    const built = bundleServer(
      target,
      path.join(root, 'apps/server'),
      path.join(root, 'apps/web'),
    );
    assert.equal(built.tool, 'esbuild');
    assert(built.inputFiles > 100);
    assert.match(
      fs.readFileSync(path.join(target, 'THIRD_PARTY_NOTICES.txt'), 'utf8'),
      /archiver@.*[\s\S]*MIT License/,
    );
    assert.equal(fs.existsSync(path.join(target, 'dist')), false);
    const env = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' };
    assert.match(
      run(process.execPath, [path.join(target, 'main.cjs')], {
        cwd: temporary,
        env,
      }),
      /zip-ok/,
    );
    const hbsScript = path.join(temporary, 'render.cjs');
    const template = path.join(temporary, 'index.hbs');
    fs.writeFileSync(template, '<p>{{title}}</p>');
    fs.writeFileSync(
      hbsScript,
      `require(${JSON.stringify(path.join(target, 'hbs.cjs'))}).__express(${JSON.stringify(template)}, {title:'offline & safe',settings:{views:${JSON.stringify(temporary)}}}, (error,html)=>{if(error)throw error;console.log(html)});`,
    );
    assert.match(
      run(process.execPath, [hbsScript], { cwd: temporary, env }),
      /<p>offline &amp; safe<\/p>/,
    );
  } finally {
    assert.equal(path.dirname(temporary), os.tmpdir());
    assert(path.basename(temporary).startsWith('wewe-compact-'));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('native loading rejects a changed or outside engine before dlopen', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-native-boundary-'));
  try {
    const release = path.join(root, 'release');
    fs.mkdirSync(release);
    const engine = path.join(release, 'engine.node');
    fs.writeFileSync(engine, 'verified');
    const manifest = { files: { 'engine.node': fileHash(engine) } };
    guardNativePath(release, manifest, engine);
    fs.writeFileSync(engine, 'modified');
    assert.throws(
      () => guardNativePath(release, manifest, engine),
      /escaped or changed/,
    );
    const outside = path.join(root, 'outside.node');
    fs.writeFileSync(outside, 'verified');
    assert.throws(
      () => guardNativePath(release, manifest, outside),
      /escaped or changed/,
    );
    const linked = path.join(release, 'linked.node');
    fs.symlinkSync(outside, linked);
    assert.throws(
      () => guardNativePath(release, manifest, linked),
      /escaped or changed/,
    );
  } finally {
    assert.equal(path.dirname(root), os.tmpdir());
    assert(path.basename(root).startsWith('wewe-native-boundary-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('compact full audit rejects extra code and same-size modified bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-compact-audit-'));
  try {
    const file = path.join(root, 'main.cjs');
    fs.writeFileSync(file, 'original');
    const manifest = {
      format: 1,
      platform: process.platform,
      arch: process.arch,
      executionLayout: 'compact-cjs-v1',
      ...fingerprint(root),
    };
    fs.writeFileSync(path.join(root, 'release.json'), JSON.stringify(manifest));
    verifyRelease(root);
    verifyRunningRelease(root);
    verifyRunningRelease(root);
    const previous = fs.statSync(file);
    fs.writeFileSync(file, 'modified');
    fs.utimesSync(file, previous.atime, previous.mtime);
    assert.throws(() => verifyRelease(root));
    assert.throws(() => verifyRunningRelease(root));
    fs.writeFileSync(file, 'original');
    fs.writeFileSync(path.join(root, 'extra.cjs'), 'extra');
    assert.throws(() => verifyRelease(root));
    assert.throws(() => verifyRunningRelease(root));
  } finally {
    assert.equal(path.dirname(root), os.tmpdir());
    assert(path.basename(root).startsWith('wewe-compact-audit-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
