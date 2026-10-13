// Compile the existing Windows identity checks once, then verify the tiny tool
// before every invocation. No service, OS setting, dependency install or network.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fileHash, readJson, run } = require('./lib.cjs');

function identityTool({
  cacheRoot = path.resolve(__dirname, '../../.local-releases/.identity-tools'),
} = {}) {
  const source = path.join(__dirname, 'process-identity.cs');
  const sourceHash = fileHash(source);
  const folder = path.join(cacheRoot, sourceHash);
  const executable = path.join(folder, 'process-identity.exe');
  const receipt = path.join(folder, 'verified.json');
  if (fs.existsSync(receipt)) {
    const value = readJson(receipt);
    if (
      value.format !== 1 ||
      value.sourceHash !== sourceHash ||
      fileHash(executable) !== value.sha256
    )
      throw new Error('Identity tool integrity mismatch');
    return executable;
  }
  const compiler = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'Microsoft.NET/Framework64/v4.0.30319/csc.exe',
  );
  if (!fs.existsSync(compiler)) return undefined; // Original guarded PS path.
  fs.mkdirSync(cacheRoot, { recursive: true });
  const lock = folder + '.building';
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if (error.code === 'EEXIST') return undefined;
    throw error;
  }
  const temporary = path.join(folder, randomUUID() + '.exe');
  try {
    fs.mkdirSync(folder, { recursive: true });
    run(compiler, [
      '/nologo',
      '/target:exe',
      '/reference:System.Management.dll',
      '/reference:System.Web.Extensions.dll',
      '/out:' + temporary,
      source,
    ]);
    // A raced unverified output must not be adopted as a trusted tool.
    fs.renameSync(temporary, executable);
    const record = { format: 1, sourceHash, sha256: fileHash(executable) };
    const tempReceipt = receipt + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(tempReceipt, JSON.stringify(record), { flag: 'wx' });
      fs.renameSync(tempReceipt, receipt);
    } finally {
      if (fs.existsSync(tempReceipt)) fs.unlinkSync(tempReceipt);
    }
    return executable;
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    fs.rmdirSync(lock);
  }
}
module.exports = { identityTool };
