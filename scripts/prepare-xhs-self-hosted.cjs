#!/usr/bin/env node
// Local preparation only. Never runs vendor code, Docker or an upstream request.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const folder = path.join(root, '.xhs-self-hosted');
const configFile = path.join(folder, '.env.local');
const args = process.argv.slice(2);
const codes = new Set([
  'XHS_PREPARATION_ARGUMENT_INVALID',
  'XHS_PREPARATION_PATH_INVALID',
  'XHS_PREPARATION_CONFIG_MISSING',
  'XHS_PREPARATION_CONFIG_READ_FAILED',
  'SERVER_BUILD_REQUIRED',
]);

function directory(target) {
  if (fs.existsSync(target)) {
    const info = fs.lstatSync(target);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('XHS_PREPARATION_PATH_INVALID');
    return;
  }
  fs.mkdirSync(target);
}

function main() {
  if (args.length !== 1 || !['--prepare', '--check-config'].includes(args[0]))
    throw new Error('XHS_PREPARATION_ARGUMENT_INVALID');
  if (args[0] === '--prepare') {
    directory(folder);
    for (const name of ['delivery', 'review', 'test-data', 'logs'])
      directory(path.join(folder, name));
    let configCreated = false;
    if (!fs.existsSync(configFile)) {
      fs.copyFileSync(
        path.join(root, '.env.xhs-self-hosted.example'),
        configFile,
        fs.constants.COPYFILE_EXCL,
      );
      configCreated = true;
    } else if (
      !fs.lstatSync(configFile).isFile() ||
      fs.lstatSync(configFile).isSymbolicLink()
    ) {
      throw new Error('XHS_PREPARATION_PATH_INVALID');
    }
    console.log(
      JSON.stringify({
        mode: 'prepare-only',
        directory: '.xhs-self-hosted',
        configCreated,
        sourceReviewed: false,
        canRefresh: false,
      }),
    );
    return;
  }
  if (!fs.existsSync(configFile))
    throw new Error('XHS_PREPARATION_CONFIG_MISSING');
  // Do not follow a substituted directory or credential-file link.
  const info = fs.lstatSync(folder);
  const fileInfo = fs.lstatSync(configFile);
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    fileInfo.isSymbolicLink() ||
    !fileInfo.isFile()
  )
    throw new Error('XHS_PREPARATION_PATH_INVALID');
  let helpers;
  try {
    helpers = require(
      path.join(
        root,
        'apps/server/dist/apps/server/src/collection/xhs-self-hosted-config.js',
      ),
    );
  } catch {
    throw new Error('SERVER_BUILD_REQUIRED');
  }
  let values;
  try {
    const serverRequire = createRequire(
      path.join(root, 'apps/server/package.json'),
    );
    const parse = createRequire(serverRequire.resolve('@nestjs/config'))(
      'dotenv',
    ).parse;
    values = parse(fs.readFileSync(configFile));
  } catch {
    throw new Error('XHS_PREPARATION_CONFIG_READ_FAILED');
  }
  const summary = helpers.summarizeXhsSelfHostedConfig(
    helpers.parseXhsSelfHostedConfig(values),
  );
  console.log(JSON.stringify({ mode: 'candidate-config-only', ...summary }));
  if (!summary.configured) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(
    codes.has(error.message) ? error.message : 'XHS_PREPARATION_FAILED',
  );
  process.exitCode = 1;
}
