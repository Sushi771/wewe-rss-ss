'use strict';
// Install a built release alongside the current release. Activation is separate.
const fs = require('node:fs');
const path = require('node:path');
const { verifyRelease, inside } = require('./lib.cjs');

function installPair(root, plan) {
  root = fs.realpathSync(root);
  const source = fs.realpathSync(plan.candidate);
  const manifest = verifyRelease(source);
  const target = path.join(root, manifest.id);
  if (path.dirname(target) !== root) throw new Error('Invalid release id');
  fs.mkdirSync(target);
  fs.cpSync(source, target, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: (file) => !fs.lstatSync(file).isSymbolicLink(),
  });
  for (const [name, relative] of Object.entries(manifest.links || {})) {
    const link = path.resolve(target, name);
    const destination = path.resolve(target, relative);
    if (!inside(target, link) || !inside(target, destination))
      throw new Error('Release link escapes its directory');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(destination, link, process.platform === 'win32' ? 'junction' : 'dir');
  }
  verifyRelease(target);
  return { release: target, id: manifest.id, sourceCommit: manifest.sourceCommit };
}
module.exports = { installPair };
if (require.main === module) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: node install-lifecycle.cjs <release-root> <candidate>');
    console.log(JSON.stringify(installPair(process.argv[2], { candidate: process.argv[3] })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
