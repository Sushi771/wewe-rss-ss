// Reproducible local HTML packaging; no server, credential or upstream actions.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const out = path.join(
  repo,
  'output/subscription-implementation/challenge-20261005/paid-prototype-dist',
);
if (!out.startsWith(repo + path.sep)) throw new Error('INVALID_BUILD_TARGET');
const viteBin = path.join(
  path.dirname(
    require.resolve('vite/package.json', {
      paths: [path.join(repo, 'apps/web')],
    }),
  ),
  'bin/vite.js',
);
const result = spawnSync(
  process.execPath,
  [viteBin, 'build', '--config', 'vite.prototype.config.ts'],
  { cwd: path.join(repo, 'apps/web'), stdio: 'inherit' },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
let html = fs.readFileSync(path.join(out, 'paid-prototype.html'), 'utf8');
function asset(relative) {
  const filename = path.resolve(out, relative);
  if (!filename.startsWith(out + path.sep))
    throw new Error('INVALID_ASSET_PATH');
  return fs.readFileSync(filename, 'utf8');
}
html = html.replace(
  /<script\b[^>]*src="([^"]+)"[^>]*><\/script>/g,
  (_tag, src) =>
    `<script type="module">${asset(src).replace(/<\/script/gi, '<\\/script')}</script>`,
);
html = html.replace(
  /<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g,
  (_tag, href) =>
    `<style>${asset(href).replace(/<\/style/gi, '<\\/style')}</style>`,
);
if (/<(?:script|link)\b[^>]*(?:src|href)=/i.test(html))
  throw new Error('UNBUNDLED_ASSET');
html = html.replace(
  '<head>',
  "<head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'\" />",
);
const filename = path.join(
  repo,
  'output/subscription-implementation/challenge-20261005/WeWe-跨端交互原型.html',
);
fs.writeFileSync(filename, html);
const bytes = fs.readFileSync(filename);
fs.writeFileSync(
  path.join(out, 'standalone-manifest.private.json'),
  JSON.stringify(
    {
      filename,
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      isolated: true,
      connectsToBackend: false,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({ filename, bytes: bytes.length, connectsToBackend: false }),
);
