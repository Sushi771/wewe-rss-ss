'use strict';

// Reuse the audited MIT SDK auth primitives, without installing/running its CLI.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { safePrivateRoot } = require('./probe-mobile-refresh-preflight.cjs');
const COMMIT = '88bd2e095d7d7ee423eaadf8f40653e72c5be6d4';
const SOURCES = {
  'src/auth/qrlogin.ts':
    'a223ef4c958ec40f9302d8fb01b62cfec0d9bfb3ea611ffeb52df7240ac22748',
  'src/profile.ts':
    'ff5b60e0e05488027eef917bd5847247006fe8a2ce2666b50d368f2f932f31da',
  'src/device-ua.ts':
    '11f18f70b1bdd515b31049a25703274774c1dd0d7ce32b5bd8155de0c23d6dfd',
  'src/api/response-body.ts':
    '85d70698a5a648f195f905ca7af14d186e8a59aeddc154b6ab8307f99e0acedc',
  'src/api/signal.ts':
    '34c0b3a1d8a1939f82403625b77f3ca10b99786957f4d502273752920108e387',
  'src/errors.ts':
    '896fcf607c8d1ab8b3468fe77d92835ee326eb78b2aa1294b090a7e5a2c9a4bb',
  LICENSE: '3acfdcec01b9b4700419ad10e64ea236e614afd4ad6e9901935276e938fbc6bc',
};
const hash = (data) => createHash('sha256').update(data).digest('hex');

function verifyCache(directory) {
  const root = safePrivateRoot(directory);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, 'sdk-manifest.json')),
  );
  if (
    manifest.commit !== COMMIT ||
    JSON.stringify(manifest.sources) !== JSON.stringify(SOURCES)
  )
    throw Error('sdk_manifest_gate');
  const outputs = [
    ...Object.keys(SOURCES).map((p) => p.replace(/\.ts$/, '.js')),
    'package.json',
  ];
  if (
    JSON.stringify(Object.keys(manifest.outputs).sort()) !==
    JSON.stringify(outputs.sort())
  )
    throw Error('sdk_output_gate');
  for (const file of outputs)
    if (hash(fs.readFileSync(path.join(root, file))) !== manifest.outputs[file])
      throw Error('sdk_integrity_gate');
  return root;
}

function prepare(sourceDirectory, cacheDirectory) {
  if (!path.isAbsolute(sourceDirectory) || !path.isAbsolute(cacheDirectory))
    throw Error('path_gate');
  const parent = safePrivateRoot(path.dirname(cacheDirectory));
  if (fs.existsSync(cacheDirectory)) throw Error('cache_exists');
  const source = fs.realpathSync(sourceDirectory);
  // Verify every source before compiling any of it. No dynamic discovery/imports.
  const inputs = Object.fromEntries(
    Object.keys(SOURCES).map((file) => [
      file,
      fs.readFileSync(path.join(source, file)),
    ]),
  );
  for (const file of Object.keys(SOURCES))
    if (hash(inputs[file]) !== SOURCES[file])
      throw Error('sdk_source_integrity_gate');
  const req = createRequire(
    path.resolve(__dirname, '../../apps/server/package.json'),
  );
  const ts = req('typescript');
  fs.mkdirSync(path.join(parent, path.basename(cacheDirectory)), {
    mode: 0o700,
  });
  const outputs = {};
  for (const [file, data] of Object.entries(inputs)) {
    const name = file.replace(/\.ts$/, '.js');
    const text = file.endsWith('.ts')
      ? ts.transpileModule(data.toString('utf8'), {
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
          },
        }).outputText
      : data;
    fs.mkdirSync(path.dirname(path.join(cacheDirectory, name)), {
      recursive: true,
      mode: 0o700,
    });
    fs.writeFileSync(path.join(cacheDirectory, name), text, {
      flag: 'wx',
      mode: 0o600,
    });
    outputs[name] = hash(text);
  }
  const packageText = '{"private":true,"type":"commonjs"}\n';
  fs.writeFileSync(path.join(cacheDirectory, 'package.json'), packageText, {
    flag: 'wx',
    mode: 0o600,
  });
  outputs['package.json'] = hash(packageText);
  fs.writeFileSync(
    path.join(cacheDirectory, 'sdk-manifest.json'),
    JSON.stringify({
      repository: 'https://github.com/teng-lin/weread-omni',
      commit: COMMIT,
      sources: SOURCES,
      outputs,
      typescriptVersion: ts.version,
    }),
    { flag: 'wx', mode: 0o600 },
  );
  return verifyCache(cacheDirectory);
}

if (require.main === module) {
  try {
    if (process.argv.length !== 4) throw Error('usage_gate');
    prepare(process.argv[2], process.argv[3]);
    console.log(
      JSON.stringify({ prepared: true, commit: COMMIT, networkRequests: 0 }),
    );
  } catch {
    console.log(JSON.stringify({ prepared: false }));
    process.exitCode = 1;
  }
}
module.exports = { prepare, verifyCache, COMMIT };
