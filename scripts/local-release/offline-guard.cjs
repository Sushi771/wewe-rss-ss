// 仅隔离演练子进程加载。拒绝 socket/DNS/UDP、fetch 和子进程，不修改系统网络设置。
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const report = process.env.REHEARSAL_GUARD_REPORT;
if (!report) throw new Error('缺少隔离网络审计文件');
const state = { installed: true, blockedNetwork: 0, blockedChildren: 0 };
function save() {
  fs.writeFileSync(report, JSON.stringify(state));
}
function reject(kind) {
  return () => {
    state[kind]++;
    save();
    throw new Error('REHEARSAL_EXTERNAL_OPERATION_BLOCKED');
  };
}
const network = reject('blockedNetwork');
require('node:net').Socket.prototype.connect = network;
require('node:tls').connect = network;
const dns = require('node:dns');
for (const key of Object.keys(dns))
  if (
    key === 'lookup' ||
    key === 'lookupService' ||
    key.startsWith('resolve') ||
    key === 'reverse'
  )
    dns[key] = network;
// Node 的 Server.listen 即使收到数字回环地址也会调用 lookup；直接返回字面地址，不做 DNS。
dns.lookup = (hostname, options, callback) => {
  if (!['127.0.0.1', '::1'].includes(hostname)) return network();
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  const family = hostname === '::1' ? 6 : 4;
  process.nextTick(() =>
    options?.all
      ? callback(null, [{ address: hostname, family }])
      : callback(null, hostname, family),
  );
};
for (const key of Object.keys(dns.promises))
  if (typeof dns.promises[key] === 'function') dns.promises[key] = network;
const udp = require('node:dgram').Socket.prototype;
udp.send = udp.connect = network;
global.fetch = network;
const child = require('node:child_process');
for (const key of [
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork',
])
  child[key] = reject('blockedChildren');
syncBuiltinESMExports();
save();
