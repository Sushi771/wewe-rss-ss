'use strict';
// Generate a schema-matched test client into this candidate only, offline.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const server = fs.realpathSync(path.resolve(__dirname, '../..'));
const root = path.join(server, '.redbook-isolated');
if (!fs.existsSync(root)) fs.mkdirSync(root);
if (fs.lstatSync(root).isSymbolicLink() || fs.realpathSync(root) !== root)
  throw Error('ISOLATED_ROOT_INVALID');
const run = fs.realpathSync(fs.mkdtempSync(path.join(root, 'run-')));
if (path.dirname(run) !== root || !path.basename(run).startsWith('run-'))
  throw Error('ISOLATED_ROOT_INVALID');
const schemaPath = path.join(run, 'schema.prisma');
const input = fs.readFileSync(path.join(server, 'prisma/schema.prisma'), 'utf8');
const schema = input.replace(/generator client\s*\{[^}]*\}/, 'generator client {\n  provider = "prisma-client-js"\n  output = "./prisma-client"\n  binaryTargets = ["native"]\n}');
if (schema === input) throw Error('GENERATOR_NOT_FOUND');
fs.writeFileSync(schemaPath, schema, { flag: 'wx' });
const config = {
  extends: '../../tsconfig.json',
  compilerOptions: { noEmit: true, paths: {
    '@server/*': ['./src/*'],
    '@wewe-rss/shared': ['../../packages/shared/src/index'],
    '@prisma/client': [path.join(run, 'prisma-client')],
  } },
  exclude: [path.join(server, 'node_modules'), path.join(server, 'dist'), path.join(server, 'test'), path.join(server, 'src/**/*.spec.ts')],
};
fs.writeFileSync(path.join(run, 'tsconfig.redbook.json'), JSON.stringify(config, null, 2), { flag: 'wx' });
const env = Object.fromEntries(['SystemRoot', 'TEMP', 'TMP', 'PATH'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
Object.assign(env, {
  DATABASE_URL: 'file:' + path.join(run, 'synthetic-unused.sqlite').replace(/\\/g, '/'),
  PRISMA_GENERATE_SKIP_AUTOINSTALL: 'true',
  NODE_OPTIONS: '--require="' + path.join(__dirname, 'network-guard.cjs').replace(/\\/g, '/') + '"',
});
const result = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'generate', '--schema', schemaPath], { cwd: run, env, encoding: 'utf8', timeout: 120000 });
if (result.status !== 0) throw Error('ISOLATED_PRISMA_GENERATE_FAILED: ' + (result.stderr || '').slice(-1000));
fs.writeFileSync(path.join(run, 'fixture-owner.json'), JSON.stringify({ server, run }), { flag: 'wx' });
console.log(JSON.stringify({ run, tsconfig: path.join(run, 'tsconfig.redbook.json') }));
