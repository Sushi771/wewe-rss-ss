'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
function loadWechatMaintenance(release, manifest, recordDir) {
  const root = fs.realpathSync.native(release),
    relative = 'server/wechat-gate-checkpoint.cjs',
    file = path.join(root, relative),
    st = fs.lstatSync(file),
    resolved = fs.realpathSync.native(file),
    rel = path.relative(root, resolved);
  if (
    !st.isFile() ||
    st.isSymbolicLink() ||
    rel.startsWith('..') ||
    path.isAbsolute(rel) ||
    manifest.files?.[relative] !==
      crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  )
    throw Error('WECHAT_MAINTENANCE_ENTRY_UNPROVEN');
  const gate = path.join(root, 'project-writer-gate.cjs');
  const digest = (p) =>
    crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const controller = Buffer.from(
    new TextDecoder('utf-8', { fatal: true })
      .decode(fs.readFileSync(path.join(__dirname, 'project-writer-gate.cjs')))
      .replace(/\r\n/g, '\n'),
  );
  if (
    manifest.files?.['project-writer-gate.cjs'] !== digest(gate) ||
    digest(gate) !==
      crypto.createHash('sha256').update(controller).digest('hex')
  )
    throw Error('WECHAT_MAINTENANCE_GATE_UNPROVEN');
  require('./project-writer-gate.cjs');
  const entry = require(file);
  if (typeof entry.recordWechatGate !== 'function')
    throw Error('WECHAT_MAINTENANCE_ENTRY_UNPROVEN');
  return (checkpoint) => entry.recordWechatGate(checkpoint, recordDir);
}
module.exports = { loadWechatMaintenance };
